import { z } from "zod"
import {
  APPROVAL_POINTS,
  CLAIM_STATUSES,
  HYPOTHESIS_STATUSES,
  KNOWLEDGE_LEVELS,
  SOURCE_TYPES,
  STAGES,
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
} from "./types.js"
export * from "./types.js"

const idSchema = z.string().min(1)
const unitInterval = z.number().min(0).max(1)

export const STAGES_ENUM = z.enum(STAGES)
export const SOURCE_TYPES_ENUM = z.enum(SOURCE_TYPES)
export const KNOWLEDGE_LEVELS_ENUM = z.enum(KNOWLEDGE_LEVELS)
export const CLAIM_STATUSES_ENUM = z.enum(CLAIM_STATUSES)
export const HYPOTHESIS_STATUSES_ENUM = z.enum(HYPOTHESIS_STATUSES)
export const VISUAL_TYPES_ENUM = z.enum(VISUAL_TYPES)
export const APPROVAL_POINTS_ENUM = z.enum(APPROVAL_POINTS)

export const SourceSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  url: z.string().optional(),
  author: z.string().optional(),
  type: z.enum(SOURCE_TYPES),
  reliability: unitInterval.optional(),
  notes: z.string().optional(),
})
export type Source = z.infer<typeof SourceSchema>

export const ClaimSchema = z.object({
  id: idSchema,
  statement: z.string().min(1),
  sources: z.array(idSchema).min(1),
  evidence: z.array(z.string().min(1)),
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
  confidence: unitInterval,
  status: z.enum(HYPOTHESIS_STATUSES),
  assumptions: z.array(z.string().min(1)),
  missingInfo: z.array(z.string().min(1)),
  verificationTasks: z.array(z.string().min(1)),
})
export type Hypothesis = z.infer<typeof HypothesisSchema>

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
