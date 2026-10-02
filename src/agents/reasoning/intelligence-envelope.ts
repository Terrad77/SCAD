import { createHash } from "node:crypto"
import type { ResearchIntelligenceReport } from "../../core/schemas.js"
import { ResearchIntelligenceReportSchema } from "../../core/schemas.js"
import type {
  IntelligenceEnvelope,
  IntelligenceLimits,
  ReasoningBudget,
} from "../../core/reasoning/types.js"
import { stripVolatileForSignature } from "../../core/reasoning/state-signature.js"
import type { HypothesisVersion } from "../../core/reasoning/types.js"

/**
 * v0.6 — the intelligence metadata envelope (F11). The persisted artifact is
 * `{ version, inputSignature, generatedAt, report }`; the deterministic
 * content is the `report` body. `inputSignature` proves the report is a pure
 * function of (A, referenceDate, budget, limits); on match it is reused
 * byte-identically, otherwise recomputed from scratch — a stale report is
 * never treated as evidence.
 *
 * v0.7 — `resolveIntelligence` is the ONE place that answers "is the persisted
 * intelligence still valid?". Both writers' readers (the reasoning cycle and the
 * production context builder) go through it, so they can never disagree about
 * freshness, and the production side can obtain a guaranteed-fresh report
 * *without persisting anything*.
 */

export interface IntelligenceInputs {
  research: unknown
  versions: HypothesisVersion[]
  referenceDate: string
  budget: ReasoningBudget
  limits?: IntelligenceLimits
}

export function intelligenceInputSignature(inputs: IntelligenceInputs): string {
  const payload = {
    research: stripVolatileForSignature(inputs.research),
    versions: stripVolatileForSignature(inputs.versions),
    referenceDate: inputs.referenceDate,
    budget: inputs.budget,
    // Only present in the payload when limits were actually in force, so a
    // v0.6 envelope (signed without limits) still validates byte-identically.
    ...(inputs.limits === undefined ? {} : { limits: inputs.limits }),
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
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
    inputs: {
      referenceDate: inputs.referenceDate,
      budget: inputs.budget,
      ...(inputs.limits === undefined ? {} : { limits: inputs.limits }),
    },
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

export interface ReferenceDateResolutionInput {
  /** The run-pinned value supplied by the caller (may be a fresh clock on resume). */
  runReferenceDate?: string
  /** The persisted reasoning cursor, if one exists. */
  cursor?: { referenceDate?: string } | null
  /** The raw persisted `intelligence` value, or null. */
  persisted?: unknown
}

/**
 * v0.7 (H1) — ONE reference-date resolution order, shared by the epistemic
 * preparation phase and the production context builder so the two signatures
 * can never disagree.
 *
 * Persisted state wins over the run value, deliberately. A resumed run re-enters
 * with a NEW wall clock; if that were used, every production artifact would
 * report staleness after a crash-and-resume even though not one epistemic byte
 * had changed. Changing the reference date is a real epistemic act, performed by
 * the reasoning cycle seeding a new cursor with a new pinned date — not a
 * side effect of restarting a process.
 *
 * Order: persisted cursor → envelope-recorded date → report `generatedAt` →
 * the run value → a clock (only when there is nothing persisted at all).
 */
export function resolveReferenceDate(input: ReferenceDateResolutionInput): string {
  return (
    nonEmpty(input.cursor?.referenceDate) ??
    recordedReferenceDate(input.persisted) ??
    reportGeneratedAt(input.persisted) ??
    nonEmpty(input.runReferenceDate) ??
    new Date().toISOString()
  )
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function recordedReferenceDate(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const value = (raw as { inputs?: { referenceDate?: unknown } }).inputs?.referenceDate
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function reportGeneratedAt(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const candidate = raw as { report?: { generatedAt?: unknown }; generatedAt?: unknown }
  const value = candidate.report?.generatedAt ?? candidate.generatedAt
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// Freshness resolution (v0.7)
// ---------------------------------------------------------------------------

export type IntelligenceSource = "envelope" | "raw-legacy" | "absent"

export interface IntelligenceResolution {
  /** Always a schema-valid report — recomputed in memory when not fresh. */
  report: ResearchIntelligenceReport | null
  /** The signature the returned report corresponds to, or null when absent. */
  signature: string | null
  /** True only when the PERSISTED artifact was reused as-is. */
  fresh: boolean
  source: IntelligenceSource
  /**
   * Why the persisted artifact could not be trusted. Null when `fresh`.
   * `unverifiable-inputs` is the important one: a legacy envelope with no
   * recorded reference date / budget cannot be re-signed without guessing, so
   * it is treated exactly like a stale one.
   */
  staleReason: "signature-mismatch" | "unverifiable-inputs" | "invalid-report" | null
}

export interface ResolveIntelligenceInput {
  research: unknown
  versions: HypothesisVersion[]
  /**
   * The reference date / budget / limits to validate against. Callers MUST
   * supply the values that were actually in force — the persisted ones. A
   * run-time clock is never substituted here.
   */
  referenceDate: string
  budget: ReasoningBudget
  limits?: IntelligenceLimits
  /** The raw persisted `intelligence` value, or null. */
  persisted: unknown
  /** Deterministic recomputation, used only when the persisted one is not fresh. */
  recompute: (
    inputs: Required<Pick<IntelligenceInputs, "referenceDate" | "budget">>,
  ) => ResearchIntelligenceReport
}

/**
 * The single freshness decision for the intelligence artifact.
 *
 * A persisted envelope is reused only when its `inputSignature` equals the
 * signature recomputed from (research, versions, the *recorded* reference date,
 * the *recorded* budget, the *recorded* limits). Anything else — a changed
 * epistemic state, a missing or unrecorded input set, an unparseable report —
 * yields a freshly computed report and `fresh: false`, and the caller decides
 * whether to persist it (epistemic preparation) or keep it in memory
 * (production).
 */
export function resolveIntelligence(input: ResolveIntelligenceInput): IntelligenceResolution {
  if (input.persisted === null || input.persisted === undefined) {
    // Nothing persisted yet. That is not a reason to withhold a report: the
    // intelligence engine is deterministic, so the correct value is derivable
    // from the current inputs right now. It is reported as NOT fresh, and it is
    // the caller that decides whether to persist it (the epistemic preparation
    // phase does; production keeps it in memory and writes nothing).
    return {
      report: recomputeWith(input),
      signature: signatureOf(input),
      fresh: false,
      source: "absent",
      staleReason: null,
    }
  }

  if (!isIntelligenceEnvelope(input.persisted)) {
    // A bare report (v0.4/v0.5) carries no signature at all. It is never
    // treated as evidence-of-freshness: recompute, and let the owner persist
    // a properly signed envelope.
    const parsed = ResearchIntelligenceReportSchema.safeParse(input.persisted)
    if (!parsed.success) {
      return {
        report: recomputeWith(input),
        signature: signatureOf(input),
        fresh: false,
        source: "raw-legacy",
        staleReason: "invalid-report",
      }
    }
    return {
      report: recomputeWith(input),
      signature: signatureOf(input),
      fresh: false,
      source: "raw-legacy",
      staleReason: "signature-mismatch",
    }
  }

  const envelope = input.persisted
  const report = ResearchIntelligenceReportSchema.safeParse(envelope.report)
  if (!report.success) {
    return {
      report: recomputeWith(input),
      signature: signatureOf(input),
      fresh: false,
      source: "envelope",
      staleReason: "invalid-report",
    }
  }

  // v0.7 (H1): validate against the CURRENT inputs in force — the ones the
  // caller read from persisted state, never a clock and never the envelope's
  // own recorded values. Trusting the recorded values would let a report signed
  // under a different budget, reference date or limit re-validate itself after
  // those very inputs changed, which is exactly the drift this check exists to
  // catch. The recorded set is provenance: a divergence is staleness.
  const signature = signatureOf(input)

  if (envelope.inputSignature !== signature) {
    return {
      report: recomputeWith(input),
      signature,
      fresh: false,
      source: "envelope",
      staleReason: recordedInputsDiverged(envelope.inputs, input)
        ? "signature-mismatch"
        : "unverifiable-inputs",
    }
  }

  return { report: report.data, signature, fresh: true, source: "envelope", staleReason: null }
}

/**
 * Distinguishes "we re-signed and it did not match" from "we could not re-sign
 * at all". A v0.6 envelope records no inputs, so a mismatch there means the
 * epistemic state itself moved and the provenance of the signature is unknown.
 */
function recordedInputsDiverged(
  recorded: IntelligenceEnvelope["inputs"] | undefined,
  current: ResolveIntelligenceInput,
): boolean {
  if (recorded === undefined) return false
  if (recorded.referenceDate !== current.referenceDate) return true
  if (JSON.stringify(recorded.budget) !== JSON.stringify(current.budget)) return true
  return JSON.stringify(recorded.limits ?? null) !== JSON.stringify(current.limits ?? null)
}

function recomputeWith(input: ResolveIntelligenceInput): ResearchIntelligenceReport {
  return input.recompute({ referenceDate: input.referenceDate, budget: input.budget })
}

/** The signature of the CURRENT inputs — the only one ever compared against. */
function signatureOf(input: ResolveIntelligenceInput): string {
  return intelligenceInputSignature({
    research: input.research,
    versions: input.versions,
    referenceDate: input.referenceDate,
    budget: input.budget,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  })
}
