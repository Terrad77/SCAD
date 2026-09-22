import type {
  Evidence,
  Hypothesis,
  HypothesisVerification,
  HypothesisVerificationStatus,
  ResearchBundle,
} from "../schemas.js"
import { clamp } from "../evidence/confidence.js"

/**
 * v0.5 — Pure hypothesis verification.
 *
 * The v0.4 `verifyHypotheses` performs its calculations and *mutates* the
 * hypothesis objects in place before returning the verification (a hidden
 * executor). v0.5 needs verification as a pure function: computed results
 * must never leak into persisted state unless an explicit action writes them.
 *
 * The formulas below mirror `src/agents/hypothesis/verify.ts` exactly so a
 * deterministic re-verification of the same evidence chain yields the same
 * verdicts — without touching the version log.
 */

function unique(ids: string[]): string[] {
  return [...new Set(ids)]
}

function evidenceConfidence(ids: string[], evidenceById: Map<string, Evidence>): number {
  const confidences = ids
    .map((id) => evidenceById.get(id)?.confidence)
    .filter((c): c is number => c !== undefined)
  if (confidences.length === 0) return 0
  return confidences.reduce((sum, c) => sum + c, 0) / confidences.length
}

function verifyStatus(
  supporting: string[],
  contradicting: string[],
  supportAvg: number,
): HypothesisVerificationStatus {
  if (supporting.length === 0 && contradicting.length === 0) return "UNTESTED"
  if (contradicting.length > 0 && supporting.length === 0) return "CONTRADICTED"
  if (contradicting.length > 0) return "PARTIALLY_SUPPORTED"
  if (supportAvg >= 0.6) return "SUPPORTED"
  return "INCONCLUSIVE"
}

export interface PureVerificationInput {
  hypotheses: Hypothesis[]
  research?: Pick<ResearchBundle, "claims" | "evidence" | "gaps" | "contradictions">
}

/**
 * Pure per-hypothesis check. Mirrors the v0.4 calculation but returns a fresh
 * verification object and never writes to the hypothesis.
 */
export function verifySingleHypothesis(
  h: Hypothesis,
  research: PureVerificationInput["research"],
): HypothesisVerification {
  const claims = research?.claims ?? []
  const evidence = research?.evidence ?? []
  const gaps = research?.gaps ?? []
  const contradictions = research?.contradictions ?? []

  const claimById = new Map(claims.map((c) => [c.id, c]))
  const evidenceById = new Map(evidence.map((e) => [e.id, e]))

  const supportingEvidence = unique(
    h.supportingClaims
      .flatMap((cid) => claimById.get(cid)?.evidenceIds ?? [])
      .concat(h.supportingEvidence ?? []),
  )
  const contradictingEvidence = unique(
    h.contradictingClaims
      .flatMap((cid) => claimById.get(cid)?.evidenceIds ?? [])
      .concat(h.contradictingEvidence ?? []),
  )
  const researchGaps = unique(
    gaps
      .filter((g) =>
        g.relatedClaims.some(
          (cid) => h.supportingClaims.includes(cid) || h.contradictingClaims.includes(cid),
        ),
      )
      .map((g) => g.id)
      .concat(h.researchGaps ?? []),
  )

  const supportAvg = evidenceConfidence(supportingEvidence, evidenceById)
  const hasEvidence = supportingEvidence.length > 0 || contradictingEvidence.length > 0
  const status = verifyStatus(supportingEvidence, contradictingEvidence, supportAvg)

  let confidence = h.confidence
  if (hasEvidence) {
    const supportWeight =
      supportingEvidence.length + contradictingEvidence.length > 0
        ? supportingEvidence.length / (supportingEvidence.length + contradictingEvidence.length)
        : 0
    const contradictionBias =
      contradictions.filter((c) => c.severity === "HIGH").length > 0 ? 0.1 : 0
    confidence = clamp(0.25 + 0.5 * supportAvg * (0.5 + supportWeight / 2) - contradictionBias)
  }
  confidence = Math.round(confidence * 100) / 100

  const rationale = hasEvidence
    ? `${supportingEvidence.length} supporting evidence, ${contradictingEvidence.length} contradicting evidence, ` +
      `${researchGaps.length} open gaps; average supporting evidence confidence ${supportAvg.toFixed(2)}.`
    : "No evidence bundle available; hypothesis is untested."

  return {
    hypothesisId: h.id,
    status,
    confidence,
    supportingEvidence,
    contradictingEvidence,
    researchGaps,
    rationale,
  }
}

/**
 * Pure batch verification over active hypotheses. No mutation: the returned
 * verifications are the derived truth the intelligence engine is fed.
 */
export function verifyPureHypotheses(input: PureVerificationInput): HypothesisVerification[] {
  return input.hypotheses.map((h) => verifySingleHypothesis(h, input.research))
}
