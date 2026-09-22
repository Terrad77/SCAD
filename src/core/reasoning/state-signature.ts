import { createHash } from "node:crypto"

/**
 * v0.5 — Deterministic epistemic state signature.
 *
 * The signature is a sha256 over the pieces of state that drive decisions.
 * It is used as the loop guard: repeating a (kind,target) action while the
 * signature is unchanged can only reproduce the same outcome, so the policy
 * drops it. Volatile bookkeeping (`accessedAt`) is stripped so the signature
 * is a pure function of the *evidence* — identical bundles produced by
 * different runs of the research engine must score identically.
 */

export interface SignatureInput {
  question: string
  /** Deterministic projection of the research bundle. */
  research: unknown
  intelligence: unknown
  /** Active hypothesis pointers and the version log (immutable). */
  hypotheses: unknown[]
  versions: unknown[]
  referenceDate: string
}

function stripVolatile<T>(value: T, depth = 0): T {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, depth + 1)) as T
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (depth >= 1 && key === "accessedAt") continue
      out[key] = stripVolatile(child, depth + 1)
    }
    return out as T
  }
  return value
}

export function computeStateSignature(input: SignatureInput): string {
  const payload = JSON.stringify({
    question: input.question,
    research: stripVolatile(input.research),
    intelligence: stripVolatile(input.intelligence),
    hypotheses: stripVolatile(input.hypotheses),
    versions: stripVolatile(input.versions),
    referenceDate: input.referenceDate,
  })
  return createHash("sha256").update(payload).digest("hex")
}
