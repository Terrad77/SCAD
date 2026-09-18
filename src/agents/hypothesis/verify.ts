import type {
  Evidence,
  Hypothesis,
  HypothesesVerificationOutput,
  HypothesisVerificationStatus,
  ResearchBundle,
} from "../../core/schemas.js"
import { clamp } from "../../core/evidence/confidence.js"
import { getLogger } from "../../core/log.js"

export interface HypothesisVerificationInput {
  hypotheses: Hypothesis[]
  research?: Pick<ResearchBundle, "claims" | "evidence" | "gaps" | "contradictions">
}

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
  h: Hypothesis,
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

/**
 * Deterministic hypothesis verification against the evidence chain.
 *
 * For each hypothesis:
 * - maps supporting/contradicting claims to their underlying evidence,
 * - collects research gaps touching the hypothesis,
 * - derives a verification status and confidence from evidence strength.
 *
 * Verifications are produced even when no evidence bundle is available so the
 * pipeline never hard-blocks; in that case hypotheses stay at UNTESTED and
 * their LLM confidence is preserved.
 */
export function verifyHypotheses(input: HypothesisVerificationInput): HypothesesVerificationOutput {
  const claims = input.research?.claims ?? []
  const evidence = input.research?.evidence ?? []
  const gaps = input.research?.gaps ?? []
  const contradictions = input.research?.contradictions ?? []

  const claimById = new Map(claims.map((c) => [c.id, c]))
  const evidenceById = new Map(evidence.map((e) => [e.id, e]))

  const verifications = input.hypotheses.map((h) => {
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
    const status = verifyStatus(h, supportingEvidence, contradictingEvidence, supportAvg)

    let confidence = h.confidence
    if (hasEvidence) {
      // Evidence weight supports; contradiction weight penalizes.
      const supportWeight =
        supportingEvidence.length + contradictingEvidence.length > 0
          ? supportingEvidence.length / (supportingEvidence.length + contradictingEvidence.length)
          : 0
      const contradictionBias =
        contradictions.filter((c) => c.severity === "HIGH").length > 0 ? 0.1 : 0
      confidence = clamp(0.25 + 0.5 * supportAvg * (0.5 + supportWeight / 2) - contradictionBias)
    }

    h.supportingEvidence = unique([...(h.supportingEvidence ?? []), ...supportingEvidence])
    h.contradictingEvidence = unique([...(h.contradictingEvidence ?? []), ...contradictingEvidence])
    h.researchGaps = unique([...(h.researchGaps ?? []), ...researchGaps])
    h.status = status
    h.confidence = Math.round(confidence * 100) / 100

    const rationale = hasEvidence
      ? `${supportingEvidence.length} supporting evidence, ${contradictingEvidence.length} contradicting evidence, ` +
        `${researchGaps.length} open gaps; average supporting evidence confidence ${supportAvg.toFixed(2)}.`
      : "No evidence bundle available; hypothesis is untested."

    return {
      hypothesisId: h.id,
      status,
      confidence: h.confidence,
      supportingEvidence,
      contradictingEvidence,
      researchGaps,
      rationale,
    }
  })

  getLogger().info("hypotheses", `verified: ${verifications.length}`)
  return { verifications }
}
