import type { SourceType } from "../schemas.js"

/**
 * Centralized weights and thresholds for the deterministic Research
 * Intelligence layer (v0.4).
 *
 * Everything that SCAD "scores" — evidence quality, claim confidence,
 * research completeness — is a weighted heuristic. The weights live here so
 * the formulas are auditable in one place and never scattered as magic
 * numbers. None of these values are objective probabilities or guarantees of
 * truth; they are explainable assessment heuristics over the research the
 * engine actually collected.
 */

/** Weight of each Evidence Quality dimension in the overall quality score. */
export const EVIDENCE_QUALITY_WEIGHTS = {
  reliability: 0.35,
  strength: 0.2,
  directness: 0.15,
  specificity: 0.15,
  freshness: 0.15,
} as const

/** Weight of each Claim Assessment factor in the 2.0 confidence score. */
export const CLAIM_ASSESSMENT_WEIGHTS = {
  supportStrength: 0.45,
  sourceReliability: 0.15,
  agreement: 0.15,
  independence: 0.15,
  evidenceCount: 0.1,
} as const

/** Penalty applied to claim confidence per unit of contradiction strength. */
export const CONTRADICTION_PENALTY = 0.25

/** Cap on the total claim gap/independence penalty applied to confidence. */
export const CLAIM_COMPLETENESS_PENALTY_CAP = 0.2

/** Per-gap confidence penalty used while building `completenessImpact`. */
export const CLAIM_GAP_PENALTY = 0.04

/** Penalty for an evidence-backed claim with no structurally independent source. */
export const CLAIM_MISSING_INDEPENDENCE_PENALTY = 0.05

/** Weight of each Research Completeness dimension in the overall score. */
export const COMPLETENESS_WEIGHTS = {
  subquestionsCovered: 0.2,
  evidenceCoverage: 0.15,
  claimCoverage: 0.1,
  sourceDiversity: 0.1,
  independentSourceCoverage: 0.15,
  contradictionResolution: 0.1,
  researchGaps: 0.1,
  primarySourceCoverage: 0.05,
  freshnessCoverage: 0.05,
} as const

/** Completeness score → status thresholds (inclusive lower bounds). */
export const COMPLETENESS_THRESHOLDS = {
  COMPLETE: 0.85,
  MOSTLY_COMPLETE: 0.7,
  PARTIALLY_COMPLETE: 0.5,
  INSUFFICIENT: 0.3,
} as const

/** A gap counts as critical (blocks stopping) at or above this importance. */
export const CRITICAL_GAP_IMPORTANCE = 0.8

/** Evidence quality is "strong" at or above this value. */
export const STRONG_EVIDENCE_QUALITY = 0.6

/** Claim confidence that reads as conclusively supported. */
export const STRONGLY_SUPPORTED_CONFIDENCE = 0.8
export const SUPPORTED_CONFIDENCE = 0.6
export const PARTIALLY_SUPPORTED_CONFIDENCE = 0.4

/** Contradiction strength above which a claim is flagged as contested. */
export const CONTESTED_CONTRADICTION_STRENGTH = 0.2

/** Default heuristics when an attribute is missing (documented per dimension). */
export const DEFAULT_EVIDENCE_DIRECTNESS = 0.8
export const DEFAULT_SOURCE_RELIABILITY = 0.5
export const FRESHNESS_UNKNOWN_SCORE = 0.5

/** Freshness windows: an evidence item "aged" this many years gets this score. */
export const FRESHNESS_BY_YEARS: Array<{ years: number; score: number }> = [
  { years: 1, score: 1 },
  { years: 3, score: 0.9 },
  { years: 5, score: 0.7 },
  { years: 10, score: 0.5 },
  { years: 20, score: 0.3 },
]

/** Base reliability of a source derived from its type (never absolute truth). */
export const SOURCE_RELIABILITY_BY_TYPE: Record<SourceType, number> = {
  SCIENTIFIC_PAPER: 0.85,
  GOVERNMENT: 0.8,
  UNIVERSITY: 0.8,
  DATABASE: 0.75,
  DOCUMENTATION: 0.7,
  BOOK: 0.65,
  PAPER: 0.85,
  ARTICLE: 0.6,
  NEWS: 0.55,
  DOCUMENTARY: 0.6,
  VIDEO: 0.5,
  INTERVIEW: 0.6,
  WEB: 0.45,
  BLOG: 0.35,
  SOCIAL_MEDIA: 0.25,
  OTHER: 0.4,
  PERSONAL_KNOWLEDGE: 0.2,
}

/** Source types treated as primary for `primarySourceCoverage`. */
export const PRIMARY_SOURCE_TYPES = new Set<SourceType>([
  "SCIENTIFIC_PAPER",
  "PAPER",
  "GOVERNMENT",
  "UNIVERSITY",
  "DATABASE",
])
