import type { Hypothesis, HypothesesOutput, HypothesisVerification } from "../schemas.js"
import type { ResearchIntelligenceReport } from "../schemas.js"

/**
 * v0.5 + v0.6 — Reasoning & Hypothesis Evolution domain types.
 *
 * v0.6 adds the persistent cycle model: the `reasoning` key becomes a version-2
 * ReasoningCursor (session identity, next step number, consumed decisions), a
 * separate `reasoning-history` ledger holds one sealed ReasoningCycle per
 * cycle, `decisions` holds durable governances records, and `intelligence` is
 * persisted inside an explicit envelope (`IntelligenceEnvelope`).
 *
 * The reasoning cycle is a decision–effect loop over the epistemic state. Two
 * kinds of state exist and are kept apart:
 *
 *   epistemic:  research, intelligence, hypotheses, hypothesis-versions
 *   control:    reasoning (the step log), approved (governance decisions)
 *
 * Control state may *describe* the epistemic state, but never silently
 * rewrites it. Actions carry an explicit write-scope that is physically
 * enforced by the persistence layer (`ScopedMemory`).
 */

export const EMPTY_HYPOTHESES: HypothesesOutput = { hypotheses: [] }

export const STEP_PREFIX = "STEP"
export const CYCLE_PREFIX = "CYC"
export const SESSION_PREFIX = "SSN"
export const DECISION_PREFIX = "DEC"

export const REASONING_ACTION_KINDS = [
  "RESEARCH",
  "GENERATE_HYPOTHESIS",
  "REVISE_HYPOTHESIS",
  "REJECT_HYPOTHESIS",
  "REQUEST_HUMAN_INPUT",
  "STOP",
] as const
export type ReasoningActionKind = (typeof REASONING_ACTION_KINDS)[number]

export const STOPPING_KINDS = [
  "STOP_CONFIDENT_ENOUGH",
  "STOP_INCONCLUSIVE",
  "STOP_RESEARCH_LIMIT",
  "STOP_NO_ACTION",
  "STOP_HUMAN_REQUIRED",
] as const
export type StoppingKind = (typeof STOPPING_KINDS)[number]

export const STEP_STATUSES = ["COMPLETED", "BLOCKED", "SKIPPED", "FAILED"] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

/** v0.6: PAUSED replaces the v0.5 NEEDS_HUMAN terminal-lookalike. */
export const REASONING_STATUSES = ["RUNNING", "PAUSED", "STOPPED"] as const
export type ReasoningStatus = (typeof REASONING_STATUSES)[number]

export const REASON_CYCLE_TRIGGERS = [
  "first",
  "epistemic-change",
  "temporal-change",
  "budget-change",
  "governance-change",
  "explicit-request",
] as const
export type ReasonCycleTrigger = (typeof REASON_CYCLE_TRIGGERS)[number]

/**
 * Ledger cycle statuses. `SEEDED` is the pre-seal header row written at cycle
 * start (idempotent, before any epistemic action); `COMPLETED` / `PAUSED` /
 * `RECOVERED` are terminal/owner-abandoned seals (F3).
 */
export const REASON_CYCLE_STATUSES = ["SEEDED", "COMPLETED", "PAUSED", "RECOVERED"] as const
export type ReasonCycleStatus = (typeof REASON_CYCLE_STATUSES)[number]

export const DECISION_RESPONSES = [
  "approved",
  "rejected",
  "modified",
  "regenerate",
  "answer",
] as const
export type DecisionResponse = (typeof DECISION_RESPONSES)[number]

/**
 * Values pinned once per reasoning cycle. `referenceDate` is fixed for the
 * whole cycle so every deterministic recompute (intelligence, signatures) is
 * reproducible for the same epistemic state.
 */
export interface CycleContext {
  cycleId: string
  referenceDate: string
  budget: {
    maxSteps: number
    maxSources: number
    maxQueries: number
    maxFollowUpRounds: number
  }
  /** sha256 of the epistemic state at cycle start (loop-guard baseline). */
  stateSignature: string
}

/** The subject a RESEARCH action aims new evidence gathering at. */
export interface ResearchTarget {
  subject: "gap" | "subquestion" | "evidence"
  id: string
  query: string
}

export type ReasoningAction =
  | { kind: "RESEARCH"; target: ResearchTarget }
  | { kind: "GENERATE_HYPOTHESIS"; targetHypothesis: string | null; basis: string[] }
  | { kind: "REVISE_HYPOTHESIS"; targetHypothesis: string }
  | { kind: "REJECT_HYPOTHESIS"; targetHypothesis: string }
  | { kind: "REQUEST_HUMAN_INPUT"; target: string; question: string }
  | { kind: "STOP"; stoppingKind: StoppingKind; reason: string }

export interface ReasoningStep {
  id: string
  cycleContext: {
    cycleId: string
    referenceDate: string
  }
  action: ReasoningAction
  status: StepStatus
  stateSignatureBefore: string
  stateSignatureAfter: string
  /** Pinned cycle time (deterministic replay, not wall-clock). */
  performedAt: string
  /** Memory keys this step actually wrote (subset of its write-scope). */
  writes: string[]
  notes: string[]
}

/**
 * One immutable entry in the hypothesis version log. The versioned record
 * carries the full v0.4 Hypothesis shape plus version bookkeeping. Active
 * hypotheses in the `hypotheses` store are pointers to the latest version.
 */
export interface HypothesisVersion extends Hypothesis {
  versionId: string
  hypothesisId: string
  version: number
  parentVersionId?: string
  supersededByVersionId?: string
  /** Why this version exists (generated / revised / rejected…). */
  reason: string
  /** The reasoning step that produced this version. */
  createdAfterStep: string
}

export interface StoppingRecord {
  stoppingKind: StoppingKind
  reason: string
  at: string
}

/** Control state of the reasoning engine, persisted under `reasoning`. */
export interface ReasoningState {
  project: string
  question: string
  cycleContext: CycleContext | null
  steps: ReasoningStep[]
  lastStopping: StoppingRecord | null
  status: ReasoningStatus
}

/** v0.6 — resource caps pinned once per cycle (part of cycle identity). */
export interface ReasoningBudget {
  maxSteps: number
  maxSources: number
  maxQueries: number
  maxFollowUpRounds: number
}

/**
 * v0.6 — the durable control cursor persisted under `reasoning`
 * (`{ version: 2, state: ReasonCursor }`). One cursor per session
 * (project + question); steps keep the full session log across cycles so the
 * CLI export and the returned `ReasoningState` view stay full-artifact.
 */
export interface ReasoningCursor {
  /** SSN_00N, minted once per project+question (changing the question is a new session). */
  sessionId: string
  project: string
  question: string
  status: ReasoningStatus
  currentCycleId: string | null
  /** Globally unique step ids (never restart across cycles). */
  nextStepNumber: number
  previousCycleId: string | null
  referenceDate: string
  budget: ReasoningBudget
  /** Signed epistemic+derived state at cycle start (loop-guard baseline). */
  stateSignature: string
  /** Governance decisions applied at most once (F8). */
  consumedDecisionIds: string[]
  steps: ReasoningStep[]
  lastStopping: StoppingRecord | null
}

/** v0.6 — cached derived projection computed at seal; recomputable from steps + log. */
export interface EpistemicDelta {
  producedVersionIds: string[]
  supersededVersionIds: string[]
  rejectedVersionIds: string[]
  keysWritten: string[]
}

/**
 * v0.6 — one ledger entry in `reasoning-history` (`{ version: 1, cycles }`).
 * Seeded as a header (status SEEDED) before any epistemic action, completed in
 * a single atomic write at seal. Sealed entries are immutable.
 */
export interface ReasoningCycle {
  cycleId: string
  status: ReasonCycleStatus
  trigger: ReasonCycleTrigger
  referenceDate: string
  budget: ReasoningBudget
  /** Pinned control flag in cycle identity (F12). */
  humanInTheLoop: boolean
  startedWithStateSignature: string
  endedWithStateSignature: string
  /** A-only epistemic signature; the eligibility baseline for the next cycle (F7). */
  endedWithEpistemicSignature: string
  steps: ReasoningStep[]
  stopping: StoppingRecord | null
  delta: EpistemicDelta
  source: "engine" | "legacy-v1"
}

/** v0.6 — durable governance record in `decisions` (`{ version: 1, records }`, append-only). */
export interface DecisionRecord {
  decisionId: string
  /** The action kind the decision governs (e.g. REQUEST_HUMAN_INPUT). */
  kind: ReasoningActionKind
  /** Human-readable subject (typically the request step id or action label). */
  subject: string
  /** The proposed action, captured for audit. Never a policy input (F8). */
  proposedAction?: unknown
  response: DecisionResponse
  /** Human-readable detail for `answer` / `rejected` / `modified`. */
  responseDetail: string | null
  cycleId: string
  stepId: string
  /** Volatile provenance; never signed (deterministic pinning uses the cycle date). */
  createdAt: string
}

/**
 * v0.6 — metadata envelope persisted with `intelligence`, separating the
 * deterministic report body from audit metadata (F11). `inputSignature` =
 * sha256(research, versions, referenceDate, budget); on match the report is
 * reused byte-identically, else recomputed and re-persisted.
 */
export interface IntelligenceEnvelope {
  version: 1
  inputSignature: string
  generatedAt: string
  report: ResearchIntelligenceReport
}

/** The full derived view the action-selection policy reasons over. */
export interface ReasoningSituation {
  question: string
  researchCompleted: boolean
  /** Derived verifications of the active hypotheses against current research. */
  verifications: HypothesisVerification[]
  /** Competing explanations already generated per hypothesis. */
  alternativeCounts: Map<string, number>
  /** Hypotheses that are themselves generated alternatives (no deeper nesting). */
  isAlternative: Set<string>
  /** Number of active (non-rejected) hypotheses. */
  activeCount: number
  /**
   * Action keys already attempted at the exact current state signature (the
   * loop guard's view: repeating these adds nothing). Includes actions blocked
   * by the approval gate in earlier cycles at the same signature (§18.12
   * foreclosure) — a rejection is never auto-replayed.
   */
  attemptedKeys: Set<string>
  /** RESEARCH targets attempted earlier in this cycle regardless of signature. */
  researchAttemptedThisCycle: Set<string>
  cycleContext: CycleContext
  /** `true` once research limits force the cycle to stop. */
  limitsExhausted: boolean
  /** `true` when a genuine problem remains that research cannot resolve alone. */
  continueResearch: boolean
  humanInTheLoop: boolean
  /** Why research would continue/stop, from the deterministic stopping criteria. */
  stoppingReasons: string[]
  /** Unresolved HIGH contradictions with a concrete research query. */
  openContradictions: ContradictionSignal[]
  /** All research gaps with a ready query (critical and non-critical). */
  gaps: GapSignal[]
  /** Evidence items whose assessed quality needs a targeted follow-up. */
  lowQualityEvidence: LowQualitySignal[]
}

export interface ContradictionSignal {
  id: string
  claimA: string
  claimB: string
  analysis: string
  /** Preferred target of a RESEARCH action for this conflict, when derivable. */
  gapId: string | null
  subquestionId: string | null
  evidenceId: string | null
  query: string
}

export interface GapSignal {
  id: string
  importance: number
  query: string
}

export interface LowQualitySignal {
  id: string
  overall: number
  query: string
}

/** A candidate action produced by the policy, with a deterministic key. */
export interface ActionCandidate {
  tier: number
  action: ReasoningAction
  /** Stable key identifying (kind, subject, id) for the loop guard. */
  repeatKey: string
  /** Candidate that can only be resolved by an operator, not more research. */
  requiresHuman?: boolean
}

export interface PlanResult {
  terminating: boolean
  candidate: ActionCandidate | null
  action: ReasoningAction
  /** Set when terminating with no candidate, giving the deterministic reason. */
  terminalReason?: string
}
