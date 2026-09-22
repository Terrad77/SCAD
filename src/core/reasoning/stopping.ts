import { STOPPING_KINDS, type StoppingKind } from "./types.js"

/**
 * v0.5 — Stopping is an explicit, non-epistemic verdict. STOP never asserts a
 * claim, never flips a hypothesis status and never touches evidence. It only
 * explains *why* the cycle halts. STOP also never equals TRUE/FALSE: it is a
 * control verdict, not a confidence value.
 */

export const STOPPING_KIND_LABELS: Record<StoppingKind, string> = {
  STOP_CONFIDENT_ENOUGH: "Research is confident enough; no further work is required.",
  STOP_INCONCLUSIVE: "Genuine problems remain but no further deterministic step is available.",
  STOP_RESEARCH_LIMIT: "A resource budget/cap was reached, so continued research must stop.",
  STOP_NO_ACTION: "The cycle made no progress and would repeat identically.",
  STOP_HUMAN_REQUIRED: "The next step needs an operator decision, not more research.",
}

export function describeStopping(kind: StoppingKind): string {
  return STOPPING_KIND_LABELS[kind]
}

export function isStoppingKind(value: string): value is StoppingKind {
  return (STOPPING_KINDS as readonly string[]).includes(value)
}
