import type { Claim, Evidence, ResearchBundle } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import { SourceRegistry } from "../../core/sources/source-registry.js"
import { SourceAnalyzer } from "../research/source-analyzer.js"
import { EvidenceExtractor, buildFallbackEvidence } from "../research/evidence-extractor.js"
import { ClaimExtractor, deriveClaimsFromEvidence } from "../research/claim-extractor.js"
import {
  crossLinkContradictions,
  linkEvidence,
  resolveSubquestion,
} from "../research/research-engine.js"
import { detectContradictions } from "../research/contradiction-detector.js"
import { detectResearchGaps } from "../research/gap-detector.js"
import { QUERY_PREFIX, makeId } from "../research/ids.js"
import { dedupeSearchResults } from "../../providers/search/normalize.js"
import type { SearchProvider } from "../../providers/search/search-provider.js"
import type { ResearchTarget } from "../../core/reasoning/types.js"
import { getLogger } from "../../core/log.js"

export interface FollowUpOptions {
  bundle: ResearchBundle
  target: ResearchTarget
  search: SearchProvider
  agent: StructuredAgent
  /** Cap on search results per follow-up query (defaults to 8). */
  maxSourcesPerQuery?: number
  /** Hard cap on collected sources (defaults to 40, mirroring the research engine). */
  maxSources?: number
}

export interface FollowUpResult {
  bundle: ResearchBundle
  performed: boolean
  notes: string[]
}

function mergeUnique<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return [...byId.values()]
}

/**
 * Executes a RESEARCH action: gathers new sources and evidence for the
 * targeted gap / sub-question / evidence quality problem, then rebuilds the
 * whole bundle deterministically (re-linking, re-detecting contradictions and
 * gaps). LLM extractors degrade to their fallbacks exactly like the research
 * engine does, so the offline path stays fully reproducible.
 */
export async function runFollowUpResearch(input: FollowUpOptions): Promise<FollowUpResult> {
  const bundle = structuredClone(input.bundle)
  const maxSourcesPerQuery = input.maxSourcesPerQuery ?? 8
  const maxSources = input.maxSources ?? 40
  const target = input.target

  const query = target.query.trim()
  if (query.length === 0) {
    return {
      bundle,
      performed: false,
      notes: [`no query derived from target ${target.subject}:${target.id}`],
    }
  }

  const results = dedupeSearchResults(
    await input.search.search({ query, limit: maxSourcesPerQuery }),
  )

  const remaining = Math.max(0, maxSources - bundle.sources.length)
  const capped = results.slice(0, remaining)
  if (capped.length === 0) {
    return {
      bundle,
      performed: false,
      notes: [
        `search "${query}" returned no (new) sources; source cap ${maxSources} may be reached`,
      ],
    }
  }

  const registry = new SourceRegistry(bundle.sources)
  const queryIndex = bundle.queries.length + 1
  const queryId = makeId(QUERY_PREFIX, queryIndex)
  const subquestionId =
    target.subject === "subquestion"
      ? target.id
      : resolveSubquestion(
          bundle.plan,
          { subquestionId: undefined, suggestedResearchQueries: [query], question: query },
          bundle.claims,
        )

  const added = registry.addSearchResults(capped, { queryId, subquestionId }, new SourceAnalyzer())
  if (added.length === 0) {
    return {
      bundle,
      performed: false,
      notes: [`search "${query}" added no new sources (all duplicates of existing material)`],
    }
  }

  const sources = registry.all()
  const newEvidence = await extractEvidence(input.agent, input, added, results)
  if (newEvidence.length === 0) {
    return {
      bundle,
      performed: false,
      notes: [`search "${query}" added ${added.length} sources but no usable evidence`],
    }
  }
  const newClaims = await extractClaims(input.agent, newEvidence, bundle.claims.length)

  const evidence = mergeUnique(bundle.evidence, newEvidence)
  const claims = mergeUnique(bundle.claims, newClaims)
  linkEvidence(evidence, claims, sources)
  const contradictions = detectContradictions(claims)
  crossLinkContradictions(contradictions, evidence, claims)
  const gaps = detectResearchGaps({
    plan: bundle.plan,
    claims,
    evidence,
    contradictions,
  })

  const next = {
    ...bundle,
    queries: [...bundle.queries, { id: queryId, subquestionId, query }],
    sources,
    evidence,
    claims,
    contradictions,
    gaps,
    followUpRoundsUsed: (bundle.followUpRoundsUsed ?? 0) + 1,
  }
  getLogger().info(
    "reasoning",
    `follow-up research added ${added.length} sources, ${newEvidence.length} evidence, ${newClaims.length} claims (${query})`,
  )
  return {
    bundle: next,
    performed: true,
    notes: [
      `added ${added.length} sources, ${newEvidence.length} evidence, ${newClaims.length} claims for query "${query}"`,
    ],
  }
}

async function extractEvidence(
  agent: StructuredAgent,
  input: FollowUpOptions,
  added: Array<{ id: string; title: string; url?: string; reliability?: number }>,
  results: Awaited<ReturnType<SearchProvider["search"]>>,
): Promise<Evidence[]> {
  const sources = added.map((s) => ({
    id: s.id,
    title: s.title,
    url: s.url,
    snippet: results.find((r) => r.url === s.url)?.snippet,
    reliability: s.reliability,
  }))
  const extractor = new EvidenceExtractor(agent)
  try {
    return await extractor.run({
      question: input.bundle.question,
      subquestion: input.target.query,
      sources,
      evidenceIdStart: input.bundle.evidence.length,
    })
  } catch {
    getLogger().warn("reasoning", `evidence extraction fell back to deterministic builder`)
    return buildFallbackEvidence({
      question: input.bundle.question,
      subquestion: input.target.query,
      sources,
      evidenceIdStart: input.bundle.evidence.length,
    })
  }
}

async function extractClaims(
  agent: StructuredAgent,
  evidence: Evidence[],
  claimIdStart: number,
): Promise<Claim[]> {
  if (evidence.length === 0) return []
  const extractor = new ClaimExtractor(agent)
  try {
    return await extractor.run({
      question: evidence[0]?.statement ?? "follow-up research",
      evidence,
      claimIdStart,
    })
  } catch {
    getLogger().warn("reasoning", `claim extraction fell back to deterministic derivation`)
    return deriveClaimsFromEvidence(evidence, claimIdStart)
  }
}
