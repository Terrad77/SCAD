import { z } from "zod"
import {
  APPROVAL_POINTS,
  CLAIM_ASSESSMENT_STATUSES,
  CLAIM_STATUSES,
  COMPLETENESS_STATUSES,
  CONTRADICTION_ANALYSIS_KINDS,
  CONTRADICTION_KINDS,
  CONTRADICTION_SEVERITIES,
  HYPOTHESIS_STATUSES,
  HYPOTHESIS_VERIFICATION_STATUSES,
  KNOWLEDGE_LEVELS,
  SOURCE_RELATIONSHIPS,
  SOURCE_TYPES,
  STAGES,
  UNCERTAINTY_KINDS,
  VISUAL_TYPES,
} from "./types.js"

export type {
  SourceType,
  KnowledgeLevel,
  ClaimStatus,
  HypothesisStatus,
  VisualType,
  Stage,
  ApprovalPoint,
  ClaimAssessmentStatus,
  CompletenessStatus,
  ContradictionAnalysisKind,
  SourceRelationship,
  UncertaintyKind,
} from "./types.js"
export * from "./types.js"

const idSchema = z.string().min(1)
const unitInterval = z.number().min(0).max(1)

export const STAGES_ENUM = z.enum(STAGES)
export const SOURCE_TYPES_ENUM = z.enum(SOURCE_TYPES)
export const KNOWLEDGE_LEVELS_ENUM = z.enum(KNOWLEDGE_LEVELS)
export const CLAIM_STATUSES_ENUM = z.enum(CLAIM_STATUSES)
export const CLAIM_ASSESSMENT_STATUSES_ENUM = z.enum(CLAIM_ASSESSMENT_STATUSES)
export const HYPOTHESIS_STATUSES_ENUM = z.enum(HYPOTHESIS_STATUSES)
export const VISUAL_TYPES_ENUM = z.enum(VISUAL_TYPES)
export const APPROVAL_POINTS_ENUM = z.enum(APPROVAL_POINTS)
export const SOURCE_RELATIONSHIPS_ENUM = z.enum(SOURCE_RELATIONSHIPS)
export const CONTRADICTION_ANALYSIS_KINDS_ENUM = z.enum(CONTRADICTION_ANALYSIS_KINDS)
export const COMPLETENESS_STATUSES_ENUM = z.enum(COMPLETENESS_STATUSES)
export const UNCERTAINTY_KINDS_ENUM = z.enum(UNCERTAINTY_KINDS)
export const CONTRADICTION_SEVERITIES_ENUM = z.enum(CONTRADICTION_SEVERITIES)

export const SourceSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  url: z.string().optional(),
  author: z.string().optional(),
  publisher: z.string().optional(),
  type: z.enum(SOURCE_TYPES),
  publishedAt: z.string().optional(),
  accessedAt: z.string().optional(),
  reliability: unitInterval.optional(),
  relevance: unitInterval.optional(),
  notes: z.string().optional(),
  license: z.string().optional(),
  canonicalUrl: z.string().optional(),
  queryId: z.string().optional(),
  subquestionId: z.string().optional(),
})
export type Source = z.infer<typeof SourceSchema>

export const ResearchSubQuestionSchema = z.object({
  id: idSchema,
  text: z.string().min(1),
})
export type ResearchSubQuestion = z.infer<typeof ResearchSubQuestionSchema>

export const ResearchPlanSchema = z.object({
  id: idSchema,
  question: z.string().min(1),
  scope: z.string().optional(),
  subQuestions: z.array(ResearchSubQuestionSchema).min(1),
})
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>

export const ResearchPlanOutputSchema = z.object({
  plan: ResearchPlanSchema,
})
export type ResearchPlanOutput = z.infer<typeof ResearchPlanOutputSchema>

export const SearchQuerySchema = z.object({
  id: idSchema,
  subquestionId: idSchema,
  query: z.string().min(1),
})
export type SearchQuery = z.infer<typeof SearchQuerySchema>

export const EvidenceSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  statement: z.string().min(1),
  excerpt: z.string().optional(),
  location: z.string().optional(),
  supportsClaims: z.array(idSchema),
  contradictsClaims: z.array(idSchema),
  confidence: unitInterval,
})
export type Evidence = z.infer<typeof EvidenceSchema>

export const EvidenceOutputSchema = z.object({
  evidence: z.array(EvidenceSchema).min(1),
})
export type EvidenceOutput = z.infer<typeof EvidenceOutputSchema>

export const ResearchGapSchema = z.object({
  id: idSchema,
  question: z.string().min(1),
  importance: unitInterval,
  relatedClaims: z.array(idSchema),
  suggestedResearchQueries: z.array(z.string().min(1)),
  /** Sub-question this gap concerns, when known deterministically. */
  subquestionId: idSchema.optional(),
})
export type ResearchGap = z.infer<typeof ResearchGapSchema>

export const ResearchGapsOutputSchema = z.object({
  gaps: z.array(ResearchGapSchema),
})
export type ResearchGapsOutput = z.infer<typeof ResearchGapsOutputSchema>

export const ContradictionSchema = z.object({
  id: idSchema,
  claimA: idSchema,
  claimB: idSchema,
  severity: z.enum(CONTRADICTION_SEVERITIES),
  classification: z.enum(CONTRADICTION_KINDS),
  explanation: z.string().min(1),
  relatedEvidence: z.array(idSchema).optional(),
})
export type Contradiction = z.infer<typeof ContradictionSchema>

export const ContradictionsOutputSchema = z.object({
  contradictions: z.array(ContradictionSchema),
})
export type ContradictionsOutput = z.infer<typeof ContradictionsOutputSchema>

export const ClaimSchema = z.object({
  id: idSchema,
  statement: z.string().min(1),
  sources: z.array(idSchema).min(1),
  evidence: z.array(z.string().min(1)),
  evidenceIds: z.array(idSchema).optional(),
  subquestionIds: z.array(idSchema).optional(),
  confidence: unitInterval,
  status: z.enum(CLAIM_STATUSES),
  knowledge: z.enum(KNOWLEDGE_LEVELS),
})
export type Claim = z.infer<typeof ClaimSchema>

export const HypothesisSchema = z.object({
  id: idSchema,
  statement: z.string().min(1),
  basis: z.array(z.string().min(1)),
  supportingClaims: z.array(idSchema),
  contradictingClaims: z.array(idSchema),
  supportingEvidence: z.array(idSchema).default([]),
  contradictingEvidence: z.array(idSchema).default([]),
  researchGaps: z.array(idSchema).default([]),
  confidence: unitInterval,
  status: z.enum(HYPOTHESIS_STATUSES),
  assumptions: z.array(z.string().min(1)),
  missingInfo: z.array(z.string().min(1)),
  verificationTasks: z.array(z.string().min(1)),
})
export type Hypothesis = z.infer<typeof HypothesisSchema>

// ---------------------------------------------------------------------------
// v0.4 — Research Intelligence & Verification schemas
// ---------------------------------------------------------------------------

export const EvidenceQualityDimensionsSchema = z.object({
  reliability: unitInterval,
  strength: unitInterval,
  directness: unitInterval,
  specificity: unitInterval,
  freshness: unitInterval,
})
export type EvidenceQualityDimensions = z.infer<typeof EvidenceQualityDimensionsSchema>

export const EvidenceQualitySchema = z.object({
  evidenceId: idSchema,
  sourceId: idSchema,
  dimensions: EvidenceQualityDimensionsSchema,
  overall: unitInterval,
  reasons: z.array(z.string().min(1)),
})
export type EvidenceQuality = z.infer<typeof EvidenceQualitySchema>

export const SourceRelationshipRecordSchema = z.object({
  sourceA: idSchema,
  sourceB: idSchema,
  relationship: z.enum(SOURCE_RELATIONSHIPS),
  basis: z.string().min(1),
})
export type SourceRelationshipRecord = z.infer<typeof SourceRelationshipRecordSchema>

export const SourceIndependenceResultSchema = z.object({
  relationships: z.array(SourceRelationshipRecordSchema),
  totalSources: z.number().int().nonnegative(),
  independentSources: z.number().int().nonnegative(),
  dependentSources: z.number().int().nonnegative(),
  unknownSources: z.number().int().nonnegative(),
  independenceRatio: unitInterval,
  reasons: z.array(z.string().min(1)),
})
export type SourceIndependenceResult = z.infer<typeof SourceIndependenceResultSchema>

export const ClaimConfidenceAssessmentSchema = z.object({
  claimId: idSchema,
  status: z.enum(CLAIM_ASSESSMENT_STATUSES),
  confidence: unitInterval,
  supportStrength: unitInterval,
  contradictionStrength: unitInterval,
  independentSourceCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  unresolvedGapCount: z.number().int().nonnegative(),
  completenessImpact: z.number().min(-1).max(1),
  reasons: z.array(z.string().min(1)),
})
export type ClaimConfidenceAssessment = z.infer<typeof ClaimConfidenceAssessmentSchema>

export const ContradictionContextSchema = z.object({
  type: z.string().min(1),
  detail: z.string().optional(),
})
export type ContradictionContext = z.infer<typeof ContradictionContextSchema>

export const ContradictionAnalysisSchema = z.object({
  contradictionId: idSchema,
  claimA: idSchema,
  claimB: idSchema,
  severity: z.enum(CONTRADICTION_SEVERITIES),
  classification: z.enum(CONTRADICTION_KINDS),
  analysis: z.enum(CONTRADICTION_ANALYSIS_KINDS),
  context: ContradictionContextSchema.optional(),
  evidenceQualityA: unitInterval,
  evidenceQualityB: unitInterval,
  confidence: unitInterval,
  reasons: z.array(z.string().min(1)),
})
export type ContradictionAnalysis = z.infer<typeof ContradictionAnalysisSchema>

export const CompletenessDimensionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  score: unitInterval,
  covered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  reason: z.string().min(1),
})
export type CompletenessDimension = z.infer<typeof CompletenessDimensionSchema>

export const ResearchCompletenessSchema = z.object({
  score: unitInterval,
  status: z.enum(COMPLETENESS_STATUSES),
  dimensions: z.array(CompletenessDimensionSchema),
  unresolvedGaps: z.array(ResearchGapSchema),
  unresolvedContradictions: z.array(ContradictionSchema),
  recommendations: z.array(z.string().min(1)),
})
export type ResearchCompleteness = z.infer<typeof ResearchCompletenessSchema>

export const UncertaintySchema = z.object({
  id: idSchema,
  kind: z.enum(UNCERTAINTY_KINDS),
  subjectType: z.enum(["claim", "hypothesis", "evidence", "research"]),
  subjectId: idSchema,
  detail: z.string().min(1),
  evidenceIds: z.array(idSchema).optional(),
})
export type Uncertainty = z.infer<typeof UncertaintySchema>

export const StoppingCriteriaResultSchema = z.object({
  continueResearch: z.boolean(),
  reasons: z.array(z.string().min(1)),
  limitsRespected: z.boolean(),
})
export type StoppingCriteriaResult = z.infer<typeof StoppingCriteriaResultSchema>

export const VerificationResultSchema = z.object({
  hypothesisId: idSchema,
  status: z.enum(HYPOTHESIS_VERIFICATION_STATUSES),
  confidence: unitInterval,
  supportingEvidence: z.array(idSchema),
  contradictingEvidence: z.array(idSchema),
  researchGaps: z.array(idSchema),
  rationale: z.string().min(1),
  evidenceQuality: z.array(EvidenceQualitySchema).optional(),
  alternativeExplanations: z.array(z.string().min(1)).optional(),
  independentSourceCount: z.number().int().nonnegative().optional(),
  contradictions: z.array(ContradictionAnalysisSchema).optional(),
  uncertainties: z.array(UncertaintySchema).optional(),
})
export type VerificationResult = z.infer<typeof VerificationResultSchema>

export const ResearchIntelligenceReportSchema = z.object({
  question: z.string().min(1),
  questionId: idSchema,
  generatedAt: z.string().min(1),
  completeness: ResearchCompletenessSchema,
  claims: z.array(ClaimConfidenceAssessmentSchema),
  evidenceQuality: z.array(EvidenceQualitySchema),
  sourceIndependence: SourceIndependenceResultSchema,
  contradictions: z.array(ContradictionAnalysisSchema),
  hypotheses: z.array(VerificationResultSchema),
  unresolvedGaps: z.array(ResearchGapSchema),
  unresolvedContradictions: z.array(ContradictionSchema),
  uncertainties: z.array(UncertaintySchema),
  continueResearch: z.boolean(),
  stopping: StoppingCriteriaResultSchema,
  recommendations: z.array(z.string().min(1)),
})
export type ResearchIntelligenceReport = z.infer<typeof ResearchIntelligenceReportSchema>

export const HypothesisVerificationSchema = z.object({
  hypothesisId: idSchema,
  status: z.enum(HYPOTHESIS_VERIFICATION_STATUSES),
  confidence: unitInterval,
  supportingEvidence: z.array(idSchema),
  contradictingEvidence: z.array(idSchema),
  researchGaps: z.array(idSchema),
  rationale: z.string().min(1),
  // v0.4 Verification 2.0 enrichment (all optional, computed deterministically).
  evidenceQuality: z.array(EvidenceQualitySchema).optional(),
  alternativeExplanations: z.array(z.string().min(1)).optional(),
  independentSourceCount: z.number().int().nonnegative().optional(),
  contradictions: z.array(ContradictionAnalysisSchema).optional(),
  uncertainties: z.array(UncertaintySchema).optional(),
})
export type HypothesisVerification = z.infer<typeof HypothesisVerificationSchema>

export const HypothesesVerificationOutputSchema = z.object({
  verifications: z.array(HypothesisVerificationSchema),
})
export type HypothesesVerificationOutput = z.infer<typeof HypothesesVerificationOutputSchema>

export const ResearchOutputSchema = z.object({
  sources: z.array(SourceSchema),
  summary: z.string().min(1),
})
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>

export const ClaimsOutputSchema = z.object({
  claims: z.array(ClaimSchema),
})
export type ClaimsOutput = z.infer<typeof ClaimsOutputSchema>

export const HypothesesOutputSchema = z.object({
  hypotheses: z.array(HypothesisSchema),
})
export type HypothesesOutput = z.infer<typeof HypothesesOutputSchema>

export const ClaimAssessmentSchema = z.object({
  claimId: idSchema,
  verdict: z.enum(CLAIM_STATUSES),
  confidence: unitInterval,
  notes: z.string().optional(),
})
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>

export const FactCheckOutputSchema = z.object({
  assessments: z.array(ClaimAssessmentSchema),
})
export type FactCheckOutput = z.infer<typeof FactCheckOutputSchema>

export const NarrativeSentenceSchema = z.object({
  id: idSchema,
  text: z.string().min(1),
  knowledge: z.enum(KNOWLEDGE_LEVELS),
  claimIds: z.array(idSchema),
})
export type NarrativeSentence = z.infer<typeof NarrativeSentenceSchema>

export const NarrativeSectionSchema = z.object({
  id: idSchema,
  heading: z.string().min(1),
  sentences: z.array(NarrativeSentenceSchema).min(1),
})
export type NarrativeSection = z.infer<typeof NarrativeSectionSchema>

export const NarrativeSchema = z.object({
  title: z.string().min(1),
  logline: z.string().min(1),
  thesis: z.string().min(1),
  sections: z.array(NarrativeSectionSchema).min(1),
})
export type Narrative = z.infer<typeof NarrativeSchema>

export const ShotSchema = z.object({
  id: idSchema,
  duration: z.number().positive(),
  narration: z.string().min(1),
  visualType: z.enum(VISUAL_TYPES),
  description: z.string().min(1),
  camera: z.string().optional(),
  lighting: z.string().optional(),
  mood: z.string().optional(),
  source: z.string().optional(),
  aiPrompt: z.string().optional(),
  narrativeSentenceIds: z.array(idSchema),
})
export type Shot = z.infer<typeof ShotSchema>

export const VisualOutputSchema = z.object({
  shots: z.array(ShotSchema),
})
export type VisualOutput = z.infer<typeof VisualOutputSchema>

export const SelfCheckItemSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  type: z.string().min(1),
  detail: z.string().min(1),
  claimIds: z.array(idSchema).optional(),
})
export type SelfCheckItem = z.infer<typeof SelfCheckItemSchema>

export const SelfCheckOutputSchema = z.object({
  critical: z.array(SelfCheckItemSchema),
  warnings: z.array(SelfCheckItemSchema),
  info: z.array(SelfCheckItemSchema),
})
export type SelfCheckOutput = z.infer<typeof SelfCheckOutputSchema>

export const PipelineManifestSchema = z.object({
  project: z.string().min(1),
  question: z.string().min(1),
  title: z.string().min(1),
  stages: z.record(STAGES_ENUM, z.enum(["pending", "done"])),
  approvals: z.record(APPROVAL_POINTS_ENUM, z.enum(["approved", "rejected", "skipped"])),
  completedAt: z.string().optional(),
})
export type PipelineManifest = z.infer<typeof PipelineManifestSchema>

export const ResearchBundleSchema = z.object({
  question: z.string().min(1),
  summary: z.string().min(1),
  plan: ResearchPlanSchema,
  queries: z.array(SearchQuerySchema),
  sources: z.array(SourceSchema),
  evidence: z.array(EvidenceSchema),
  claims: z.array(ClaimSchema),
  contradictions: z.array(ContradictionSchema),
  gaps: z.array(ResearchGapSchema),
})
export type ResearchBundle = z.infer<typeof ResearchBundleSchema>
