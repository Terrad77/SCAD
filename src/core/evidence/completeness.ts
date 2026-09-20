import type {
  Claim,
  ClaimConfidenceAssessment,
  CompletenessDimension,
  Contradiction,
  ContradictionAnalysis,
  Evidence,
  EvidenceQuality,
  ResearchCompleteness,
  ResearchGap,
  ResearchPlan,
  Source,
  SourceIndependenceResult,
  StoppingCriteriaResult,
  Uncertainty,
} from "../schemas.js"
import { clamp } from "./confidence.js"
import {
  COMPLETENESS_THRESHOLDS,
  COMPLETENESS_WEIGHTS,
  CRITICAL_GAP_IMPORTANCE,
  PRIMARY_SOURCE_TYPES,
} from "./weights.js"

/**
 * Research Completeness + stopping criteria (v0.4).
 *
 * Answers "how fully is this question answered?" dimension by dimension, each
 * with explicit covered/total counts so missing data is visible rather than
 * silently zero. The stopping criteria then answer "should we keep
 * researching?" deterministically, while always respecting resource limits.
 */

export interface ResearchCompletenessInput {
  plan: ResearchPlan
  claims: Claim[]
  evidence: Evidence[]
  sources: Source[]
  gaps: ResearchGap[]
  contradictions: Contradiction[]
  contradictionsAnalysis: ContradictionAnalysis[]
  claimAssessments: ClaimConfidenceAssessment[]
  independence: SourceIndependenceResult
  qualityByEvidence: Map<string, EvidenceQuality>
}

const UNRESOLVED_ANALYSES = new Set(["GENUINE_CONTRADICTION", "INSUFFICIENT_CONTEXT", "UNKNOWN"])

function ratio(covered: number, total: number): number {
  if (total <= 0) return 0
  return covered / total
}

/** Builds a single dimension with an explicit covered/total explanation. */
function dimension(
  id: string,
  label: string,
  covered: number,
  total: number,
  reason: string,
): CompletenessDimension {
  return { id, label, score: ratio(covered, total), covered, total, reason }
}

/** Computes the full deterministc completeness profile of a bundle. */
export function computeResearchCompleteness(
  input: ResearchCompletenessInput,
): ResearchCompleteness {
  const {
    plan,
    claims,
    evidence,
    sources,
    gaps,
    contradictions,
    contradictionsAnalysis,
    claimAssessments,
    independence,
    qualityByEvidence,
  } = input

  const sourceById = new Map(sources.map((s) => [s.id, s]))

  // Sub-questions actually backed by linked claims/evidence.
  const coveredSubs = new Set<string>()
  for (const claim of claims) {
    for (const subId of claim.subquestionIds ?? []) coveredSubs.add(subId)
  }
  for (const ev of evidence) {
    for (const claimId of ev.supportsClaims) {
      const claim = claims.find((c) => c.id === claimId)
      for (const subId of claim?.subquestionIds ?? []) coveredSubs.add(subId)
    }
  }

  const evidenceCovered = evidence.filter((e) => e.supportsClaims.length > 0).length
  const claimsCovered = claims.filter(
    (c) => (c.evidenceIds?.length ?? 0) > 0 && c.sources.length > 0,
  ).length
  const uniqueTypes = new Set(sources.map((s) => s.type))
  const claimsWithIndependent = claimAssessments.filter((a) => a.independentSourceCount >= 1).length
  const resolvedContradictions = contradictionsAnalysis.filter(
    (a) => !UNRESOLVED_ANALYSES.has(a.analysis),
  ).length
  const gapImportance = gaps.length
    ? gaps.reduce((sum, g) => sum + g.importance, 0) / gaps.length
    : 0
  const claimsWithPrimary = claims.filter((c) =>
    c.sources.some((sid) =>
      PRIMARY_SOURCE_TYPES.has(sourceById.get(sid)?.type ?? ("OTHER" as const)),
    ),
  ).length
  const freshnessValues = [...qualityByEvidence.values()].map((q) => q.dimensions.freshness)
  const freshnessMean = freshnessValues.length
    ? freshnessValues.reduce((s, v) => s + v, 0) / freshnessValues.length
    : 0

  const dimensions: CompletenessDimension[] = [
    dimension(
      "subquestionsCovered",
      "Sub-questions covered",
      coveredSubs.size,
      plan.subQuestions.length,
      `${coveredSubs.size} of ${plan.subQuestions.length} sub-questions have linked evidence`,
    ),
    dimension(
      "evidenceCoverage",
      "Evidence linked to claims",
      evidenceCovered,
      evidence.length,
      `${evidenceCovered} of ${evidence.length} evidence items back a claim`,
    ),
    dimension(
      "claimCoverage",
      "Claims with evidence + sources",
      claimsCovered,
      claims.length,
      `${claimsCovered} of ${claims.length} claims link to evidence and sources`,
    ),
    dimension(
      "sourceDiversity",
      "Source type diversity",
      uniqueTypes.size,
      Math.min(5, Math.max(1, sources.length)),
      `${uniqueTypes.size} distinct source type${uniqueTypes.size === 1 ? "" : "s"} (target 5)`,
    ),
    dimension(
      "independentSourceCoverage",
      "Claims with independent sources",
      claimsWithIndependent,
      claims.length,
      `${claimsWithIndependent} of ${claims.length} claims have a structurally independent source`,
    ),
    dimension(
      "contradictionResolution",
      "Contradictions resolved into context",
      resolvedContradictions,
      contradictionsAnalysis.length,
      contradictions.length
        ? `${resolvedContradictions} of ${contradictionsAnalysis.length} contradictions resolved into a context`
        : "no contradictions",
    ),
    dimension(
      "researchGaps",
      "No open research gaps",
      gaps.length ? gaps.filter((g) => g.importance < CRITICAL_GAP_IMPORTANCE).length : 1,
      gaps.length || 1,
      gaps.length
        ? `${gaps.length} research gap${gaps.length === 1 ? "" : "s"} (mean importance ${gapImportance.toFixed(2)})`
        : "no research gaps",
    ),
    dimension(
      "primarySourceCoverage",
      "Claims backed by primary sources",
      claimsWithPrimary,
      claims.length,
      `${claimsWithPrimary} of ${claims.length} claims cite a primary-type source`,
    ),
    dimension(
      "freshnessCoverage",
      "Evidence freshness",
      freshnessValues.length ? 1 : 0,
      1,
      freshnessValues.length
        ? `mean freshness ${freshnessMean.toFixed(2)} across ${freshnessValues.length} evidence items`
        : "no freshness data (no evidence qualities)",
    ),
  ]

  const blocked = sources.length === 0 && evidence.length === 0 && claims.length === 0
  const score = clamp(
    dimensions.reduce(
      (sum, d) => sum + d.score * (COMPLETENESS_WEIGHTS as Record<string, number>)[d.id]!,
      0,
    ),
  )
  const status = blocked
    ? "BLOCKED"
    : score >= COMPLETENESS_THRESHOLDS.COMPLETE
      ? "COMPLETE"
      : score >= COMPLETENESS_THRESHOLDS.MOSTLY_COMPLETE
        ? "MOSTLY_COMPLETE"
        : score >= COMPLETENESS_THRESHOLDS.PARTIALLY_COMPLETE
          ? "PARTIALLY_COMPLETE"
          : "INSUFFICIENT"

  const unresolvedGaps = gaps.filter((g) => g.importance >= CRITICAL_GAP_IMPORTANCE)
  const unresolvedContradictions = contradictions.filter((c) =>
    contradictionsAnalysis.some(
      (a) =>
        a.contradictionId === c.id && a.severity === "HIGH" && UNRESOLVED_ANALYSES.has(a.analysis),
    ),
  )

  const recommendations: string[] = []
  if (unresolvedContradictions.length > 0) {
    for (const c of unresolvedContradictions.slice(0, 2)) {
      recommendations.push(`Resolve HIGH contradiction between ${c.claimA} and ${c.claimB}.`)
    }
  }
  if (unresolvedGaps.length > 0) {
    recommendations.push(`Close critical research gap: ${unresolvedGaps[0]!.question}`)
  }
  if (
    claimsWithIndependent < claims.length &&
    claims.length > 0 &&
    independence.independentSources === 0
  ) {
    recommendations.push("Corroborate claims with structurally independent sources.")
  }
  if (ratio(coveredSubs.size, plan.subQuestions.length) < 0.8) {
    const uncovered = plan.subQuestions.filter((s) => !coveredSubs.has(s.id))
    if (uncovered.length > 0) {
      recommendations.push(`Cover uncovered sub-question: ${uncovered[0]!.text}`)
    }
  }
  if (freshnessMean > 0 && freshnessMean < 0.6) {
    recommendations.push("Seek more recent sources to improve freshness coverage.")
  }
  if (uniqueTypes.size < 3 && sources.length >= 2) {
    recommendations.push("Diversify source types beyond the current set.")
  }

  return {
    score,
    status,
    dimensions,
    unresolvedGaps,
    unresolvedContradictions,
    recommendations,
  }
}

export interface StoppingCriteriaInput {
  completeness: ResearchCompleteness
  claims: ClaimConfidenceAssessment[]
  /** Explicit uncertainties (v0.4) to feed the "should we continue?" decision. */
  uncertainties?: Uncertainty[]
  resources: {
    sourcesUsed: number
    queriesUsed: number
    followUpRoundsUsed?: number
    iterationsUsed?: number
  }
  limits?: {
    maxSources?: number
    maxSubQuestions?: number
    maxFollowUpRounds?: number
    maxIterations?: number
  }
}

/** Uncertainty kinds substantial enough to justify continued research. */
const SUBSTANTIVE_UNCERTAINTY_KINDS = new Set<Uncertainty["kind"]>([
  "CONFLICTING_EVIDENCE",
  "LOW_QUALITY_EVIDENCE",
])

/**
 * Deterministic "should research continue?" decision. Research continues while
 * a genuine open problem remains (unresolved contradiction, critical gap, a
 * claim that still lacks independent corroboration, or substantive supporting
 * uncertainty) — unless a hard limit was reached, in which case we stop and
 * say so explicitly.
 */
export function evaluateStoppingCriteria(input: StoppingCriteriaInput): StoppingCriteriaResult {
  const { completeness, claims, resources, limits } = input
  const reasons: string[] = []

  for (const c of completeness.unresolvedContradictions) {
    reasons.push(`unresolved HIGH contradiction between ${c.claimA} and ${c.claimB}`)
  }
  for (const gap of completeness.unresolvedGaps) {
    reasons.push(`critical research gap: ${gap.question}`)
  }
  const needsIndependence = claims.filter(
    (a) => a.evidenceCount > 0 && a.independentSourceCount === 0,
  )
  for (const a of needsIndependence.slice(0, 2)) {
    reasons.push(`claim ${a.claimId} lacks independent corroboration`)
  }
  if (!["COMPLETE", "MOSTLY_COMPLETE"].includes(completeness.status)) {
    reasons.push(
      `research completeness is ${completeness.status} (${completeness.score.toFixed(2)})`,
    )
  }

  const uncertaintyReasons: string[] = []
  for (const u of input.uncertainties ?? []) {
    if (!SUBSTANTIVE_UNCERTAINTY_KINDS.has(u.kind)) continue
    if (uncertaintyReasons.length >= 2) break
    uncertaintyReasons.push(u.detail)
  }
  for (const reason of uncertaintyReasons) {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  const exceeded: string[] = []
  if (limits?.maxSources !== undefined && resources.sourcesUsed >= limits.maxSources) {
    exceeded.push(`source cap (${limits.maxSources})`)
  }
  if (limits?.maxSubQuestions !== undefined && resources.queriesUsed >= limits.maxSubQuestions) {
    exceeded.push(`query cap (${limits.maxSubQuestions})`)
  }
  if (
    limits?.maxFollowUpRounds !== undefined &&
    (resources.followUpRoundsUsed ?? 0) >= limits.maxFollowUpRounds
  ) {
    exceeded.push(`follow-up cap (${limits.maxFollowUpRounds})`)
  }
  if (
    limits?.maxIterations !== undefined &&
    (resources.iterationsUsed ?? 0) >= limits.maxIterations
  ) {
    exceeded.push(`iteration cap (${limits.maxIterations})`)
  }

  const limitsRespected = exceeded.length === 0
  if (!limitsRespected)
    reasons.push(
      `research stopped: resource limit${exceeded.length === 1 ? "" : "s"} reached (${exceeded.join(", ")})`,
    )

  return {
    continueResearch: reasons.length > 0 && limitsRespected,
    reasons,
    limitsRespected,
  }
}
