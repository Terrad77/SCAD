import type {
  ContradictionAnalysis,
  Evidence,
  EvidenceQuality,
  Hypothesis,
  HypothesesVerificationOutput,
  HypothesisVerification,
  HypothesisVerificationStatus,
  ResearchBundle,
  Source,
  Uncertainty,
  VerificationResult,
} from "../../core/schemas.js"
import { clamp } from "../../core/evidence/confidence.js"
import { independentSourcesFor } from "../../core/evidence/source-independence.js"
import { hypothesisUncertainty } from "../../core/evidence/uncertainty.js"
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

// ---------------------------------------------------------------------------
// v0.4 — Hypothesis Verification 2.0 enrichment
// ---------------------------------------------------------------------------

/** Maps a contradiction analysis to a human alternative explanation string. */
function alternativeExplanation(analysis: ContradictionAnalysis): string | null {
  const alternative: Record<ContradictionAnalysis["analysis"], string | null> = {
    GENUINE_CONTRADICTION:
      "The underlying sources genuinely disagree; further adjudication is required.",
    TIME_CONTEXT: "The apparent conflict may stem from different time periods.",
    POPULATION_CONTEXT: "The apparent conflict may concern different populations.",
    DEFINITION_CONTEXT: "The apparent conflict may stem from different definitions.",
    SCOPE_CONTEXT: "The apparent conflict may be a scope difference (whole vs subset).",
    METHODOLOGY_CONTEXT: "The apparent conflict may stem from different methodologies.",
    MEASUREMENT_CONTEXT:
      "The apparent conflict may stem from different measurements/quoted values.",
    INSUFFICIENT_CONTEXT: "Evidence is too weak to confirm whether the conflict is genuine.",
    UNKNOWN: "The conflict is not yet resolvable with the collected evidence.",
  }
  return alternative[analysis.analysis]
}

export interface VerificationEnrichmentInput {
  verification: HypothesisVerification
  sources: Source[]
  qualityByEvidence: Map<string, EvidenceQuality>
  contradictionsAnalysis: ContradictionAnalysis[]
  /** Zero-based index used to make hypothesis uncertainty ids deterministic. */
  index: number
}

/**
 * Hypothesis Verification 2.0: enriches a base verification with evidence
 * quality, structurally independent source counts, contradiction context,
 * alternative explanations and explicit uncertainty. All deterministic.
 */
export function enrichVerification(input: VerificationEnrichmentInput): VerificationResult {
  const { verification: v, sources, qualityByEvidence, contradictionsAnalysis } = input
  const evidenceIds = [...v.supportingEvidence, ...v.contradictingEvidence]
  const evidenceQuality = evidenceIds
    .map((id) => qualityByEvidence.get(id))
    .filter((q): q is EvidenceQuality => Boolean(q))

  const touchedClaimIds = new Set<string>()
  for (const analysis of contradictionsAnalysis) {
    if (
      v.supportingEvidence.some((id) => id === analysis.contradictionId) ||
      v.contradictingEvidence.some((id) => id === analysis.contradictionId)
    ) {
      touchedClaimIds.add(analysis.claimA)
      touchedClaimIds.add(analysis.claimB)
    }
  }
  const relatedAnalyses = contradictionsAnalysis.filter(
    (a) => touchedClaimIds.has(a.claimA) || touchedClaimIds.has(a.claimB),
  )

  const sourceIds = evidenceIds
    .map((id) => qualityByEvidence.get(id)?.sourceId)
    .filter((id): id is string => Boolean(id))
  const independent = independentSourcesFor([...new Set(sourceIds)], sources)

  const alternativeExplanations: string[] = []
  for (const analysis of relatedAnalyses.slice(0, 3)) {
    const explanation = alternativeExplanation(analysis)
    if (explanation)
      alternativeExplanations.push(`${analysis.claimA}/${analysis.claimB}: ${explanation}`)
  }
  if (
    v.contradictingEvidence.length > 0 &&
    v.status !== "CONTRADICTED" &&
    alternativeExplanations.length === 0
  ) {
    alternativeExplanations.push(
      "Supporting and contradicting evidence coexist; the conflict is not yet resolvable from the collected data.",
    )
  }
  if (v.status === "INCONCLUSIVE" && alternativeExplanations.length === 0) {
    alternativeExplanations.push(
      "Evidence quality or coverage is insufficient to resolve the hypothesis.",
    )
  }

  const uncertainties: Uncertainty[] = []
  if (v.status === "CONTRADICTED") {
    uncertainties.push(
      hypothesisUncertainty(
        "CONFLICTING_EVIDENCE",
        v.hypothesisId,
        "Contradicting evidence outweighs supporting evidence.",
        1 + input.index,
      ),
    )
  } else if (v.status === "UNTESTED") {
    uncertainties.push(
      hypothesisUncertainty(
        "INSUFFICIENT_EVIDENCE",
        v.hypothesisId,
        "No evidence bundle was available to test the hypothesis.",
        1 + input.index,
      ),
    )
  } else if (v.status === "INCONCLUSIVE") {
    uncertainties.push(
      hypothesisUncertainty(
        v.researchGaps.length > 0 ? "INSUFFICIENT_EVIDENCE" : "UNCERTAIN",
        v.hypothesisId,
        "The collected evidence does not decisively support or reject the hypothesis.",
        1 + input.index,
      ),
    )
  } else if (v.supportingEvidence.length > 0 && v.contradictingEvidence.length > 0) {
    uncertainties.push(
      hypothesisUncertainty(
        "CONFLICTING_EVIDENCE",
        v.hypothesisId,
        "Evidence both supports and contradicts the hypothesis.",
        1 + input.index,
      ),
    )
  }

  return {
    ...v,
    evidenceQuality,
    alternativeExplanations,
    independentSourceCount: independent.independentCount,
    contradictions: relatedAnalyses,
    uncertainties,
  }
}
