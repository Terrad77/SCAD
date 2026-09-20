import type {
  Claim,
  ClaimAssessmentStatus,
  ClaimConfidenceAssessment,
  Contradiction,
  Evidence,
  EvidenceQuality,
  ResearchGap,
  Source,
} from "../schemas.js"
import { clamp, computeAgreement } from "./confidence.js"
import { independentSourcesFor } from "./source-independence.js"
import {
  CLAIM_ASSESSMENT_WEIGHTS,
  CLAIM_COMPLETENESS_PENALTY_CAP,
  CLAIM_GAP_PENALTY,
  CLAIM_MISSING_INDEPENDENCE_PENALTY,
  CONTRADICTION_PENALTY,
  DEFAULT_SOURCE_RELIABILITY,
  PARTIALLY_SUPPORTED_CONFIDENCE,
  STRONGLY_SUPPORTED_CONFIDENCE,
  SUPPORTED_CONFIDENCE,
} from "./weights.js"

/**
 * Claim Confidence 2.0 (v0.4).
 *
 * A claim is no longer judged by a single confidence number. The assessment
 * separates supporting vs contradicting evidence, folds in evidence quality,
 * structural source independence, agreement and research-completeness signals,
 * and explains each component. It is a deterministic heuristic for review —
 * not an objective probability.
 */

export interface ClaimAssessmentInput {
  claim: Claim
  evidenceById: Map<string, Evidence>
  sourceById: Map<string, Source>
  qualityByEvidence: Map<string, EvidenceQuality>
  sources: Source[]
  contradictions: Contradiction[]
  gaps: ResearchGap[]
}

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0
}

function assessStatus(
  evidenceCount: number,
  supportingCount: number,
  contradictingCount: number,
  contested: boolean,
  confidence: number,
): ClaimAssessmentStatus {
  if (evidenceCount === 0) return "INSUFFICIENT_EVIDENCE"
  if (contradictingCount > 0 && supportingCount === 0) return "CONTRADICTED"
  if (contested) return "CONTESTED"
  if (confidence >= STRONGLY_SUPPORTED_CONFIDENCE) return "STRONGLY_SUPPORTED"
  if (confidence >= SUPPORTED_CONFIDENCE) return "SUPPORTED"
  if (confidence >= PARTIALLY_SUPPORTED_CONFIDENCE) return "PARTIALLY_SUPPORTED"
  return "INCONCLUSIVE"
}

/**
 * Deterministic Claim Confidence 2.0 assessment for one claim. All inputs are
 * already-validated domain objects, so the calculation is pure and repeatable.
 */
export function assessClaim(input: ClaimAssessmentInput): ClaimConfidenceAssessment {
  const { claim } = input
  const evidenceIds = claim.evidenceIds ?? []
  const supporting = evidenceIds
    .map((id) => input.evidenceById.get(id))
    .filter((e): e is Evidence => Boolean(e))
  const contradicting = [...input.evidenceById.values()].filter((e) =>
    e.contradictsClaims.includes(claim.id),
  )

  const supportingQuality = supporting.map(
    (e) => input.qualityByEvidence.get(e.id)?.overall ?? e.confidence,
  )
  const supportStrength = mean(supportingQuality)
  const contradictionQuality = contradicting.map(
    (e) => input.qualityByEvidence.get(e.id)?.overall ?? e.confidence,
  )
  const claimContradictions = input.contradictions.filter(
    (c) => c.claimA === claim.id || c.claimB === claim.id,
  )
  const contradictionsBelow = contradicting.length + claimContradictions.length > 0
  const contradictionStrength =
    contradictionQuality.length > 0
      ? mean(contradictionQuality)
      : claimContradictions.length > 0
        ? 0.4
        : 0

  const gapCount = input.gaps.filter((g) => g.relatedClaims.includes(claim.id)).length
  const sourceIds = [...new Set(claim.sources)]
  const independence = independentSourcesFor(
    sourceIds,
    input.sources.filter((s) => sourceIds.includes(s.id)),
  )
  const sourceReliabilities = sourceIds
    .map((id) => input.sourceById.get(id)?.reliability)
    .filter((r): r is number => r !== undefined)
  const sourceReliabilityMean =
    sourceReliabilities.length > 0 ? mean(sourceReliabilities) : DEFAULT_SOURCE_RELIABILITY

  const agreement = computeAgreement(supporting.map((e) => e.confidence))
  const independenceRatio =
    sourceIds.length > 0 ? independence.independentCount / sourceIds.length : 0
  const evidenceCountFactor = Math.min(1, supporting.length / 3)

  const completenessImpact = Math.max(
    -CLAIM_COMPLETENESS_PENALTY_CAP,
    Math.min(
      0,
      -(
        gapCount * CLAIM_GAP_PENALTY +
        (supporting.length > 0 && independence.independentCount === 0
          ? CLAIM_MISSING_INDEPENDENCE_PENALTY
          : 0)
      ),
    ),
  )

  const rawConfidence =
    CLAIM_ASSESSMENT_WEIGHTS.supportStrength * supportStrength +
    CLAIM_ASSESSMENT_WEIGHTS.sourceReliability * sourceReliabilityMean +
    CLAIM_ASSESSMENT_WEIGHTS.agreement * agreement +
    CLAIM_ASSESSMENT_WEIGHTS.independence * independenceRatio +
    CLAIM_ASSESSMENT_WEIGHTS.evidenceCount * evidenceCountFactor -
    CONTRADICTION_PENALTY * contradictionStrength
  const confidence = clamp(rawConfidence + completenessImpact)

  const status = assessStatus(
    evidenceIds.length,
    supporting.length,
    contradicting.length,
    contradictionsBelow,
    confidence,
  )

  const reasons: string[] = [
    `support strength ${supportStrength.toFixed(2)} over ${supporting.length} evidence item${supporting.length === 1 ? "" : "s"}`,
    `contradiction strength ${contradictionStrength.toFixed(2)} (${contradicting.length} direct, ${claimContradictions.length} contradiction record${claimContradictions.length === 1 ? "" : "s"})`,
    `source reliability mean ${sourceReliabilityMean.toFixed(2)}${sourceReliabilities.length === 0 ? " (defaulted, sources unknown to research)" : ""}`,
    `evidence agreement ${agreement.toFixed(2)}`,
    `independence: ${independence.note} (ratio ${independenceRatio.toFixed(2)})`,
    gapCount > 0
      ? `${gapCount} unresolved research gap${gapCount === 1 ? "" : "s"}; completeness impact ${completenessImpact.toFixed(2)}`
      : `no unresolved research gaps; impact ${completenessImpact.toFixed(2)}`,
    `status ${status} at confidence ${confidence.toFixed(2)}`,
  ]

  return {
    claimId: claim.id,
    status,
    confidence,
    supportStrength,
    contradictionStrength,
    independentSourceCount: independence.independentCount,
    evidenceCount: evidenceIds.length,
    sourceCount: sourceIds.length,
    unresolvedGapCount: gapCount,
    completenessImpact,
    reasons,
  }
}

/** Assesses a whole claim set against a research bundle in one call. */
export function assessClaims(input: {
  claims: Claim[]
  evidence: Evidence[]
  sources: Source[]
  qualityByEvidence: Map<string, EvidenceQuality>
  contradictions: Contradiction[]
  gaps: ResearchGap[]
}): ClaimConfidenceAssessment[] {
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]))
  const sourceById = new Map(input.sources.map((s) => [s.id, s]))
  return input.claims.map((claim) =>
    assessClaim({
      claim,
      evidenceById,
      sourceById,
      qualityByEvidence: input.qualityByEvidence,
      sources: input.sources,
      contradictions: input.contradictions,
      gaps: input.gaps,
    }),
  )
}
