import { createHash } from "node:crypto"
import { stripVolatileForSignature } from "../reasoning/state-signature.js"
import type { ReasoningContext } from "./types.js"

/**
 * v0.7 — deterministic signatures for the reasoning→production handoff.
 *
 * `inputSignature` signs everything the context is DERIVED from (epistemic
 * state + reasoning result + pinned reference date). It is the staleness key:
 * a production artifact whose `inputSignature` no longer matches the current
 * context is STALE (§18).
 *
 * `contextSignature` signs the context body itself (the signature field
 * excluded), so any accidental hidden input shows up as a changed hash — the
 * serialization is a pure function of the visible fields.
 *
 * Volatile fetch metadata (`accessedAt`) is elided, matching the v0.5/v0.6
 * state signatures, so identical evidence produced by different runs signs
 * identically.
 */

export interface ReasoningContextSignatureInput {
  question: string
  research: unknown
  hypotheses: unknown
  verifications: unknown[]
  intelligence: unknown
  decision: unknown
  referenceDate: string
}

export function reasoningContextInputSignature(input: ReasoningContextSignatureInput): string {
  return sha256({
    question: input.question,
    research: stripVolatileForSignature(input.research),
    hypotheses: stripVolatileForSignature(input.hypotheses),
    verifications: stripVolatileForSignature(input.verifications),
    intelligence: stripVolatileForSignature(input.intelligence),
    decision: stripVolatileForSignature(input.decision),
    referenceDate: input.referenceDate,
  })
}

/** sha256 over the whole context except the signature field itself. */
export function computeReasoningContextSignature(
  context: Omit<ReasoningContext, "contextSignature">,
) {
  return sha256(context)
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/**
 * v0.7 (H3) — the content signature of a production artifact.
 *
 * The `production` provenance block is EXCLUDED: it records the very signatures
 * this function produces, so including it would make the artifact sign itself
 * into an unsatisfiable fixed point. Everything else — title, sections,
 * sentences, shots — is signed, so any edit to the film itself is detectable
 * even when the reasoning context is untouched.
 */
export function artifactContentSignature(artifact: unknown): string {
  if (artifact === null || typeof artifact !== "object") return sha256(artifact)
  const { production: _production, ...body } = artifact as Record<string, unknown>
  return sha256(body)
}

/**
 * v0.7 (H3) — validates a persisted `ReasoningContext` against its own
 * signature. A hand-edited or truncated context is CORRUPT, not merely stale:
 * production must not quietly derive a film from a handoff whose body no
 * longer matches the identity it claims.
 */
export function verifyContextIntegrity(context: ReasoningContext | null): {
  valid: boolean
  expected: string | null
  actual: string
} {
  if (context === null) return { valid: false, expected: null, actual: "" }
  const { contextSignature, ...body } = context
  const expected = computeReasoningContextSignature(body)
  return { valid: expected === contextSignature, expected, actual: contextSignature }
}
