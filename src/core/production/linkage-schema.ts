import { z } from "zod"

const ids = z
  .array(z.string().min(1))
  .refine((values) => new Set(values).size === values.length, "Duplicate reference IDs")
export const ConstraintTreatmentSchema = z.object({
  constraintId: z.string().min(1),
  subjectIds: ids,
  treatment: z.enum([
    "qualify-hypothesis",
    "acknowledge-uncertainty",
    "preserve-contradiction",
    "keep-gap-open",
    "avoid-definitive-conclusion",
    "maintain-traceability",
    "limit-factual-assertion",
    "avoid-unsupported-causality",
  ]),
  explanation: z.string().min(1),
})
export type ConstraintTreatment = z.infer<typeof ConstraintTreatmentSchema>
export const NarrativeReferenceFields = {
  hypothesisIds: ids.optional(),
  uncertaintyIds: ids.optional(),
  contradictionIds: ids.optional(),
  constraintTreatments: z.array(ConstraintTreatmentSchema).optional(),
}
export const NarrativeLinkageReportSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["explicit", "legacy"]),
  structuralStatus: z.enum(["PASS", "WARN", "FAIL", "UNKNOWN"]),
  semanticStatus: z.enum(["UNKNOWN", "not-applicable"]),
  references: z.array(
    z.object({
      sentenceId: z.string(),
      kind: z.enum(["hypothesis", "uncertainty", "contradiction", "constraint"]),
      targetId: z.string(),
      status: z.enum(["VALID", "INVALID"]),
      detail: z.string(),
    }),
  ),
  constraints: z.array(
    z.object({
      constraintId: z.string(),
      sentenceIds: ids,
      status: z.enum(["COVERED", "MISSING", "GOVERNANCE"]),
      semanticStatus: z.enum(["UNKNOWN", "not-applicable"]),
    }),
  ),
  issues: z.array(
    z.object({ sentenceId: z.string().nullable(), targetId: z.string(), detail: z.string() }),
  ),
})
export type NarrativeLinkageReport = z.infer<typeof NarrativeLinkageReportSchema>
