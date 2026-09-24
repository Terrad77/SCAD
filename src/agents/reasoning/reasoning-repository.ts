import type { MemoryStore } from "../../core/memory/json-memory.js"
import type { ResearchBundle } from "../../core/schemas.js"
import {
  DecisionsStoreSchema,
  ReasoningCursorEnvelopeSchema,
  ReasoningCycleSchema,
  ReasoningStateVersionSchema,
} from "../../core/reasoning/schemas.js"
import type {
  DecisionRecord,
  EpistemicDelta,
  HypothesisVersion,
  ReasoningAction,
  ReasonCycleTrigger,
  ReasoningBudget,
  ReasoningCursor,
  ReasoningCycle,
  ReasoningState,
  ReasoningStep,
  StoppingRecord,
} from "../../core/reasoning/types.js"
import {
  deriveNextStepNumber,
  makeSessionId,
  sessionNumber,
  stepNumber,
} from "../../core/reasoning/ids.js"
import { computeEpistemicSignature } from "../../core/reasoning/state-signature.js"

/**
 * v0.6 — persistence repository for the reasoning state: load/migrate the
 * control cursor, read/write the `reasoning-history` ledger (seed header,
 * then complete it with one atomic write at seal), append decision records,
 * and reconcile committed-but-unrecorded epistemic effects into synthesized
 * steps (commit-point recovery, §13).
 *
 * None of these writes go through an action write-scope: the ledger and
 * decisions are engine-level seams, never part of `ACTION_WRITE_SCOPE`.
 */

export interface LoadedReasoning {
  cursor: ReasoningCursor | null
  /** Present when the persisted file was a v0.5 `{version:1, state}` wrapper. */
  legacyState: ReasoningState | null
}

export async function loadReasoningCursor(memory: MemoryStore): Promise<LoadedReasoning> {
  const raw = await memory.readRaw("reasoning")
  if (raw === null) return { cursor: null, legacyState: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      "reasoning state is corrupt (unparseable JSON); refusing to reseed. Inspect reasoning.json.",
    )
  }

  const cursorEnvelope = ReasoningCursorEnvelopeSchema.safeParse(parsed)
  if (cursorEnvelope.success) {
    return { cursor: cursorEnvelope.data.state, legacyState: null }
  }

  const legacyEnvelope = ReasoningStateVersionSchema.safeParse(parsed)
  if (legacyEnvelope.success) {
    return { cursor: null, legacyState: legacyEnvelope.data.state }
  }

  throw new Error(
    "reasoning state has an unknown schema version; refusing to reinterpret it silently.",
  )
}

/** v0.5 → v0.6 in-memory migration of the control state (§14 #2). */
export function migrateLegacyReasoning(
  state: ReasoningState,
  versions: HypothesisVersion[],
  project: string,
  budget: ReasoningBudget,
): ReasoningCursor {
  const cycleId = state.cycleContext?.cycleId ?? "CYC_001"
  return {
    sessionId: "SSN_001",
    project,
    question: state.question,
    status: (state as { status: string }).status === "NEEDS_HUMAN" ? "PAUSED" : state.status,
    currentCycleId: cycleId,
    nextStepNumber: deriveNextStepNumber(
      state.steps.map((s) => s.id),
      versions.map((v) => v.createdAfterStep),
    ),
    previousCycleId: null,
    referenceDate: state.cycleContext?.referenceDate ?? "",
    budget: state.cycleContext?.budget ?? budget,
    stateSignature: state.cycleContext?.stateSignature ?? "",
    consumedDecisionIds: [],
    steps: state.steps,
    lastStopping: state.lastStopping === undefined ? null : state.lastStopping,
  }
}

export async function readReasoningCycles(memory: MemoryStore): Promise<ReasoningCycle[]> {
  const raw = await memory.readRaw("reasoning-history")
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      "reasoning-history is corrupt (unparseable JSON); refusing to reseed. Inspect the ledger.",
    )
  }
  const history = ReasoningCycleSchema.safeParse(parsed)
  if (history.success) return [history.data]

  // Accept the internal {version, cycles} wrapper.
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { version?: unknown }).version === 1 &&
    Array.isArray((parsed as { cycles?: unknown }).cycles)
  ) {
    const nested = (parsed as { cycles: unknown[] }).cycles
    const cycles: ReasoningCycle[] = []
    for (const entry of nested) {
      const cycle = ReasoningCycleSchema.safeParse(entry)
      if (!cycle.success) {
        throw new Error("reasoning-history contains an invalid cycle entry; refusing to proceed.")
      }
      cycles.push(cycle.data)
    }
    return cycles
  }
  throw new Error("reasoning-history has an unknown schema version; refusing to proceed.")
}

export async function writeReasoningCycles(
  memory: MemoryStore,
  cycles: ReasoningCycle[],
): Promise<void> {
  await memory.save("reasoning-history", { version: 1, cycles })
}

/** Idempotent ledger header write (F3): no-op if the cycle already exists. */
export async function seedCycleHeader(
  memory: MemoryStore,
  cycles: ReasoningCycle[],
  cycle: ReasoningCycle,
): Promise<void> {
  if (cycles.some((c) => c.cycleId === cycle.cycleId)) return
  await writeReasoningCycles(memory, [...cycles, cycle])
}

/** Completes a seeded header in one atomic write; idempotent. */
export async function sealCycle(
  memory: MemoryStore,
  cycles: ReasoningCycle[],
  cycle: ReasoningCycle,
): Promise<void> {
  const index = cycles.findIndex((c) => c.cycleId === cycle.cycleId)
  if (index === -1) {
    await writeReasoningCycles(memory, [...cycles, cycle])
    return
  }
  if (cycles[index]!.status !== "SEEDED") return // already sealed
  const next = [...cycles]
  next[index] = cycle
  await writeReasoningCycles(memory, next)
}

export async function readDecisions(memory: MemoryStore): Promise<DecisionRecord[]> {
  const raw = await memory.readRaw("decisions")
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("decisions is corrupt (unparseable JSON); refusing to proceed.")
  }
  const store = DecisionsStoreSchema.safeParse(parsed)
  if (!store.success) {
    throw new Error("decisions has an unknown schema version; refusing to proceed.")
  }
  return store.data.records
}

export async function appendDecision(
  memory: MemoryStore,
  records: DecisionRecord[],
  decision: DecisionRecord,
): Promise<DecisionRecord[]> {
  const next = [...records, decision]
  await memory.save("decisions", { version: 1, records: next })
  return next
}

/** Unconsumed decisions for the cursor (decisionId ∉ cursor.consumedDecisionIds). */
export function pendingDecisionsOf(
  decisions: DecisionRecord[],
  cursor: ReasoningCursor,
): DecisionRecord[] {
  const consumed = new Set(cursor.consumedDecisionIds)
  return decisions.filter((d) => !consumed.has(d.decisionId))
}

export interface CycleSnapshotInput {
  cursor: ReasoningCursor
  trigger: ReasonCycleTrigger
  humanInTheLoop: boolean
  sourceNonLegacy: "engine" | "legacy-v1"
  startedWithStateSignature: string
  endedWithStateSignature: string
  endedWithEpistemicSignature: string
  stopping: StoppingRecord | null
  delta: EpistemicDelta
}

/** Builds the sealed ledger row from the cursor + seal-time values. */
export function buildReasoningCycle(input: CycleSnapshotInput): ReasoningCycle {
  const steps =
    input.cursor.currentCycleId === null
      ? []
      : input.cursor.steps.filter((s) => s.cycleContext.cycleId === input.cursor.currentCycleId)
  return {
    cycleId: input.cursor.currentCycleId ?? "",
    status: "COMPLETED",
    trigger: input.trigger,
    referenceDate: input.cursor.referenceDate,
    budget: input.cursor.budget,
    humanInTheLoop: input.humanInTheLoop,
    startedWithStateSignature: input.startedWithStateSignature,
    endedWithStateSignature: input.endedWithStateSignature,
    endedWithEpistemicSignature: input.endedWithEpistemicSignature,
    steps,
    stopping: input.stopping,
    delta: input.delta,
    source: input.sourceNonLegacy,
  }
}

/** Deterministic per-cycle epistemic delta derived from steps + version log. */
export function computeDelta(
  steps: ReasoningStep[],
  versions: HypothesisVersion[],
): EpistemicDelta {
  const stepIds = new Set(steps.map((s) => s.id))
  const touched = versions.filter((v) => stepIds.has(v.createdAfterStep))
  return {
    producedVersionIds: touched
      .filter((v) => v.status !== "REJECTED" && !v.supersededByVersionId)
      .map((v) => v.versionId),
    supersededVersionIds: touched.filter((v) => v.supersededByVersionId).map((v) => v.versionId),
    rejectedVersionIds: touched.filter((v) => v.status === "REJECTED").map((v) => v.versionId),
    keysWritten: [
      ...new Set(steps.filter((s) => s.status === "COMPLETED").flatMap((s) => s.writes)),
    ],
  }
}

/** Next cycle sequence derives from the full ledger (+ legacy archive). */
export function nextCycleSequence(cycles: ReasoningCycle[]): number {
  let max = 0
  for (const cycle of cycles) {
    const value = Number.parseInt(cycle.cycleId.slice("CYC_".length), 10)
    if (!Number.isNaN(value) && value > max) max = value
  }
  return max + 1
}

/** Next session sequence over existing cursor ids. */
export function nextSessionSequence(cursor: ReasoningCursor | null): number {
  if (cursor === null) return 1
  return sessionNumber(cursor.sessionId) + 1
}

export function freshSessionId(cursor: ReasoningCursor | null): string {
  return makeSessionId(nextSessionSequence(cursor))
}

/**
 * Regressed-cursor recovery: the ledger (authoritative) already shows the
 * cursor's current cycle as COMPLETED — the cursor is reconstructed from the
 * sealed row instead of running the cycle again (F16).
 */
export function rebuildCursorFromLedger(
  cursor: ReasoningCursor,
  cycles: ReasoningCycle[],
  versions: HypothesisVersion[],
): ReasoningCursor | null {
  const sealed = cycles.find((c) => c.cycleId === cursor.currentCycleId && c.status === "COMPLETED")
  if (!sealed) return null
  const allSteps = cycles.flatMap((c) => c.steps)
  const stepIds = new Set<string>()
  const steps = allSteps.filter((s) => (stepIds.has(s.id) ? false : (stepIds.add(s.id), true)))
  return {
    ...cursor,
    status: "STOPPED",
    steps,
    nextStepNumber: deriveNextStepNumber(
      steps.map((s) => s.id),
      versions.map((v) => v.createdAfterStep),
    ),
    stateSignature: sealed.endedWithStateSignature,
    lastStopping: sealed.stopping,
  }
}

/** A-only epistemic signature over category-A state (eligibility baseline, F7). */
export function computeSessionEpistemicSignature(
  question: string,
  research: ResearchBundle | null,
  versions: HypothesisVersion[],
  activePointers: unknown[],
): string {
  return computeEpistemicSignature({
    question,
    research,
    versions,
    hypotheses: activePointers,
  })
}

/**
 * Reconciles committed-but-unrecorded epistemic effects (commit-point
 * recovery, F1/F2): a HypothesisVersion whose `createdAfterStep` is not
 * recorded, or a research query carrying a `createdAfterStep` marker, is
 * synthesized into a COMPLETED step. The action is never re-executed; the
 * reconstruction is derived entirely from persisted state.
 */
export function reconcileCursor(
  cursor: ReasoningCursor,
  cycles: ReasoningCycle[],
  versions: HypothesisVersion[],
  research: ResearchBundle | null,
  currentStateSignature: string,
): { cursor: ReasoningCursor; healed: number; notes: string[] } {
  const recorded = new Set<string>(cursor.steps.map((s) => s.id))
  for (const cycle of cycles) for (const step of cycle.steps) recorded.add(step.id)

  const cycleId = cursor.currentCycleId ?? "CYC_001"
  const synthesized: ReasoningStep[] = []

  // The v0.5 baseline import writes versions at the synthetic STEP_000 marker
  // that is deliberately NOT a recorded step. It is not a crash-recovered
  // effect (it happens deterministically at session start), so it must never
  // be synthesized into a step on resume/reconcile.
  const BASELINE_IMPORT_MARKER = "STEP_000"

  for (const version of versions) {
    if (version.createdAfterStep === BASELINE_IMPORT_MARKER) continue
    if (recorded.has(version.createdAfterStep)) continue
    const action = inferHypothesisAction(version)
    const step: ReasoningStep = {
      id: version.createdAfterStep,
      cycleContext: { cycleId, referenceDate: cursor.referenceDate },
      action,
      status: "COMPLETED",
      stateSignatureBefore: cursor.stateSignature,
      stateSignatureAfter: currentStateSignature,
      performedAt: cursor.referenceDate,
      writes: ["hypotheses", "hypothesis-versions", "intelligence"],
      notes: ["recovered: effect present, step reconstructed after crash"],
    }
    synthesized.push(step)
    recorded.add(version.createdAfterStep)
  }

  for (const query of research?.queries ?? []) {
    const marker = (query as { createdAfterStep?: string }).createdAfterStep
    if (!marker || recorded.has(marker)) continue
    const step: ReasoningStep = {
      id: marker,
      cycleContext: { cycleId, referenceDate: cursor.referenceDate },
      action: {
        kind: "RESEARCH",
        target: {
          subject: "subquestion",
          id: query.subquestionId ?? "PLAN_001",
          query: query.query,
        },
      },
      status: "COMPLETED",
      stateSignatureBefore: cursor.stateSignature,
      stateSignatureAfter: currentStateSignature,
      performedAt: cursor.referenceDate,
      writes: ["research", "intelligence"],
      notes: ["recovered: effect present, step reconstructed after crash"],
    }
    synthesized.push(step)
    recorded.add(marker)
  }

  if (synthesized.length === 0) return { cursor, healed: 0, notes: [] }

  const healedCursor: ReasoningCursor = {
    ...cursor,
    steps: [...cursor.steps, ...synthesized.sort((a, b) => stepNumber(a.id) - stepNumber(b.id))],
    nextStepNumber: deriveNextStepNumber(
      [...cursor.steps, ...synthesized].map((s) => s.id),
      versions.map((v) => v.createdAfterStep),
    ),
  }
  return {
    cursor: healedCursor,
    healed: synthesized.length,
    notes: synthesized.map(
      (s) => `recovered: ${s.action.kind} effect present, step ${s.id} reconstructed after crash`,
    ),
  }
}

export function inferHypothesisAction(version: HypothesisVersion): ReasoningAction {
  if (version.reason.startsWith("rejected:")) {
    return { kind: "REJECT_HYPOTHESIS", targetHypothesis: version.hypothesisId }
  }
  if (version.reason.startsWith("revised from")) {
    return { kind: "REVISE_HYPOTHESIS", targetHypothesis: version.hypothesisId }
  }
  if (version.reason === "generated as the first hypothesis") {
    return { kind: "GENERATE_HYPOTHESIS", targetHypothesis: null, basis: [] }
  }
  if (version.reason.startsWith("alternative explanation of")) {
    return {
      kind: "GENERATE_HYPOTHESIS",
      targetHypothesis: version.parentVersionId
        ? stripHypothesisId(version.parentVersionId)
        : version.hypothesisId,
      basis: [],
    }
  }
  return { kind: "GENERATE_HYPOTHESIS", targetHypothesis: version.hypothesisId, basis: [] }
}

/** Builds a read-only legacy archive entry (source legacy-v1). */
export function buildLegacyArchiveCycle(
  state: ReasoningState,
  cycleId: string,
  versions: HypothesisVersion[],
  referenceDate: string,
  budget: ReasoningBudget,
  humanInTheLoop: boolean,
  epistemicSignature: string,
): ReasoningCycle {
  return {
    cycleId,
    status: "COMPLETED",
    trigger: "first",
    referenceDate: state.cycleContext?.referenceDate ?? referenceDate,
    budget: state.cycleContext?.budget ?? budget,
    humanInTheLoop,
    startedWithStateSignature: state.cycleContext?.stateSignature ?? "",
    endedWithStateSignature: state.cycleContext?.stateSignature ?? "",
    endedWithEpistemicSignature: epistemicSignature,
    steps: state.steps,
    stopping: state.lastStopping ?? null,
    delta: computeDelta(state.steps, versions),
    source: "legacy-v1",
  }
}

function stripHypothesisId(versionId: string): string {
  const marker = versionId.lastIndexOf("_V")
  return marker === -1 ? versionId : versionId.slice(0, marker)
}
