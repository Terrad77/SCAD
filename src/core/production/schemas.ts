import { z } from "zod"
import {
  CLAIM_STATUSES,
  COMPLETENESS_STATUSES,
  HYPOTHESIS_STATUSES,
  HYPOTHESIS_VERIFICATION_STATUSES,
  KNOWLEDGE_LEVELS,
  UNCERTAINTY_KINDS,
} from "../types.js"
import {
  REASONING_ACTION_KINDS,
  REASONING_STATUSES,
  REASON_CYCLE_TRIGGERS,
  STOPPING_KINDS,
} from "../reasoning/types.js"
import {
  CONSTRAINT_SEVERITIES,
  PRODUCTION_CHECK_IDS,
  PRODUCTION_CHECK_STATUSES,
  PRODUCTION_CONSTRAINT_KINDS,
  PRODUCTION_DIAGNOSTIC_KINDS,
  PRODUCTION_NORMALIZATION_RULES,
  REASONING_CONTEXT_VERSION,
  PRODUCTION_PROVENANCE_VERSION,
  PRODUCTION_MANIFEST_VERSION,
} from "./types.js"

/**
 * v0.7 — Zod validation for the reasoning→production handoff. The context
 * round-trips through the same guarantees as every other persisted artifact, so
 * a resumed production run re-reads exactly what it wrote.
 */

const idSchema = z.string().min(1)
const nullableId = z.string().min(1).nullable()

export const ProductionConstraintSchema = z.object({
  id: idSchema,
  kind: z.enum(PRODUCTION_CONSTRAINT_KINDS),
  severity: z.enum(CONSTRAINT_SEVERITIES),
  rule: z.string().min(1),
  subjectIds: z.array(idSchema),
  source: z.enum(["epistemic", "reasoning", "governance"]),
})

export const ReasoningDecisionSchema = z.object({
  cycleId: nullableId,
  sessionId: nullableId,
  stepId: nullableId,
  trigger: z.enum(REASON_CYCLE_TRIGGERS).nullable(),
  actionKind: z.union([z.enum(REASONING_ACTION_KINDS), z.literal("NONE")]),
  actionTarget: z.string().nullable(),
  status: z.union([z.enum(REASONING_STATUSES), z.literal("NONE")]),
  stoppingKind: z.enum(STOPPING_KINDS).nullable(),
  stoppingReason: z.string().nullable(),
  humanInTheLoop: z.boolean(),
  cycleCompleted: z.boolean(),
})

export const ContextClaimViewSchema = z.object({
  claimId: idSchema,
  knowledge: z.enum(KNOWLEDGE_LEVELS),
  status: z.enum(CLAIM_STATUSES),
  confidence: z.number().min(0).max(1),
  usable: z.boolean(),
  requiresQualification: z.boolean(),
  contradictionIds: z.array(idSchema),
  gapIds: z.array(idSchema),
  uncertaintyIds: z.array(idSchema),
})

export const ContextHypothesisViewSchema = z.object({
  hypothesisId: idSchema,
  versionId: idSchema,
  statement: z.string().min(1),
  /**
   * v0.7 (H5) — the verification rationale lives beside the statement, never
   * inside it. `.default(null)` keeps a v0.7-rc context (which concatenated
   * them) parseable.
   */
  verificationRationale: z.string().nullable().default(null),
  status: z.enum(HYPOTHESIS_STATUSES),
  confidence: z.number().min(0).max(1),
  verificationStatus: z.union([z.enum(HYPOTHESIS_VERIFICATION_STATUSES), z.literal("UNVERIFIED")]),
  supportingClaimIds: z.array(idSchema),
  contradictingClaimIds: z.array(idSchema),
  researchGapIds: z.array(idSchema),
  isAlternative: z.boolean(),
})

export const ContextUncertaintyViewSchema = z.object({
  uncertaintyId: idSchema,
  kind: z.enum(UNCERTAINTY_KINDS),
  subjectType: z.enum(["claim", "hypothesis", "evidence", "research"]),
  subjectId: idSchema,
  detail: z.string().min(1),
})

export const EpistemicSummarySchema = z.object({
  claimCount: z.number().int().nonnegative(),
  usableClaimCount: z.number().int().nonnegative(),
  qualifiedClaimCount: z.number().int().nonnegative(),
  unsupportedClaimCount: z.number().int().nonnegative(),
  hypothesisCount: z.number().int().nonnegative(),
  activeHypothesisCount: z.number().int().nonnegative(),
  contradictionCount: z.number().int().nonnegative(),
  openGapCount: z.number().int().nonnegative(),
  uncertaintyCount: z.number().int().nonnegative(),
  meanClaimConfidence: z.number().min(0).max(1),
  completenessStatus: z.union([z.enum(COMPLETENESS_STATUSES), z.literal("UNKNOWN")]),
  continueResearch: z.boolean(),
})

/**
 * v0.7 (M2) — the claim → evidence → source edge, so "traceable" is a claim
 * about the chain rather than about the presence of an id.
 */
export const ContextClaimTraceEdgeSchema = z.object({
  claimId: idSchema,
  evidenceIds: z.array(idSchema),
  sourceIds: z.array(idSchema),
  supported: z.boolean(),
})

export const ReasoningContextTraceRefsSchema = z.object({
  reasoningCycleId: nullableId,
  reasoningSessionId: nullableId,
  reasoningStepId: nullableId,
  epistemicSignature: z.string().min(1),
  stateSignature: z.string(),
  intelligenceInputSignature: z.string().nullable(),
  /** v0.7 (H1): how the intelligence projection was obtained. */
  intelligenceFreshness: z.enum(["fresh", "recomputed", "absent"]).default("absent"),
  /** v0.7 (H1): the budget the intelligence signature was validated against. */
  intelligenceBudget: z
    .object({
      maxSteps: z.number().int().positive(),
      maxSources: z.number().int().positive(),
      maxQueries: z.number().int().positive(),
      maxFollowUpRounds: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  claimIds: z.array(idSchema),
  claimTraceEdges: z.array(ContextClaimTraceEdgeSchema).default([]),
  hypothesisVersionIds: z.array(idSchema),
  contradictionIds: z.array(idSchema),
  gapIds: z.array(idSchema),
  uncertaintyIds: z.array(idSchema),
  evidenceIds: z.array(idSchema),
  sourceIds: z.array(idSchema),
})

export const ReasoningContextSchema = z.object({
  version: z.literal(REASONING_CONTEXT_VERSION),
  inputSignature: z.string().min(1),
  contextSignature: z.string().min(1),
  project: idSchema,
  question: z.string().min(1),
  referenceDate: z.string().min(1),
  reasoningCycleId: nullableId,
  decision: ReasoningDecisionSchema,
  epistemicSummary: EpistemicSummarySchema,
  claims: z.array(ContextClaimViewSchema),
  activeHypotheses: z.array(ContextHypothesisViewSchema),
  uncertainties: z.array(ContextUncertaintyViewSchema),
  constraints: z.array(ProductionConstraintSchema),
  traceRefs: ReasoningContextTraceRefsSchema,
})

export const ProductionViolationSchema = z.object({
  kind: z.enum(PRODUCTION_CONSTRAINT_KINDS),
  constraintId: nullableId,
  severity: z.enum(CONSTRAINT_SEVERITIES),
  subjectIds: z.array(idSchema),
  detail: z.string().min(1),
  /** v0.7 (H6): the guard's CLAIM that the postcondition now holds. */
  resolved: z.boolean().default(false),
  /** v0.7 (H6): the postcondition the audit re-derives independently. */
  postcondition: z.string().nullable().default(null),
})

export const ProductionDependencySchema = z.object({
  artifact: idSchema,
  contentSignature: z.string().min(1),
})

export const ProductionNormalizationSchema = z.object({
  rule: z.enum(PRODUCTION_NORMALIZATION_RULES),
  subjectId: idSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1),
})

export const ProductionProvenanceSchema = z.object({
  version: z.literal(PRODUCTION_PROVENANCE_VERSION),
  contextVersion: z.number().int().positive(),
  inputSignature: z.string().min(1),
  contextSignature: z.string().min(1),
  reasoningCycleId: nullableId,
  project: idSchema,
  question: z.string().min(1),
  satisfiedConstraints: z.array(z.string()),
  violations: z.array(ProductionViolationSchema),
  normalizations: z.array(ProductionNormalizationSchema),
  /** v0.7 (H3): the artifacts this one was actually built from. */
  dependencies: z.array(ProductionDependencySchema).default([]),
})

export const ProductionCheckResultSchema = z.object({
  id: z.enum(PRODUCTION_CHECK_IDS),
  status: z.enum(PRODUCTION_CHECK_STATUSES),
  detail: z.string().min(1),
  subjectIds: z.array(idSchema),
  /**
   * Required whenever `status` is `UNKNOWN`, and forbidden otherwise. Enforced
   * in the refinement below so a new UNKNOWN site cannot silently inherit the
   * benign "nothing to check" meaning by omitting the field.
   */
  unknownReason: z.enum(["not-applicable", "unverifiable"]).optional(),
})

export const SelfCheckDiagnosticSchema = z.object({
  id: idSchema,
  kind: z.enum(PRODUCTION_DIAGNOSTIC_KINDS),
  severity: z.enum(["critical", "warning", "info"]),
  detail: z.string().min(1),
  subjectIds: z.array(idSchema),
  route: z.enum(["human", "reasoning"]),
})

export const SelfCheckProductionReportSchema = z
  .object({
    inputSignature: z.string().min(1),
    contextSignature: z.string().min(1),
    reasoningCycleId: nullableId,
    verdict: z.enum(PRODUCTION_CHECK_STATUSES),
    checks: z.array(ProductionCheckResultSchema),
    diagnostics: z.array(SelfCheckDiagnosticSchema),
    epistemicMutation: z.literal(false),
    /** v0.7 (H3): the artifacts the audit actually read. */
    dependencies: z.array(ProductionDependencySchema).default([]),
  })
  .superRefine((report, ctx) => {
    // An UNKNOWN with no declared reason is ambiguous by construction: the
    // reader cannot tell "nothing to check" from "could not check". Refuse it
    // rather than defaulting, so a new UNKNOWN site has to state which it is.
    for (const [index, check] of report.checks.entries()) {
      if (check.status === "UNKNOWN" && check.unknownReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checks", index, "unknownReason"],
          message: `check ${check.id} is UNKNOWN but does not declare an unknownReason`,
        })
      }
    }
  })

export const ProductionArtifactStalenessSchema = z.object({
  artifact: idSchema,
  status: z.enum(["CURRENT", "STALE", "MISSING", "UNKNOWN"]),
  inputSignature: z.string().nullable(),
  reasoningCycleId: nullableId,
  reason: z
    .enum([
      "INPUT_SIGNATURE_CHANGED",
      "DEPENDENCY_CHANGED",
      "DEPENDENCY_MISSING",
      "CONTEXT_CORRUPT",
      "NO_CURRENT_SIGNATURE",
    ])
    .nullable()
    .default(null),
  dependency: z.string().nullable().default(null),
})

export const ProductionStalenessSchema = z.object({
  currentInputSignature: z.string().nullable(),
  currentContextSignature: z.string().nullable().default(null),
  artifacts: z.array(ProductionArtifactStalenessSchema),
  stale: z.boolean(),
  autoRegenerate: z.literal(false),
})

export const ProductionArtifactRefSchema = z.object({
  artifact: idSchema,
  inputSignature: z.string().nullable(),
  contextSignature: z.string().nullable(),
  reasoningCycleId: nullableId,
  dependencies: z.array(ProductionDependencySchema).default([]),
})

export const ProductionManifestSchema = z.object({
  version: z.literal(PRODUCTION_MANIFEST_VERSION),
  project: idSchema,
  question: z.string().min(1),
  context: z.object({
    version: z.number().int().positive(),
    inputSignature: z.string().min(1),
    contextSignature: z.string().min(1),
    reasoningCycleId: nullableId,
    referenceDate: z.string().min(1),
  }),
  artifacts: z.array(ProductionArtifactRefSchema),
  constraints: z.array(ProductionConstraintSchema),
  selfCheck: z
    .object({
      verdict: z.enum(PRODUCTION_CHECK_STATUSES),
      checks: z.array(ProductionCheckResultSchema),
    })
    .nullable(),
  staleness: ProductionStalenessSchema,
})
