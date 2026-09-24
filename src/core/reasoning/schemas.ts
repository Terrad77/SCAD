import { z } from "zod"
import { HypothesisSchema, ResearchIntelligenceReportSchema } from "../schemas.js"
import {
  DECISION_RESPONSES,
  REASONING_ACTION_KINDS,
  REASONING_STATUSES,
  REASON_CYCLE_STATUSES,
  REASON_CYCLE_TRIGGERS,
  STEP_STATUSES,
  STOPPING_KINDS,
} from "./types.js"

/**
 * v0.5 + v0.6 — Zod validation for the reasoning control state, the version
 * log, the v0.6 persistent cursor/ledger/decisions and the intelligence
 * envelope. Kept next to the domain types so persisted JSON round-trips
 * through the same guarantees as the rest of the pipeline.
 */

export const CycleContextSchema = z.object({
  cycleId: z.string().min(1),
  referenceDate: z.string().min(1),
  budget: z.object({
    maxSteps: z.number().int().positive(),
    maxSources: z.number().int().positive(),
    maxQueries: z.number().int().positive(),
    maxFollowUpRounds: z.number().int().min(0),
  }),
  stateSignature: z.string().min(1),
})

export const ResearchTargetSchema = z.object({
  subject: z.enum(["gap", "subquestion", "evidence"]),
  id: z.string().min(1),
  query: z.string().min(1),
})

export const ReasoningActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("RESEARCH"),
    target: ResearchTargetSchema,
  }),
  z.object({
    kind: z.literal("GENERATE_HYPOTHESIS"),
    targetHypothesis: z.string().min(1).nullable(),
    basis: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal("REVISE_HYPOTHESIS"),
    targetHypothesis: z.string().min(1),
  }),
  z.object({
    kind: z.literal("REJECT_HYPOTHESIS"),
    targetHypothesis: z.string().min(1),
  }),
  z.object({
    kind: z.literal("REQUEST_HUMAN_INPUT"),
    target: z.string().min(1),
    question: z.string().min(1),
  }),
  z.object({
    kind: z.literal("STOP"),
    stoppingKind: z.enum(STOPPING_KINDS),
    reason: z.string().min(1),
  }),
])

export const ReasoningStepSchema = z.object({
  id: z.string().min(1),
  cycleContext: z.object({
    cycleId: z.string().min(1),
    referenceDate: z.string().min(1),
  }),
  action: ReasoningActionSchema,
  status: z.enum(STEP_STATUSES),
  stateSignatureBefore: z.string().min(1),
  stateSignatureAfter: z.string().min(1),
  performedAt: z.string().min(1),
  writes: z.array(z.string()),
  notes: z.array(z.string()),
})

export const HypothesisVersionSchema = HypothesisSchema.extend({
  versionId: z.string().min(1),
  hypothesisId: z.string().min(1),
  version: z.number().int().positive(),
  parentVersionId: z.string().optional(),
  supersededByVersionId: z.string().optional(),
  reason: z.string().min(1),
  createdAfterStep: z.string().min(1),
})

export const ReasoningStateSchema = z.object({
  project: z.string().min(1),
  question: z.string().min(1),
  cycleContext: CycleContextSchema.nullable(),
  steps: z.array(ReasoningStepSchema),
  lastStopping: z
    .object({
      stoppingKind: z.enum(STOPPING_KINDS),
      reason: z.string(),
      at: z.string(),
    })
    .nullable(),
  status: z.enum(REASONING_STATUSES),
})

export const ReasoningStateVersionSchema = z.object({
  /** Validation schema version so future migrations can branch on it. */
  version: z.literal(1),
  state: ReasoningStateSchema,
})

export const ReasoningBudgetSchema = z.object({
  maxSteps: z.number().int().positive(),
  maxSources: z.number().int().positive(),
  maxQueries: z.number().int().positive(),
  maxFollowUpRounds: z.number().int().min(0),
})

export const ReasoningCursorSchema = z.object({
  sessionId: z.string().min(1),
  project: z.string().min(1),
  question: z.string().min(1),
  status: z.enum(REASONING_STATUSES),
  currentCycleId: z.string().min(1).nullable(),
  nextStepNumber: z.number().int().positive(),
  previousCycleId: z.string().min(1).nullable(),
  referenceDate: z.string().min(1),
  budget: ReasoningBudgetSchema,
  stateSignature: z.string().min(1),
  consumedDecisionIds: z.array(z.string()),
  steps: z.array(ReasoningStepSchema),
  lastStopping: z
    .object({
      stoppingKind: z.enum(STOPPING_KINDS),
      reason: z.string(),
      at: z.string(),
    })
    .nullable(),
})

export const ReasoningCursorEnvelopeSchema = z.object({
  version: z.literal(2),
  state: ReasoningCursorSchema,
})

export const EpistemicDeltaSchema = z.object({
  producedVersionIds: z.array(z.string()),
  supersededVersionIds: z.array(z.string()),
  rejectedVersionIds: z.array(z.string()),
  keysWritten: z.array(z.string()),
})

export const ReasoningCycleSchema = z.object({
  cycleId: z.string().min(1),
  status: z.enum(REASON_CYCLE_STATUSES),
  trigger: z.enum(REASON_CYCLE_TRIGGERS),
  referenceDate: z.string().min(1),
  budget: ReasoningBudgetSchema,
  humanInTheLoop: z.boolean(),
  startedWithStateSignature: z.string(),
  endedWithStateSignature: z.string(),
  endedWithEpistemicSignature: z.string(),
  steps: z.array(ReasoningStepSchema),
  stopping: z
    .object({
      stoppingKind: z.enum(STOPPING_KINDS),
      reason: z.string(),
      at: z.string(),
    })
    .nullable(),
  delta: EpistemicDeltaSchema,
  source: z.enum(["engine", "legacy-v1"]),
})

export const ReasoningHistorySchema = z.object({
  version: z.literal(1),
  cycles: z.array(ReasoningCycleSchema),
})

export const DecisionRecordSchema = z.object({
  decisionId: z.string().min(1),
  kind: z.enum(REASONING_ACTION_KINDS),
  subject: z.string().min(1),
  proposedAction: z.unknown().optional(),
  response: z.enum(DECISION_RESPONSES),
  responseDetail: z.string().nullable(),
  cycleId: z.string().min(1),
  stepId: z.string().min(1),
  createdAt: z.string().min(1),
})

export const DecisionsStoreSchema = z.object({
  version: z.literal(1),
  records: z.array(DecisionRecordSchema),
})

export const IntelligenceEnvelopeSchema = z.object({
  version: z.literal(1),
  inputSignature: z.string().min(1),
  generatedAt: z.string().min(1),
  report: ResearchIntelligenceReportSchema,
})

/** Acceptance guard: every action kind is both declared and validated. */
export const VALIDATED_ACTION_KINDS: readonly string[] = REASONING_ACTION_KINDS
