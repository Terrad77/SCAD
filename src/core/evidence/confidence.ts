/**
 * Deterministic confidence calculation for evidence and claims.
 *
 * Confidence must not depend exclusively on an LLM guessing a number. These
 * pure functions combine structurally derived factors so the result is
 * explainable and testable:
 *
 *   evidence confidence = source reliability + evidence strength
 *   claim confidence    = source agreement + source quality + evidence strength
 */

export interface EvidenceConfidenceFactors {
  /** Reliability of the backing source (0..1). */
  sourceReliability: number
  /** How directly the statement asserts the fact (1 = direct, 0 = purely contextual). */
  directness?: number
  /** How specific/precise the statement is (1 = very specific). */
  specificity?: number
}

/** Weighted combination of source quality and evidence strength. */
export function computeEvidenceConfidence(factors: EvidenceConfidenceFactors): number {
  const reliability = clamp(factors.sourceReliability)
  const directness = clamp(factors.directness ?? 0.8)
  const specificity = clamp(factors.specificity ?? 0.8)
  return clamp(0.5 * reliability + 0.3 * directness + 0.2 * specificity)
}

/** Agreement ratio between multiple supporting pieces of evidence. */
export function computeAgreement(confidences: number[]): number {
  if (confidences.length === 0) return 0
  const mean = confidences.reduce((sum, c) => sum + clamp(c), 0) / confidences.length
  if (confidences.length === 1) return 0.5
  const variance =
    confidences.reduce((sum, c) => sum + (clamp(c) - mean) ** 2, 0) / confidences.length
  return clamp(1 - Math.sqrt(variance))
}

export interface ClaimConfidenceFactors {
  /** Confidences of the evidence supporting the claim. */
  evidenceConfidences: number[]
  /** Reliability of the sources referenced by the claim. */
  sourceReliabilities: number[]
  /** Agreement between independent evidence (0..1). */
  agreement?: number
}

/**
 * Claim confidence from source agreement, source quality and evidence strength.
 * Multi-source claims get a small independence bonus for corroboration.
 */
export function computeClaimConfidence(factors: ClaimConfidenceFactors): number {
  const evidenceConfidences = (factors.evidenceConfidences ?? []).map(clamp)
  const reliabilities = (factors.sourceReliabilities ?? []).map(clamp)
  const evidenceMean = evidenceConfidences.length
    ? evidenceConfidences.reduce((s, c) => s + c, 0) / evidenceConfidences.length
    : 0
  const sourceMean = reliabilities.length
    ? reliabilities.reduce((s, r) => s + r, 0) / reliabilities.length
    : 0
  const agreement = factors.agreement ?? computeAgreement(evidenceConfidences)

  const independentSources = Math.max(0, new Set(reliabilities).size - 1)
  const independenceBonus = Math.min(0.08, 0.04 * independentSources)

  return clamp(0.55 * evidenceMean + 0.2 * sourceMean + 0.25 * agreement + independenceBonus)
}

export function clamp(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(1, value))
}
