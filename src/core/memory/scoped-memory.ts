import type { MemoryStore } from "./json-memory.js"
import type { ReasoningActionKind } from "../reasoning/types.js"

/**
 * v0.5 — Physical write-scope enforcement.
 *
 * The epistemic/control boundary is not a convention: every action is paired
 * with a declared write-scope, and the persistence layer refuses any write
 * outside it. This makes it impossible for the reasoning engine to silently
 * change claims, evidence, hypotheses or approvals from the wrong action.
 *
 * Scopes:
 *   RESEARCH (epistemic)       → research, intelligence
 *   GENERATE/REVISE/REJECT     → hypotheses, hypothesis-versions, intelligence
 *   STOP / REQUEST_HUMAN_INPUT → reasoning (control only)
 *
 * `intelligence` is the deterministic derivative of the epistemic state, so
 * both epistemic write-groups may refresh it (Scenario F determinism). The
 * control scope never touches any epistemic key, and no scope touches the
 * others' exclusive keys.
 */

export const EPISTEMIC_WRITE_KEYS = [
  "research",
  "intelligence",
  "hypotheses",
  "hypothesis-versions",
] as const

export const CONTROL_WRITE_KEYS = ["reasoning"] as const

export const ACTION_WRITE_SCOPE: Record<ReasoningActionKind, readonly string[]> = {
  RESEARCH: ["research", "intelligence"],
  GENERATE_HYPOTHESIS: ["hypotheses", "hypothesis-versions", "intelligence"],
  REVISE_HYPOTHESIS: ["hypotheses", "hypothesis-versions", "intelligence"],
  REJECT_HYPOTHESIS: ["hypotheses", "hypothesis-versions", "intelligence"],
  REQUEST_HUMAN_INPUT: ["reasoning"],
  STOP: ["reasoning"],
}

export class WriteScopeViolationError extends Error {
  constructor(
    readonly key: string,
    readonly scope: readonly string[],
  ) {
    super(
      `write-scope violation: "${key}" is outside the allowed write scope [${scope.join(", ")}]`,
    )
    this.name = "WriteScopeViolationError"
  }
}

/**
 * MemoryStore decorator that throws on any save/remove outside its declared
 * scope. Reads always pass through. `enforce` can be disabled for stores that
 * only read, keeping the guard cheap while preserving full fan-in.
 */
export class ScopedMemory implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly scope: ReadonlySet<string>,
    private readonly enforce = true,
  ) {}

  async save<T>(key: string, value: T): Promise<void> {
    this.assertWritable(key)
    await this.inner.save(key, value)
  }

  async remove(key: string): Promise<void> {
    this.assertWritable(key)
    await this.inner.remove(key)
  }

  async get<T>(key: string): Promise<T | null> {
    return this.inner.get<T>(key)
  }

  async readRaw(key: string): Promise<string | null> {
    return this.inner.readRaw(key)
  }

  async search(query: string): Promise<unknown[]> {
    return this.inner.search(query)
  }

  async keys(): Promise<string[]> {
    return this.inner.keys()
  }

  private assertWritable(key: string): void {
    if (!this.enforce) return
    if (!this.scope.has(key)) throw new WriteScopeViolationError(key, [...this.scope])
  }
}

export function readScopeFor(kind: ReasoningActionKind): ReadonlySet<string> {
  return new Set(ACTION_WRITE_SCOPE[kind])
}
