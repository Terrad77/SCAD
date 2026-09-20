import type {
  Claim,
  ContradictionAnalysis,
  Evidence,
  EvidenceQuality,
  ResearchGap,
  Uncertainty,
  UncertaintyKind,
} from "../schemas.js"

/**
 * Explicit uncertainty (v0.4).
 *
 * Uncertainty is first-class: instead of being collapsed into "confidence 0"
 * or "low", we say what kind of uncertainty it is and why. Kinds are
 * mutually exclusive and deterministic per subject.
 */

export const UNCERTAINTY_PREFIX = "UNC"

/** Builds a zero-padded deterministic uncertainty id in the SCAD style. */
export function makeUncertaintyId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`
}

export function classifyClaimUncertainty(input: {
  claim: Claim
  supporting: Evidence[]
  contradicting: Evidence[]
  supportQuality: number
}): Uncertainty | undefined {
  const { claim, supporting, contradicting, supportQuality } = input
  const evidenceIds = [...supporting, ...contradicting].map((e) => e.id)

  if (supporting.length === 0 && contradicting.length === 0) {
    return {
      id: makeUncertaintyId(UNCERTAINTY_PREFIX, 1),
      kind: "INSUFFICIENT_EVIDENCE",
      subjectType: "claim",
      subjectId: claim.id,
      detail: `No linked evidence was collected for claim: ${claim.statement}`,
    }
  }
  if (supporting.length > 0 && contradicting.length > 0) {
    return {
      id: makeUncertaintyId(UNCERTAINTY_PREFIX, 1),
      kind: "CONFLICTING_EVIDENCE",
      subjectType: "claim",
      subjectId: claim.id,
      detail: `Supporting and contradicting evidence both exist for claim: ${claim.statement}`,
      evidenceIds,
    }
  }
  if (claim.knowledge === "SPECULATION") {
    return {
      id: makeUncertaintyId(UNCERTAINTY_PREFIX, 1),
      kind: "UNCERTAIN",
      subjectType: "claim",
      subjectId: claim.id,
      detail: `Claim is speculative by knowledge level: ${claim.statement}`,
      evidenceIds,
    }
  }
  if (supporting.length > 0 && supportQuality < 0.5) {
    return {
      id: makeUncertaintyId(UNCERTAINTY_PREFIX, 1),
      kind: "LOW_QUALITY_EVIDENCE",
      subjectType: "claim",
      subjectId: claim.id,
      detail: `Claims' evidence averages low quality (${supportQuality.toFixed(2)}): ${claim.statement}`,
      evidenceIds,
    }
  }
  return undefined
}

export interface UncertaintyCollectionInput {
  claims: Claim[]
  evidence: Evidence[]
  claimAssessments: Array<{ claimId: string; supportStrength: number }>
  contradictionAnalyses: ContradictionAnalysis[]
  researchGaps: ResearchGap[]
  qualityByEvidence: Map<string, EvidenceQuality>
  researchId: string
}

/** All explicit uncertainties across claims and the research as a whole. */
export function collectUncertainties(input: UncertaintyCollectionInput): Uncertainty[] {
  const {
    claims,
    evidence,
    claimAssessments,
    contradictionAnalyses,
    researchGaps,
    qualityByEvidence,
    researchId,
  } = input
  const evidenceById = new Map(evidence.map((e) => [e.id, e]))
  const supportQualityByClaim = new Map(claimAssessments.map((a) => [a.claimId, a.supportStrength]))
  const results: Uncertainty[] = []
  let claimIndex = 0

  for (const claim of claims) {
    const supporting = (claim.evidenceIds ?? [])
      .map((id) => evidenceById.get(id))
      .filter((e): e is Evidence => Boolean(e))
    const contradicting = evidence.filter((e) => e.contradictsClaims.includes(claim.id))
    const supportQuality =
      supportQualityByClaim.get(claim.id) ??
      (supporting.length > 0
        ? supporting.reduce(
            (s, e) => s + (qualityByEvidence.get(e.id)?.overall ?? e.confidence),
            0,
          ) / supporting.length
        : 0)
    const uncertainty = classifyClaimUncertainty({
      claim,
      supporting,
      contradicting,
      supportQuality,
    })
    if (uncertainty) {
      claimIndex += 1
      results.push({ ...uncertainty, id: makeUncertaintyId(UNCERTAINTY_PREFIX, claimIndex) })
    }
  }

  const genuine = contradictionAnalyses.filter((a) => a.analysis === "GENUINE_CONTRADICTION")
  for (const analysis of genuine) {
    claimIndex += 1
    results.push({
      id: makeUncertaintyId(UNCERTAINTY_PREFIX, claimIndex),
      kind: "CONFLICTING_EVIDENCE",
      subjectType: "research",
      subjectId: researchId,
      detail: `Research contains a genuine contradiction between ${analysis.claimA} and ${analysis.claimB}.`,
      evidenceIds: undefined,
    })
  }

  const criticalGaps = researchGaps.filter((g) => g.importance >= 0.8)
  for (const gap of criticalGaps) {
    claimIndex += 1
    results.push({
      id: makeUncertaintyId(UNCERTAINTY_PREFIX, claimIndex),
      kind: "INSUFFICIENT_EVIDENCE",
      subjectType: "research",
      subjectId: researchId,
      detail: `Critical research gap remains open: ${gap.question}.`,
      evidenceIds: undefined,
    })
  }

  return results
}

/** Builds one explicit hypothesis uncertainty (used by verification v2). */
export function hypothesisUncertainty(
  kind: UncertaintyKind,
  hypothesisId: string,
  detail: string,
  index: number,
): Uncertainty {
  return {
    id: makeUncertaintyId(`${UNCERTAINTY_PREFIX}_HYP`, index),
    kind,
    subjectType: "hypothesis",
    subjectId: hypothesisId,
    detail,
  }
}
