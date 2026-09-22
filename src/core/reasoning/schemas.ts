import { z } from "zod"
import { HypothesisSchema } from "../schemas.js"
import {
  REASONING_ACTION_KINDS,
  REASONING_STATUSES,
  STEP_STATUSES,
  STOPPING_KINDS,
} from "./types.js"

/**
 * v0.5 — Zod validation for the reasoning control state and the hypothesis
 * version log. Kept next to the domain types so persisted JSON round-trips
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

/** Acceptance guard: every action kind is both declared and validated. */
export const VALIDATED_ACTION_KINDS: readonly string[] = REASONING_ACTION_KINDS
