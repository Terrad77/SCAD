import type {
  ActionCandidate,
  PlanResult,
  ReasoningAction,
  ReasoningSituation,
  ResearchTarget,
  StoppingKind,
} from "../../core/reasoning/types.js"
import { CRITICAL_GAP_IMPORTANCE } from "../../core/evidence/weights.js"
import { researchKeyOf } from "./situation-assessment.js"

/**
 * Deterministic action-selection policy (v0.5). Never consults the LLM and
 * never mutates state: it purely ranks signals into a single next action or a
 * STOP verdict. Priorities (1 = highest urgency):
 *
 *   1 RESEARCH  — unresolved HIGH contradictions
 *   2 RESEARCH  — critical research gaps (importance >= 0.8)
 *   3 GENERATE  — the first hypothesis, or alternatives for weak ones
 *   4 REVISE    — partially supported / contradicted-with-support
 *   5 RESEARCH  — non-critical gaps and low-quality evidence
 *   6 REQUEST_HUMAN_INPUT — contradictions already researched this cycle
 *   7 REJECT    — contradicted with zero supporting evidence
 *
 * Candidate order is stable (tier, then repeat-key) so cycles replay exactly.
 */
export function planReasoning(situation: ReasoningSituation): PlanResult {
  if (situation.limitsExhausted) {
    return terminal(
      "STOP_RESEARCH_LIMIT",
      situation.stoppingReasons.join("; ") || "research limits were reached",
    )
  }

  const candidates: ActionCandidate[] = []
  const push = (tier: number, action: ReasoningAction, requiresHuman = false): void => {
    candidates.push({ tier, action, repeatKey: repeatKeyOf(action), requiresHuman })
  }
  const research = (
    subject: ResearchTarget["subject"],
    id: string,
    query: string,
  ): ReasoningAction => ({
    kind: "RESEARCH",
    target: { subject, id, query },
  })

  for (const c of situation.openContradictions) {
    if (c.gapId) push(1, research("gap", c.gapId, c.query))
    else if (c.subquestionId) push(1, research("subquestion", c.subquestionId, c.query))
    else if (c.evidenceId) push(1, research("evidence", c.evidenceId, c.query))
  }

  for (const g of situation.gaps) {
    if (g.importance >= CRITICAL_GAP_IMPORTANCE) push(2, research("gap", g.id, g.query))
  }

  if (situation.activeCount === 0 && situation.researchCompleted) {
    push(3, { kind: "GENERATE_HYPOTHESIS", targetHypothesis: null, basis: [] })
  }
  for (const v of situation.verifications) {
    const actionable =
      (v.status === "UNTESTED" || v.status === "INCONCLUSIVE") &&
      !situation.isAlternative.has(v.hypothesisId) &&
      (situation.alternativeCounts.get(v.hypothesisId) ?? 0) === 0
    if (actionable) {
      push(3, { kind: "GENERATE_HYPOTHESIS", targetHypothesis: v.hypothesisId, basis: [] })
    }
  }

  for (const v of situation.verifications) {
    if (
      v.status === "PARTIALLY_SUPPORTED" ||
      (v.status === "CONTRADICTED" && v.supportingEvidence.length > 0)
    ) {
      push(4, { kind: "REVISE_HYPOTHESIS", targetHypothesis: v.hypothesisId })
    }
  }

  for (const g of situation.gaps) {
    if (g.importance < CRITICAL_GAP_IMPORTANCE) push(5, research("gap", g.id, g.query))
  }
  for (const e of situation.lowQualityEvidence) {
    push(5, research("evidence", e.id, e.query))
  }

  if (situation.humanInTheLoop) {
    for (const c of situation.openContradictions) {
      const researched =
        (c.gapId && situation.researchAttemptedThisCycle.has(researchKeyOf("gap", c.gapId))) ||
        (c.subquestionId &&
          situation.researchAttemptedThisCycle.has(
            researchKeyOf("subquestion", c.subquestionId),
          )) ||
        (c.evidenceId &&
          situation.researchAttemptedThisCycle.has(researchKeyOf("evidence", c.evidenceId)))
      if (researched) {
        push(
          6,
          {
            kind: "REQUEST_HUMAN_INPUT",
            target: c.id,
            question: `Adjudicate the unresolved HIGH contradiction between claims ${c.claimA} and ${c.claimB}: ${c.query}`,
          },
          true,
        )
      }
    }
  }

  for (const v of situation.verifications) {
    if (v.status === "CONTRADICTED" && v.supportingEvidence.length === 0) {
      push(7, { kind: "REJECT_HYPOTHESIS", targetHypothesis: v.hypothesisId })
    }
  }

  const open = candidates
    .filter((c) => !situation.attemptedKeys.has(c.repeatKey))
    .sort((a, b) => a.tier - b.tier || a.repeatKey.localeCompare(b.repeatKey))
  if (open[0]) {
    return { terminating: false, candidate: open[0], action: open[0].action }
  }

  if (!situation.continueResearch) {
    return terminal(
      "STOP_CONFIDENT_ENOUGH",
      "research stopping criteria are satisfied: no open problem requires another iteration",
    )
  }
  if (candidates.some((c) => c.requiresHuman)) {
    return terminal(
      "STOP_HUMAN_REQUIRED",
      "the policy can only proceed after a human adjudicates the open contradiction",
    )
  }
  if (candidates.length > 0) {
    return terminal(
      "STOP_NO_ACTION",
      "every candidate action repeats an earlier step at an unchanged state signature; stopping to avoid a cycle",
    )
  }
  return terminal(
    "STOP_INCONCLUSIVE",
    "no candidate action is applicable yet the question remains open",
  )
}

export function repeatKeyOf(action: ReasoningAction): string {
  switch (action.kind) {
    case "RESEARCH":
      return researchKeyOf(action.target.subject, action.target.id)
    case "GENERATE_HYPOTHESIS":
      return `GENERATE_HYPOTHESIS|${action.targetHypothesis ?? ""}|`
    case "REVISE_HYPOTHESIS":
      return `REVISE_HYPOTHESIS|${action.targetHypothesis}|`
    case "REJECT_HYPOTHESIS":
      return `REJECT_HYPOTHESIS|${action.targetHypothesis}|`
    case "REQUEST_HUMAN_INPUT":
      return `REQUEST_HUMAN_INPUT|${action.target}|`
    case "STOP":
      return `STOP|${action.stoppingKind}`
  }
}

function terminal(stoppingKind: StoppingKind, reason: string): PlanResult {
  const action: ReasoningAction = { kind: "STOP", stoppingKind, reason }
  return { terminating: true, candidate: null, action, terminalReason: reason }
}
