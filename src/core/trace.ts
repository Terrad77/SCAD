import type {
  Claim,
  Contradiction,
  Evidence,
  HypothesisVerification,
  Narrative,
  ResearchBundle,
  ResearchGap,
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
      verifications: this.verifications.filter((v) => v.hypothesisId === claimId),
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
