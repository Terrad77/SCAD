import { CYCLE_PREFIX, DECISION_PREFIX, SESSION_PREFIX, STEP_PREFIX } from "./types.js"

/**
 * v0.6 — id derivation for the persistent cycle model. Every id is a pure
 * function of persisted state: `max(existing ids across cursor, ledger and the
 * version log) + 1`, so namespaces are collision-proof by construction (F10).
 * `STEP_000` is a sentinel (baseline import) and is never minted as a real
 * step.
 */

const STEP_START = 1

/** Parses the numeric suffix after `PREFIX_`; -1 for foreign ids. */
function suffixNumber(id: string, prefix: string): number {
  if (!id.startsWith(`${prefix}_`)) return -1
  const value = Number.parseInt(id.slice(prefix.length + 1), 10)
  if (Number.isNaN(value) || value < 0) return -1
  return value
}

export function stepNumber(id: string): number {
  return suffixNumber(id, STEP_PREFIX)
}

export function cycleNumber(id: string): number {
  const value = suffixNumber(id, CYCLE_PREFIX)
  return value < STEP_START ? 0 : value
}

export function sessionNumber(id: string): number {
  const value = suffixNumber(id, SESSION_PREFIX)
  return value < STEP_START ? 0 : value
}

export function decisionNumber(id: string): number {
  const value = suffixNumber(id, DECISION_PREFIX)
  return value < STEP_START ? 0 : value
}

export function makeStepId(nextStepNumber: number): string {
  return `${STEP_PREFIX}_${String(nextStepNumber).padStart(3, "0")}`
}

export function makeCycleId(sequence: number): string {
  return `${CYCLE_PREFIX}_${String(sequence).padStart(3, "0")}`
}

export function makeSessionId(sequence: number): string {
  return `${SESSION_PREFIX}_${String(sequence).padStart(3, "0")}`
}

export function makeDecisionId(sequence: number): string {
  return `${DECISION_PREFIX}_${String(sequence).padStart(3, "0")}`
}

/**
 * Next globally-unique step sequence. The `STEP_000` baseline import counts as
 * step 0, so a fresh session starts at 1.
 */
export function deriveNextStepNumber(stepIds: string[], versionStepIds: string[]): number {
  let max = 0
  for (const id of [...stepIds, ...versionStepIds]) {
    const value = stepNumber(id)
    if (value > max) max = value
  }
  return max + 1
}

/** Next globally-unique cycle sequence over ledger, cursor and legacy ids. */
export function deriveNextCycleNumber(cycleIds: Array<string | null>): number {
  let max = 0
  for (const id of cycleIds) {
    if (!id) continue
    const value = cycleNumber(id)
    if (value > max) max = value
  }
  return max + 1
}
