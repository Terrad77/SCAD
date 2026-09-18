import type {
  Evidence,
  Claim,
  ResearchBundle,
  ResearchGap,
  SearchQuery,
  Source,
  Contradiction,
  ResearchSubQuestion,
} from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import type { SearchProvider, SearchResult } from "../../providers/search/search-provider.js"
import { dedupeSearchResults } from "../../providers/search/normalize.js"
import { SourceRegistry } from "../../core/sources/source-registry.js"
import { getLogger, type Logger } from "../../core/log.js"
import { ResearchPlanner } from "./research-planner.js"
import { SourceAnalyzer } from "./source-analyzer.js"
import { EvidenceExtractor, buildFallbackEvidence } from "./evidence-extractor.js"
import { ClaimExtractor, deriveClaimsFromEvidence } from "./claim-extractor.js"
import { detectContradictions } from "./contradiction-detector.js"
import { detectResearchGaps } from "./gap-detector.js"
import { QUERY_PREFIX, makeId } from "./ids.js"

interface SourceBundle {
  id: string
  title: string
  url?: string
  snippet?: string
  reliability?: number
}

export interface ResearchEngineOptions {
  question: string
  agent: StructuredAgent
  search: SearchProvider
  maxSubQuestions?: number
  maxFollowUpRounds?: number
  followUpLimit?: number
  maxSourcesPerQuery?: number
  logger?: Logger
}

/**
 * Orchestrates the Evidence & Research Engine workflow:
 *
 *   Question → Plan → Search → Sources → Evidence → Claims → Contradictions →
 *   Gaps → Additional Research → Updated Claims → Research Bundle.
 *
 * LLM stages degrade gracefully to deterministic fallbacks so the engine works
 * offline (mock provider / no canned response).
 */
export class ResearchEngine {
  private readonly logger: Logger
  private readonly maxSubQuestions: number
  private readonly maxFollowUpRounds: number
  private readonly followUpLimit: number
  private readonly maxSourcesPerQuery: number

  constructor(private readonly options: ResearchEngineOptions) {
    this.logger = options.logger ?? getLogger()
    this.maxSubQuestions = options.maxSubQuestions ?? 10
    this.maxFollowUpRounds = options.maxFollowUpRounds ?? 1
    this.followUpLimit = options.followUpLimit ?? 2
    this.maxSourcesPerQuery = options.maxSourcesPerQuery ?? 8
  }

  async run(): Promise<ResearchBundle> {
    const planner = new ResearchPlanner(this.options.agent)
    const sourceAnalyzer = new SourceAnalyzer()
    const evidenceExtractor = new EvidenceExtractor(this.options.agent)
    const claimExtractor = new ClaimExtractor(this.options.agent)

    this.logger.info("research", "planning queries")
    const plan = await planner.plan({
      question: this.options.question,
      maxSubQuestions: this.maxSubQuestions,
    })
    const queries = this.buildQueries(plan.subQuestions)

    this.logger.info("research", `executing queries (${queries.length})`)
    const registry = new SourceRegistry()
    const collected = new Map<string, SearchResult[]>()
    for (let i = 0; i < queries.length; i += 1) {
      const query = queries[i]!
      this.logger.info("research", `executing query ${i + 1}/${queries.length}: ${query.query}`)
      const results = dedupeSearchResults(
        await this.options.search.search({ query: query.query, limit: this.maxSourcesPerQuery }),
      )
      collected.set(query.id, results)
      registry.addSearchResults(
        results,
        { queryId: query.id, subquestionId: query.subquestionId },
        sourceAnalyzer,
      )
    }
    const sources = registry.all()
    this.logger.info("research", `sources collected: ${sources.length}`)

    let evidence = await this.collectEvidence(sources, queries, collected, evidenceExtractor)
    this.logger.info("evidence", `extracted: ${evidence.length}`)

    let claims = await this.extractClaims(claimExtractor, evidence)
    this.logger.info("claims", `generated: ${claims.length}`)

    linkEvidence(evidence, claims, sources)
    let contradictions = detectContradictions(claims)
    this.logger.info("contradictions", `detected: ${contradictions.length}`)
    crossLinkContradictions(contradictions, evidence, claims)

    let gaps = detectResearchGaps({ plan, claims, evidence, contradictions })
    this.logger.info("gaps", `detected: ${gaps.length}`)

    let nextQueryIndex = queries.length + 1
    for (let round = 0; round < this.maxFollowUpRounds; round += 1) {
      const followUpQueries = this.selectFollowUpQueries(gaps)
      if (followUpQueries.length === 0) break
      this.logger.info("research", `follow-up queries: ${followUpQueries.length}`)
      const followUpEvidence: Evidence[] = []
      for (const gapQuery of followUpQueries) {
        const query: SearchQuery = {
          id: makeId(QUERY_PREFIX, nextQueryIndex),
          subquestionId: this.resolveSubquestion(plan, gapQuery, claims),
          query: gapQuery,
        }
        nextQueryIndex += 1
        queries.push(query)
        const results = dedupeSearchResults(
          await this.options.search.search({ query: gapQuery, limit: this.maxSourcesPerQuery }),
        )
        const bundles = registry
          .addSearchResults(
            results,
            { queryId: query.id, subquestionId: query.subquestionId },
            sourceAnalyzer,
          )
          .map((s) => ({
            id: s.id,
            title: s.title,
            url: s.url,
            snippet: results.find((r) => r.url === s.url)?.snippet,
            reliability: s.reliability,
          }))
        if (bundles.length === 0) continue
        followUpEvidence.push(
          ...(await extractFromBundles(this.logger, evidenceExtractor, {
            question: this.options.question,
            subquestion: gapQuery,
            sources: bundles,
          })),
        )
      }
      if (followUpEvidence.length === 0) break
      evidence = mergeUnique(evidence, followUpEvidence)
      const newClaims = await this.extractClaims(claimExtractor, followUpEvidence)
      claims = mergeUnique(claims, newClaims)
      linkEvidence(evidence, claims, registry.all())
      contradictions = detectContradictions(claims)
      crossLinkContradictions(contradictions, evidence, claims)
      gaps = detectResearchGaps({ plan, claims, evidence, contradictions })
      this.logger.info("research", `sources collected: ${registry.size}`)
      this.logger.info("evidence", `extracted: ${evidence.length}`)
      this.logger.info("claims", `generated: ${claims.length}`)
    }

    return {
      question: this.options.question,
      summary: this.buildSummary(plan.question, sources, evidence, claims, contradictions, gaps),
      plan,
      queries,
      sources,
      evidence,
      claims,
      contradictions,
      gaps,
    }
  }

  private buildQueries(subQuestions: ResearchSubQuestion[]): SearchQuery[] {
    return subQuestions.map((sub) => ({
      id: makeId(QUERY_PREFIX, subQuestions.indexOf(sub) + 1),
      subquestionId: sub.id,
      query: sub.text,
    }))
  }

  /** Maps a follow-up query back to an existing sub-question where possible. */
  private resolveSubquestion(
    plan: ResearchBundle["plan"],
    gapQuery: string,
    claims: Claim[],
  ): string {
    const gap = plan.subQuestions.find((sub) =>
      gapQuery.toLowerCase().includes(sub.text.toLowerCase()),
    )
    if (gap) return gap.id
    for (const claim of claims) {
      if (claim.subquestionIds && claim.subquestionIds.length > 0) return claim.subquestionIds[0]!
    }
    return plan.subQuestions[0]!.id
  }

  private async collectEvidence(
    sources: Source[],
    queries: SearchQuery[],
    collected: Map<string, SearchResult[]>,
    extractor: EvidenceExtractor,
  ): Promise<Evidence[]> {
    const evidence: Evidence[] = []
    for (const query of queries) {
      const results = collected.get(query.id) ?? []
      const querySources = sources.filter((s) => s.queryId === query.id)
      const bundles = querySources.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        snippet: results.find((r) => r.url === s.url)?.snippet,
        reliability: s.reliability,
      }))
      if (bundles.length === 0) continue
      evidence.push(
        ...(await extractFromBundles(this.logger, extractor, {
          question: this.options.question,
          subquestion: query.query,
          sources: bundles,
        })),
      )
    }
    return mergeUnique(evidence, [])
  }

  private async extractClaims(extractor: ClaimExtractor, evidence: Evidence[]): Promise<Claim[]> {
    try {
      return await extractor.run({ question: this.options.question, evidence })
    } catch {
      this.logger.warn("claims", "falling back to deterministic claim derivation from evidence")
      return deriveClaimsFromEvidence(evidence)
    }
  }

  private selectFollowUpQueries(gaps: ResearchGap[]): string[] {
    const sorted = [...gaps].sort((a, b) => b.importance - a.importance)
    const queries: string[] = []
    for (const gap of sorted) {
      for (const q of gap.suggestedResearchQueries) {
        if (queries.length >= this.followUpLimit) return queries
        if (!queries.includes(q)) queries.push(q)
      }
    }
    return queries
  }

  private buildSummary(
    question: string,
    sources: Source[],
    evidence: Evidence[],
    claims: Claim[],
    contradictions: Contradiction[],
    gaps: ResearchGap[],
  ): string {
    return (
      `Research for "${question}". ` +
      `${sources.length} sources, ${evidence.length} pieces of evidence, ${claims.length} claims, ` +
      `${contradictions.length} contradictions and ${gaps.length} research gaps identified.`
    )
  }
}

/** Populates evidence.supportsClaims and claim subquestions from claim.evidenceIds. */
export function linkEvidence(evidence: Evidence[], claims: Claim[], sources: Source[]): void {
  const evidenceById = new Map(evidence.map((e) => [e.id, e]))
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  for (const claim of claims) {
    const subIds = new Set<string>()
    for (const evId of claim.evidenceIds ?? []) {
      const ev = evidenceById.get(evId)
      if (!ev) continue
      if (!ev.supportsClaims.includes(claim.id)) ev.supportsClaims.push(claim.id)
      if (!claim.sources.includes(ev.sourceId)) claim.sources.push(ev.sourceId)
      const source = sourceById.get(ev.sourceId)
      if (source?.subquestionId) subIds.add(source.subquestionId)
    }
    if (subIds.size > 0) claim.subquestionIds = [...subIds]
  }
}

/** Marks evidence as contradicting the opposing claim for each contradiction. */
export function crossLinkContradictions(
  contradictions: Contradiction[],
  evidence: Evidence[],
  claims: Claim[],
): void {
  const evidenceById = new Map(evidence.map((e) => [e.id, e]))
  const evidenceForClaim = new Map<string, Evidence[]>()
  for (const claim of claims) {
    evidenceForClaim.set(
      claim.id,
      (claim.evidenceIds ?? [])
        .map((id) => evidenceById.get(id))
        .filter((e): e is Evidence => Boolean(e)),
    )
  }
  for (const c of contradictions) {
    for (const evidenceA of evidenceForClaim.get(c.claimA) ?? []) {
      if (!evidenceA.contradictsClaims.includes(c.claimB))
        evidenceA.contradictsClaims.push(c.claimB)
    }
    for (const evidenceB of evidenceForClaim.get(c.claimB) ?? []) {
      if (!evidenceB.contradictsClaims.includes(c.claimA))
        evidenceB.contradictsClaims.push(c.claimA)
    }
  }
}

function mergeUnique<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return [...byId.values()]
}

/**
 * Extracts evidence for a set of source bundles, degrading to the
 * deterministic fallback when the LLM stage fails or is unavailable.
 */
async function extractFromBundles(
  logger: Logger,
  extractor: EvidenceExtractor,
  input: { question: string; subquestion: string; sources: SourceBundle[] },
): Promise<Evidence[]> {
  try {
    return await extractor.run(input)
  } catch {
    logger.warn("evidence", `falling back to deterministic evidence for "${input.subquestion}"`)
    return buildFallbackEvidence(input)
  }
}
