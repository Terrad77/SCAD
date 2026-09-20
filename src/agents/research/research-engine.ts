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
import type { ContentProvider } from "../../providers/content/content-provider.js"
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
  content?: string
}

/** A follow-up query selected for a research gap, carrying the gap that spawned it. */
interface FollowUpQuery {
  query: string
  gap: ResearchGap
}

/**
 * Maps a research gap back to a sub-question. The gap's explicit
 * `subquestionId` wins; a text heuristic is the legacy fallback, then the
 * first claim's sub-question, then the plan's first sub-question.
 */
export function resolveSubquestion(
  plan: ResearchBundle["plan"],
  gap: { subquestionId?: string; suggestedResearchQueries: string[]; question: string },
  claims: Claim[],
): string {
  if (gap.subquestionId) {
    const explicit = plan.subQuestions.find((sub) => sub.id === gap.subquestionId)
    if (explicit) return explicit.id
  }
  const gapQuery = gap.suggestedResearchQueries[0] ?? gap.question
  const byText = plan.subQuestions.find((sub) =>
    gapQuery.toLowerCase().includes(sub.text.toLowerCase()),
  )
  if (byText) return byText.id
  for (const claim of claims) {
    if (claim.subquestionIds && claim.subquestionIds.length > 0) return claim.subquestionIds[0]!
  }
  return plan.subQuestions[0]!.id
}

export interface ResearchEngineOptions {
  question: string
  agent: StructuredAgent
  search: SearchProvider
  /** Optional full-content fetcher; snippets are used when absent/offline. */
  content?: ContentProvider
  maxSubQuestions?: number
  maxFollowUpRounds?: number
  followUpLimit?: number
  maxSourcesPerQuery?: number
  /** Global cap on how many sources the registry may collect. */
  maxSources?: number
  /** Per-source content length limit (characters). */
  maxContentBytes?: number
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
  private readonly maxSources: number
  private readonly maxContentBytes: number

  constructor(private readonly options: ResearchEngineOptions) {
    this.logger = options.logger ?? getLogger()
    this.maxSubQuestions = options.maxSubQuestions ?? 10
    this.maxFollowUpRounds = options.maxFollowUpRounds ?? 1
    this.followUpLimit = options.followUpLimit ?? 2
    this.maxSourcesPerQuery = options.maxSourcesPerQuery ?? 8
    this.maxSources = options.maxSources ?? 40
    this.maxContentBytes = options.maxContentBytes ?? 8_000
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
      const results = this.capResults(
        registry,
        dedupeSearchResults(
          await this.options.search.search({ query: query.query, limit: this.maxSourcesPerQuery }),
        ),
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
      for (const followUpQuery of followUpQueries) {
        const query: SearchQuery = {
          id: makeId(QUERY_PREFIX, nextQueryIndex),
          subquestionId: this.resolveSubquestion(plan, followUpQuery.gap, claims),
          query: followUpQuery.query,
        }
        nextQueryIndex += 1
        queries.push(query)
        const results = dedupeSearchResults(
          await this.options.search.search({
            query: followUpQuery.query,
            limit: this.maxSourcesPerQuery,
          }),
        )
        const bundles = await this.buildBundles(
          registry
            .addSearchResults(
              this.capResults(registry, results),
              { queryId: query.id, subquestionId: query.subquestionId },
              sourceAnalyzer,
            )
            .map((s) => ({
              id: s.id,
              title: s.title,
              url: s.url,
              snippet: results.find((r) => r.url === s.url)?.snippet,
              reliability: s.reliability,
            })),
          results,
        )
        if (bundles.length === 0) continue
        followUpEvidence.push(
          ...(await extractFromBundles(this.logger, evidenceExtractor, {
            question: this.options.question,
            subquestion: followUpQuery.query,
            sources: bundles,
            evidenceIdStart: evidence.length + followUpEvidence.length,
          })),
        )
      }
      if (followUpEvidence.length === 0) break
      evidence = mergeUnique(evidence, followUpEvidence)
      const newClaims = await this.extractClaims(claimExtractor, followUpEvidence, claims.length)
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
      summary: this.buildSummary(
        plan.question,
        registry.all(),
        evidence,
        claims,
        contradictions,
        gaps,
      ),
      plan,
      queries,
      sources: registry.all(),
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

  /**
   * Maps a gap back to the sub-question it concerns. The gap's explicit
   * `subquestionId` wins; a text heuristic is kept only as a legacy fallback
   * for gaps produced without one.
   */
  private resolveSubquestion(
    plan: ResearchBundle["plan"],
    gap: ResearchGap,
    claims: Claim[],
  ): string {
    return resolveSubquestion(plan, gap, claims)
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
      const bundles = await this.buildBundles(querySources, results)
      if (bundles.length === 0) continue
      evidence.push(
        ...(await extractFromBundles(this.logger, extractor, {
          question: this.options.question,
          subquestion: query.query,
          sources: bundles,
          evidenceIdStart: evidence.length,
        })),
      )
    }
    return mergeUnique(evidence, [])
  }

  /** Cap results to respect the global per-run source limit. */
  private capResults(registry: SourceRegistry, results: SearchResult[]): SearchResult[] {
    const remaining = Math.max(0, this.maxSources - registry.size)
    return results.slice(0, remaining)
  }

  /** Builds evidence-extraction bundles, enriching them with fetched content. */
  private async buildBundles(
    querySources: Array<Pick<Source, "id" | "title" | "url" | "reliability">>,
    collectedResults: SearchResult[],
  ): Promise<SourceBundle[]> {
    const bundles: SourceBundle[] = []
    for (const source of querySources) {
      const bundle: SourceBundle = {
        id: source.id,
        title: source.title,
        url: source.url,
        snippet: collectedResults.find((r) => r.url === source.url)?.snippet,
        reliability: source.reliability,
      }
      const contentProvider = this.options.content
      if (contentProvider && source.url) {
        try {
          const content = await contentProvider.fetchContent({
            url: source.url,
            maxBytes: this.maxContentBytes,
          })
          if (content.text.length > 0) bundle.content = content.text
        } catch (error) {
          this.logger.warn("content", `content fetch failed for ${source.url}: ${String(error)}`)
        }
      }
      bundles.push(bundle)
    }
    return bundles
  }

  private async extractClaims(
    extractor: ClaimExtractor,
    evidence: Evidence[],
    claimIdStart = 0,
  ): Promise<Claim[]> {
    try {
      return await extractor.run({
        question: this.options.question,
        evidence,
        claimIdStart,
      })
    } catch {
      this.logger.warn("claims", "falling back to deterministic claim derivation from evidence")
      return deriveClaimsFromEvidence(evidence, claimIdStart)
    }
  }

  private selectFollowUpQueries(gaps: ResearchGap[]): FollowUpQuery[] {
    const sorted = [...gaps].sort((a, b) => b.importance - a.importance)
    const queries: FollowUpQuery[] = []
    for (const gap of sorted) {
      for (const q of gap.suggestedResearchQueries) {
        if (queries.length >= this.followUpLimit) return queries
        if (!queries.some((entry) => entry.query === q)) queries.push({ query: q, gap })
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
  input: {
    question: string
    subquestion: string
    sources: SourceBundle[]
    evidenceIdStart?: number
  },
): Promise<Evidence[]> {
  try {
    return await extractor.run(input)
  } catch {
    logger.warn("evidence", `falling back to deterministic evidence for "${input.subquestion}"`)
    return buildFallbackEvidence(input)
  }
}
