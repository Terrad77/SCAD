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

export function stripVolatileForSignature<T>(value: T, depth = 0): T {
  if (Array.isArray(value))
    return value.map((item) => stripVolatileForSignature(item, depth + 1)) as T
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (depth >= 1 && key === "accessedAt") continue
      out[key] = stripVolatileForSignature(child, depth + 1)
    }
    return out as T
  }
  return value
}

/**
 * v0.6 — A-only epistemic signature used by the cycle eligibility gate (F7).
 *
 * It signs only category-A state — `question`, `research` (volatile-elided),
 * the hypothesis version log and the active hypothesis pointers — and
 * explicitly excludes `intelligence`, `referenceDate`, `budget`, ids and audit
 * timestamps, so derived re-analysis (B), date/budget changes and fetch
 * metadata can never masquerade as epistemic change. The full state signature
 * still drives the within-cycle loop guard.
 */
export function computeEpistemicSignature(input: {
  question: string
  research: unknown
  versions: unknown[]
  hypotheses: unknown[]
}): string {
  const payload = JSON.stringify({
    question: input.question,
    research: stripVolatileForSignature(input.research),
    versions: stripVolatileForSignature(input.versions),
    hypotheses: stripVolatileForSignature(input.hypotheses),
  })
  return createHash("sha256").update(payload).digest("hex")
}

export function computeStateSignature(input: SignatureInput): string {
  const payload = JSON.stringify({
    question: input.question,
    research: stripVolatileForSignature(input.research),
    intelligence: stripVolatileForSignature(input.intelligence),
    hypotheses: stripVolatileForSignature(input.hypotheses),
    versions: stripVolatileForSignature(input.versions),
    referenceDate: input.referenceDate,
  })
  return createHash("sha256").update(payload).digest("hex")
}
