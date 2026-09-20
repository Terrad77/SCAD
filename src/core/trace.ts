import type {
  Claim,
  Contradiction,
  Evidence,
  HypothesisVerification,
  Narrative,
  ResearchBundle,
  ResearchGap,
  ResearchSubQuestion,
  SearchQuery,
  Shot,
  Source,
} from "./schemas.js"
import { buildTraceabilityReport, type TraceabilityReport } from "./traceability.js"

export interface ClaimTrace {
  claim: Claim
  evidence: Evidence[]
  sources: Source[]
  contradictions: Contradiction[]
  gaps: ResearchGap[]
  verifications: HypothesisVerification[]
}

export interface SourceTrace {
  source: Source
  query?: SearchQuery
  subQuestion?: ResearchSubQuestion
  evidence: Evidence[]
  claims: Claim[]
}

export interface EvidenceTrace {
  evidence: Evidence
  source?: Source
  supportsClaims: Claim[]
  contradictsClaims: Claim[]
}

export interface QueryTrace {
  query: SearchQuery
  subQuestion?: ResearchSubQuestion
  sources: Source[]
  evidence: Evidence[]
}

/**
 * Traceability over the whole Evidence & Research Engine bundle. Every claim
 * can be traced back through evidence to its sources, and forward to the
 * contradictions, gaps and verifications that concern it.
 */
export class TraceService {
  constructor(
    private readonly research: ResearchBundle,
    private readonly verifications: HypothesisVerification[] = [],
  ) {}

  traceClaim(claimId: string): ClaimTrace | undefined {
    const claim = this.research.claims.find((c) => c.id === claimId)
    if (!claim) return undefined
    const evidence = this.research.evidence.filter(
      (e) => claim.evidenceIds?.includes(e.id) ?? false,
    )
    const sources = evidence
      .map((e) => this.research.sources.find((s) => s.id === e.sourceId))
      .filter((s): s is Source => Boolean(s))
    const sourceIds = new Set(sources.map((s) => s.id))
    for (const sid of claim.sources) {
      const s = this.research.sources.find((src) => src.id === sid)
      if (s && !sourceIds.has(sid)) sources.push(s)
    }
    return {
      claim,
      evidence,
      sources,
      contradictions: this.research.contradictions.filter(
        (c) => c.claimA === claimId || c.claimB === claimId,
      ),
      gaps: this.research.gaps.filter((g) => g.relatedClaims.includes(claimId)),
      verifications: this.verifications.filter((v) => verificationConcernsClaim(v, claim)),
    }
  }

  traceHypothesis(hypothesisId: string): {
    supportingClaims: Claim[]
    supportingEvidence: Evidence[]
    contradictingEvidence: Evidence[]
    researchGaps: ResearchGap[]
    sources: Source[]
    verification?: HypothesisVerification
  } {
    const verification = this.verifications.find((v) => v.hypothesisId === hypothesisId)
    if (!verification) {
      return {
        supportingClaims: [],
        supportingEvidence: [],
        contradictingEvidence: [],
        researchGaps: [],
        sources: [],
      }
    }
    const supportingEvidence = this.research.evidence.filter((e) =>
      verification.supportingEvidence.includes(e.id),
    )
    const contradictingEvidence = this.research.evidence.filter((e) =>
      verification.contradictingEvidence.includes(e.id),
    )
    const claimIds = new Set<string>()
    const supportingClaims: Claim[] = []
    for (const ev of supportingEvidence) {
      for (const cid of ev.supportsClaims) {
        if (claimIds.has(cid)) continue
        claimIds.add(cid)
        const claim = this.research.claims.find((c) => c.id === cid)
        if (claim) supportingClaims.push(claim)
      }
    }
    const sources = supportingEvidence
      .concat(contradictingEvidence)
      .map((e) => this.research.sources.find((s) => s.id === e.sourceId))
      .filter((s): s is Source => Boolean(s))
    return {
      supportingClaims,
      supportingEvidence,
      contradictingEvidence,
      researchGaps: this.research.gaps.filter((g) => verification.researchGaps.includes(g.id)),
      sources,
      verification,
    }
  }

  /** Traces the full chain behind a research query: query → sources → evidence. */
  traceQuery(queryId: string): QueryTrace | undefined {
    const query = this.research.queries.find((q) => q.id === queryId)
    if (!query) return undefined
    const subQuestion = this.research.plan.subQuestions.find((s) => s.id === query.subquestionId)
    const sources = this.research.sources.filter((s) => s.queryId === query.id)
    const sourceIds = new Set(sources.map((s) => s.id))
    const evidence = this.research.evidence.filter((e) => sourceIds.has(e.sourceId))
    return { query, subQuestion, sources, evidence }
  }

  /** Traces a source back to its query and forward to evidence and claims. */
  traceSource(sourceId: string): SourceTrace | undefined {
    const source = this.research.sources.find((s) => s.id === sourceId)
    if (!source) return undefined
    const query = this.research.queries.find((q) => q.id === source.queryId)
    const subQuestion = query
      ? this.research.plan.subQuestions.find((s) => s.id === query.subquestionId)
      : undefined
    const evidence = this.research.evidence.filter((e) => e.sourceId === source.id)
    const claimIds = new Set(evidence.flatMap((e) => [...e.supportsClaims, ...e.contradictsClaims]))
    const claims = this.research.claims.filter((c) => claimIds.has(c.id))
    return { source, query, subQuestion, evidence, claims }
  }

  /** Traces evidence back to its source and forward to the claims it touches. */
  traceEvidence(evidenceId: string): EvidenceTrace | undefined {
    const evidence = this.research.evidence.find((e) => e.id === evidenceId)
    if (!evidence) return undefined
    const source = this.research.sources.find((s) => s.id === evidence.sourceId)
    const supportsClaims = this.research.claims.filter((c) =>
      (c.evidenceIds ?? []).includes(evidence.id),
    )
    const contradictsClaims = this.research.claims.filter((c) =>
      evidence.contradictsClaims.includes(c.id),
    )
    return { evidence, source, supportsClaims, contradictsClaims }
  }

  /** Full Shot → Sentence → Claim → Evidence → Source report with extras. */
  report(narrative: Narrative, shots: Shot[]): TraceabilityReport {
    return buildTraceabilityReport(shots, narrative, this.research.claims, this.research, {
      evidence: this.research.evidence,
      contradictions: this.research.contradictions,
      gaps: this.research.gaps,
      verifications: this.verifications,
    })
  }
}

/**
 * A verification concerns a claim when the claim is the hypothesis it tests,
 * or when they share supporting/contradicting evidence (the generic mapping
 * used when a hypothesis is not itself a claim).
 */
function verificationConcernsClaim(v: HypothesisVerification, claim: Claim): boolean {
  if (v.hypothesisId === claim.id) return true
  const claimEvidence = new Set(claim.evidenceIds ?? [])
  return (
    v.supportingEvidence.some((eid) => claimEvidence.has(eid)) ||
    v.contradictingEvidence.some((eid) => claimEvidence.has(eid))
  )
}
