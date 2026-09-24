import type {
  ReasonCycleTrigger,
  ReasoningBudget,
  ReasoningCycle,
} from "../../core/reasoning/types.js"

/**
 * v0.6 — cycle eligibility gate (pure). A previously terminal state may open a
 * NEW cycle only through one of the five explicit triggers:
 *
 *   1. epistemic-change     A-only epistemic signature differs from the last
 *                           terminal cycle's endedWithEpistemicSignature (F7)
 *   2. temporal-change      an explicitly supplied referenceDate differs
 *   3. budget-change        explicit budget parameters differ
 *   4. governance-change    an unconsumed DecisionRecord targets a sealed cycle
 *   5. explicit-request     `reason --force` (never destructive, F14)
 *
 * Anything else re-returns the terminal state with no new history (repeated
 * STOP appends nothing). Pause resolution by an answer decision is handled by
 * the engine and resumes the SAME cycle — it is not this gate.
 */

export interface EligibilityInput {
  epistemicSignature: string
  referenceDate: string
  budget: ReasoningBudget
  pendingDecisionIds: string[]
  force: boolean
}

export type Eligibility =
  { eligible: true; trigger: ReasonCycleTrigger } | { eligible: false; trigger: null }

export function isEligibleForNewCycle(
  prev: ReasoningCycle | null,
  now: EligibilityInput,
): Eligibility {
  if (prev !== null) {
    if (now.force) return { eligible: true, trigger: "explicit-request" }

    if (
      prev.endedWithEpistemicSignature !== "" &&
      now.epistemicSignature !== prev.endedWithEpistemicSignature
    ) {
      return { eligible: true, trigger: "epistemic-change" }
    }
    if (now.referenceDate !== prev.referenceDate) {
      return { eligible: true, trigger: "temporal-change" }
    }
    if (!budgetEquals(prev.budget, now.budget)) {
      return { eligible: true, trigger: "budget-change" }
    }
    if (now.pendingDecisionIds.length > 0) {
      return { eligible: true, trigger: "governance-change" }
    }
  } else {
    // No prior terminal record (first run, or legacy not yet archived): a fresh
    // eligibility baseline opens with the first trigger.
    return { eligible: true, trigger: "first" }
  }

  return { eligible: false, trigger: null }
}

export function budgetEquals(a: ReasoningBudget, b: ReasoningBudget): boolean {
  return (
    a.maxSteps === b.maxSteps &&
    a.maxSources === b.maxSources &&
    a.maxQueries === b.maxQueries &&
    a.maxFollowUpRounds === b.maxFollowUpRounds
  )
}
