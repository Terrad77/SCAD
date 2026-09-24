import { createHash } from "node:crypto"
import type { ResearchIntelligenceReport } from "../../core/schemas.js"
import type { IntelligenceEnvelope, ReasoningBudget } from "../../core/reasoning/types.js"
import { stripVolatileForSignature } from "../../core/reasoning/state-signature.js"
import type { HypothesisVersion } from "../../core/reasoning/types.js"

/**
 * v0.6 — the intelligence metadata envelope (F11). The persisted artifact is
 * `{ version, inputSignature, generatedAt, report }`; the deterministic
 * content is the `report` body. `inputSignature` proves the report is a pure
 * function of (A, referenceDate, budget); on match it is reused
 * byte-identically, otherwise recomputed from scratch — a stale report is
 * never treated as evidence.
 */

export interface IntelligenceInputs {
  research: unknown
  versions: HypothesisVersion[]
  referenceDate: string
  budget: ReasoningBudget
}

export function intelligenceInputSignature(inputs: IntelligenceInputs): string {
  const payload = JSON.stringify({
    research: stripVolatileForSignature(inputs.research),
    versions: stripVolatileForSignature(inputs.versions),
    referenceDate: inputs.referenceDate,
    budget: inputs.budget,
  })
  return createHash("sha256").update(payload).digest("hex")
}

export function buildIntelligenceEnvelope(
  inputs: IntelligenceInputs,
  report: ResearchIntelligenceReport,
): IntelligenceEnvelope {
  return {
    version: 1,
    inputSignature: intelligenceInputSignature(inputs),
    // generatedAt copies the report's (pinned referenceDate) so recomputes of
    // equal content stay byte-identical; the field is provenance, never signed.
    generatedAt: report.generatedAt,
    report,
  }
}

export function isIntelligenceEnvelope(value: unknown): value is IntelligenceEnvelope {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.version === 1 &&
    typeof candidate.inputSignature === "string" &&
    typeof candidate.generatedAt === "string" &&
    candidate.report !== null &&
    typeof candidate.report === "object"
  )
}
