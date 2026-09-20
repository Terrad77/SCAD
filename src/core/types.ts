export const SOURCE_TYPES = [
  "BOOK",
  "ARTICLE",
  "PAPER",
  "DOCUMENTARY",
  "VIDEO",
  "WEB",
  "INTERVIEW",
  "PERSONAL_KNOWLEDGE",
  "SCIENTIFIC_PAPER",
  "GOVERNMENT",
  "UNIVERSITY",
  "NEWS",
  "DATABASE",
  "DOCUMENTATION",
  "BLOG",
  "SOCIAL_MEDIA",
  "OTHER",
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export const KNOWLEDGE_LEVELS = [
  "FACT",
  "SCIENTIFIC_HYPOTHESIS",
  "INTERPRETATION",
  "SPECULATION",
  "FICTION",
] as const
export type KnowledgeLevel = (typeof KNOWLEDGE_LEVELS)[number]

export const CLAIM_STATUSES = [
  "SUPPORTED",
  "PARTIAL",
  "DISPUTED",
  "UNSUPPORTED",
  "IN_REVIEW",
] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

export const HYPOTHESIS_STATUSES = [
  "UNTESTED",
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "CONTRADICTED",
  "INCONCLUSIVE",
  "REJECTED",
  "ACTIVE",
  "APPROVED",
  "SUPERSEDED",
] as const
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number]

export const HYPOTHESIS_VERIFICATION_STATUSES = [
  "UNTESTED",
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "CONTRADICTED",
  "INCONCLUSIVE",
  "REJECTED",
] as const
export type HypothesisVerificationStatus = (typeof HYPOTHESIS_VERIFICATION_STATUSES)[number]

export const CONTRADICTION_SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const
export type ContradictionSeverity = (typeof CONTRADICTION_SEVERITIES)[number]

export const CONTRADICTION_KINDS = [
  "CONTRADICTION",
  "UNCERTAINTY",
  "DIFFERENT_POPULATION",
  "DIFFERENT_TIME_PERIOD",
  "DIFFERENT_METHODOLOGY",
  "DIFFERENT_DEFINITION",
] as const
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number]

export const SOURCE_RELATIONSHIPS = [
  "INDEPENDENT",
  "DERIVED_FROM",
  "QUOTES",
  "REPOSTS",
  "REFERENCES",
  "UNKNOWN",
] as const
export type SourceRelationship = (typeof SOURCE_RELATIONSHIPS)[number]

/** v0.4 contradiction taxonomy: a conflict resolved into its likely context. */
export const CONTRADICTION_ANALYSIS_KINDS = [
  "GENUINE_CONTRADICTION",
  "TIME_CONTEXT",
  "POPULATION_CONTEXT",
  "DEFINITION_CONTEXT",
  "SCOPE_CONTEXT",
  "METHODOLOGY_CONTEXT",
  "MEASUREMENT_CONTEXT",
  "INSUFFICIENT_CONTEXT",
  "UNKNOWN",
] as const
export type ContradictionAnalysisKind = (typeof CONTRADICTION_ANALYSIS_KINDS)[number]

export const COMPLETENESS_STATUSES = [
  "COMPLETE",
  "MOSTLY_COMPLETE",
  "PARTIALLY_COMPLETE",
  "INSUFFICIENT",
  "BLOCKED",
] as const
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number]

export const UNCERTAINTY_KINDS = [
  "UNKNOWN",
  "UNCERTAIN",
  "INSUFFICIENT_EVIDENCE",
  "CONFLICTING_EVIDENCE",
  "LOW_QUALITY_EVIDENCE",
  "NOT_APPLICABLE",
] as const
export type UncertaintyKind = (typeof UNCERTAINTY_KINDS)[number]

export const CLAIM_ASSESSMENT_STATUSES = [
  "STRONGLY_SUPPORTED",
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "INCONCLUSIVE",
  "CONTESTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
] as const
export type ClaimAssessmentStatus = (typeof CLAIM_ASSESSMENT_STATUSES)[number]

export const VISUAL_TYPES = [
  "STOCK",
  "ARCHIVE",
  "PUBLIC_DOMAIN",
  "CREATIVE_COMMONS",
  "AI_GENERATED",
  "AI_RECONSTRUCTION",
  "MAP",
  "INFOGRAPHIC",
  "SCREEN_CAPTURE",
  "ABSTRACT",
] as const
export type VisualType = (typeof VISUAL_TYPES)[number]

export const STAGES = [
  "research",
  "claims",
  "hypotheses",
  "fact-check",
  "narrative",
  "visual",
  "self-check",
] as const
export type Stage = (typeof STAGES)[number]

export const APPROVAL_POINTS = [
  "RESEARCH_REVIEW",
  "EVIDENCE_REVIEW",
  "HYPOTHESIS_REVIEW",
  "NARRATIVE_REVIEW",
  "FINAL_FACT_CHECK",
  "EXPORT",
] as const
export type ApprovalPoint = (typeof APPROVAL_POINTS)[number]

export interface Source {
  id: string
  title: string
  url?: string
  author?: string
  publisher?: string
  type: SourceType
  publishedAt?: string
  accessedAt?: string
  reliability?: number
  relevance?: number
  notes?: string
  license?: string
  canonicalUrl?: string
  queryId?: string
  subquestionId?: string
}

export interface ResearchSubQuestion {
  id: string
  text: string
}

export interface ResearchPlan {
  id: string
  question: string
  scope?: string
  subQuestions: ResearchSubQuestion[]
}

export interface SearchQuery {
  id: string
  subquestionId: string
  query: string
}

export interface Evidence {
  id: string
  sourceId: string
  statement: string
  excerpt?: string
  location?: string
  supportsClaims: string[]
  contradictsClaims: string[]
  confidence: number
}

export interface ResearchGap {
  id: string
  question: string
  importance: number
  relatedClaims: string[]
  suggestedResearchQueries: string[]
}

export interface Claim {
  id: string
  statement: string
  sources: string[]
  evidence: string[]
  evidenceIds?: string[]
  subquestionIds?: string[]
  confidence: number
  status: ClaimStatus
  knowledge: KnowledgeLevel
}

export interface Hypothesis {
  id: string
  statement: string
  basis: string[]
  supportingClaims: string[]
  contradictingClaims: string[]
  supportingEvidence: string[]
  contradictingEvidence: string[]
  researchGaps: string[]
  confidence: number
  status: HypothesisStatus
  assumptions: string[]
  missingInfo: string[]
  verificationTasks: string[]
}

export interface NarrativeSentence {
  id: string
  text: string
  knowledge: KnowledgeLevel
  claimIds: string[]
}

export interface NarrativeSection {
  id: string
  heading: string
  sentences: NarrativeSentence[]
}

export interface Narrative {
  title: string
  logline: string
  thesis: string
  sections: NarrativeSection[]
}

export interface Shot {
  id: string
  duration: number
  narration: string
  visualType: VisualType
  description: string
  camera?: string
  lighting?: string
  mood?: string
  source?: string
  aiPrompt?: string
  narrativeSentenceIds: string[]
}

export interface ResearchOutput {
  sources: Source[]
  summary: string
}

export interface HypothesesVerificationOutput {
  verifications: HypothesisVerification[]
}

export interface HypothesisVerification {
  hypothesisId: string
  status: HypothesisVerificationStatus
  confidence: number
  supportingEvidence: string[]
  contradictingEvidence: string[]
  researchGaps: string[]
  rationale: string
}

export interface ClaimsOutput {
  claims: Claim[]
}

export interface ContradictionsOutput {
  contradictions: Contradiction[]
}

export interface ResearchGapsOutput {
  gaps: ResearchGap[]
}

export interface EvidenceOutput {
  evidence: Evidence[]
}

export interface ResearchPlanOutput {
  plan: ResearchPlan
}

/**
 * The complete output of the Evidence & Research Engine. It is a superset of
 * the legacy ResearchOutput (`sources` + `summary`) so downstream pipeline
 * stages keep working unchanged.
 */
export interface ResearchBundle extends ResearchOutput {
  question: string
  plan: ResearchPlan
  queries: SearchQuery[]
  evidence: Evidence[]
  claims: Claim[]
  contradictions: Contradiction[]
  gaps: ResearchGap[]
}

export interface HypothesesOutput {
  hypotheses: Hypothesis[]
}

export interface ClaimAssessment {
  claimId: string
  verdict: ClaimStatus
  confidence: number
  notes?: string
}

export interface FactCheckOutput {
  assessments: ClaimAssessment[]
}

export interface VisualOutput {
  shots: Shot[]
}

export type Contradiction = {
  id: string
  claimA: string
  claimB: string
  severity: ContradictionSeverity
  classification: ContradictionKind
  explanation: string
  relatedEvidence?: string[]
}

export type NarrativeIssue = {
  issue: string
  sectionIds: string[]
}

export type SelfCheckItem = {
  severity: "critical" | "warning" | "info"
  type: string
  detail: string
  claimIds?: string[]
}

export interface SelfCheckOutput {
  critical: SelfCheckItem[]
  warnings: SelfCheckItem[]
  info: SelfCheckItem[]
}

export interface SelfCheckSummary {
  unsupportedClaims: number
  speculativeStatements: number
  contradictions: number
  lowConfidenceClaims: number
  missingEvidence: number
  narrativeProblems: number
}

export interface PipelineManifest {
  project: string
  question: string
  title: string
  stages: Record<Stage, "pending" | "done">
  approvals: Record<ApprovalPoint, "approved" | "rejected" | "skipped">
  completedAt?: string
}

export type ArtifactKind =
  "research" | "claims" | "hypotheses" | "narrative" | "shot-list" | "self-check"

// ---------------------------------------------------------------------------
// v0.4 — Research Intelligence & Verification (deterministic assessments)
// ---------------------------------------------------------------------------

/** The five assessable dimensions of a single piece of evidence. */
export interface EvidenceQualityDimensions {
  reliability: number
  strength: number
  directness: number
  specificity: number
  freshness: number
}

/** Deterministic quality assessment of one evidence item. */
export interface EvidenceQuality {
  evidenceId: string
  sourceId: string
  dimensions: EvidenceQualityDimensions
  /** Weighted overall quality (0..1). Heuristic, not objective truth. */
  overall: number
  reasons: string[]
}

/** A pairwise relationship between two sources (heuristic or LLM-provided). */
export interface SourceRelationshipRecord {
  sourceA: string
  sourceB: string
  relationship: SourceRelationship
  basis: string
}

/** Global source-independence assessment over a research bundle. */
export interface SourceIndependenceResult {
  relationships: SourceRelationshipRecord[]
  totalSources: number
  independentSources: number
  dependentSources: number
  unknownSources: number
  independenceRatio: number
  reasons: string[]
}

/** Claim Confidence 2.0: a deterministic assessment of how well a claim holds. */
export interface ClaimConfidenceAssessment {
  claimId: string
  status: ClaimAssessmentStatus
  confidence: number
  supportStrength: number
  contradictionStrength: number
  independentSourceCount: number
  evidenceCount: number
  sourceCount: number
  unresolvedGapCount: number
  /** How many points the score moved due to research-completeness signals. */
  completenessImpact: number
  reasons: string[]
}

/** Contextual reading of why two claims appear to conflict. */
export interface ContradictionAnalysis {
  contradictionId: string
  claimA: string
  claimB: string
  severity: ContradictionSeverity
  /** Legacy classification preserved for compatibility. */
  classification: ContradictionKind
  /** v0.4 taxonomy: is this a genuine conflict or an explainable context? */
  analysis: ContradictionAnalysisKind
  context?: { type: string; detail?: string }
  evidenceQualityA: number
  evidenceQualityB: number
  /** Deterministic heuristic confidence in the `analysis` label (0..1). */
  confidence: number
  reasons: string[]
}

export interface CompletenessDimension {
  id: string
  label: string
  score: number
  covered: number
  total: number
  reason: string
}

/** Research Completeness: how fully the research question is answered. */
export interface ResearchCompleteness {
  score: number
  status: CompletenessStatus
  dimensions: CompletenessDimension[]
  unresolvedGaps: ResearchGap[]
  unresolvedContradictions: Contradiction[]
  recommendations: string[]
}

export type UncertaintySubjectType = "claim" | "hypothesis" | "evidence" | "research"

/** Explicit, first-class statement of uncertainty (never collapsed to 0). */
export interface Uncertainty {
  id: string
  kind: UncertaintyKind
  subjectType: UncertaintySubjectType
  subjectId: string
  detail: string
  evidenceIds?: string[]
}

/** Deterministic answer to "should research continue?" */
export interface StoppingCriteriaResult {
  continueResearch: boolean
  reasons: string[]
  limitsRespected: boolean
}

/** Hypothesis Verification 2.0: base verification enriched with intelligence. */
export interface VerificationResult extends HypothesisVerification {
  evidenceQuality?: EvidenceQuality[]
  alternativeExplanations?: string[]
  independentSourceCount?: number
  contradictions?: ContradictionAnalysis[]
  uncertainties?: Uncertainty[]
}

/** The full output of the Research Intelligence engine. */
export interface ResearchIntelligenceReport {
  question: string
  questionId: string
  generatedAt: string
  completeness: ResearchCompleteness
  claims: ClaimConfidenceAssessment[]
  evidenceQuality: EvidenceQuality[]
  sourceIndependence: SourceIndependenceResult
  contradictions: ContradictionAnalysis[]
  hypotheses: VerificationResult[]
  unresolvedGaps: ResearchGap[]
  unresolvedContradictions: Contradiction[]
  uncertainties: Uncertainty[]
  continueResearch: boolean
  stopping: StoppingCriteriaResult
  recommendations: string[]
}
