import type { MemoryStore } from "../../core/memory/json-memory.js"
import { ScopedMemory, readScopeFor } from "../../core/memory/scoped-memory.js"
import { AutoApprover, type ApprovalGate } from "../../core/pipeline.js"
import type { StructuredAgent } from "../../core/structured-agent.js"
import type { SearchProvider } from "../../providers/search/search-provider.js"
import type {
  Hypothesis,
  HypothesisVerification,
  ResearchBundle,
  ResearchIntelligenceReport,
} from "../../core/schemas.js"
import type { HypothesisVersion } from "../../core/reasoning/types.js"
import type {
  CycleContext,
  DecisionRecord,
  ReasoningAction,
  ReasoningActionKind,
  ReasoningCursor,
  ReasoningCycle,
  ReasoningState,
  ReasoningStep,
  StepStatus,
  StoppingRecord,
} from "../../core/reasoning/types.js"
import {
  decisionNumber,
  deriveNextStepNumber,
  makeCycleId,
  makeDecisionId,
  makeSessionId,
  makeStepId,
  sessionNumber,
} from "../../core/reasoning/ids.js"
import { computeStateSignature } from "../../core/reasoning/state-signature.js"
import {
  appendVersion,
  importHypotheses,
  toActiveHypotheses,
} from "../../core/reasoning/hypothesis-version.js"
import { verifyPureHypotheses } from "../../core/reasoning/hypothesis-verification.js"
import { ResearchIntelligenceReportSchema } from "../../core/schemas.js"
import { ResearchIntelligenceEngine } from "../research/research-intelligence.js"
import { assessSituation } from "./situation-assessment.js"
import { planReasoning } from "./action-selection.js"
import { runFollowUpResearch } from "./follow-up.js"
import { buildRejection, buildRevision, generateAlternative } from "./hypothesis-lifecycle.js"
import { getLogger, type Logger } from "../../core/log.js"
import { isEligibleForNewCycle } from "./cycle-eligibility.js"
import {
  appendDecision,
  computeDelta,
  computeSessionEpistemicSignature,
  freshSessionId,
  loadReasoningCursor,
  migrateLegacyReasoning,
  nextCycleSequence,
  pendingDecisionsOf,
  readDecisions,
  readReasoningCycles,
  rebuildCursorFromLedger,
  reconcileCursor,
  seedCycleHeader,
  sealCycle,
  writeReasoningCycles,
} from "./reasoning-repository.js"
import {
  buildIntelligenceEnvelope,
  intelligenceInputSignature,
  isIntelligenceEnvelope,
} from "./intelligence-envelope.js"

export interface ReasoningEngineOptions {
  project: string
  question: string
  memory: MemoryStore
  agent: StructuredAgent
  search: SearchProvider
  /** v0.4 research bundle (persisted `research` wins when both are present). */
  research?: ResearchBundle
  /** v0.4 active hypotheses, imported as v1 versions on the first session. */
  hypotheses: Hypothesis[]
  referenceDate?: string
  humanInTheLoop?: boolean
  approvals?: ApprovalGate
  budget?: Partial<CycleContext["budget"]>
  logger?: Logger
}

/** Action kinds that go through the approval gate before they execute. */
const GATED_KINDS: ReadonlySet<ReasoningActionKind> = new Set([
  "GENERATE_HYPOTHESIS",
  "REVISE_HYPOTHESIS",
  "REJECT_HYPOTHESIS",
  "REQUEST_HUMAN_INPUT",
])

/** Per-query result cap for follow-up research (like the research engine). */
const FOLLOW_UP_LIMIT_PER_QUERY = 8

export type ExecuteResult = {
  research?: ResearchBundle
  versions?: HypothesisVersion[]
  intelligence?: ResearchIntelligenceReport
  writes: string[]
  notes: string[]
  requiresHuman?: boolean
}

/** Data-plane view over a control cursor — the `ReasoningState` contract. */
export function toReasoningState(cursor: ReasoningCursor): ReasoningState {
  return {
    project: cursor.project,
    question: cursor.question,
    cycleContext: {
      cycleId: cursor.currentCycleId ?? "CYC_001",
      referenceDate: cursor.referenceDate,
      budget: cursor.budget,
      stateSignature: cursor.stateSignature,
    },
    steps: cursor.steps,
    lastStopping: cursor.lastStopping,
    status: cursor.status,
  }
}

/**
 * v0.6 — Reasoning engine (persistent cycles).
 *
 * The control state is a v2 cursor persisted under `reasoning`, and every
 * cycle is archived immutably in the `reasoning-history` ledger. A terminal
 * state may open a NEW cycle only through an explicit eligibility trigger
 * (epistemic / temporal / budget change, governance change or explicit
 * request, F7); anything else resumes within the same cycle or returns the
 * terminal state unchanged (no-op, byte-identical store). Commit points seed
 * the ledger header BEFORE any epistemic write (at-most-once, F3); effects
 * committed without a recorded step are reconciled into synthesized steps on
 * resume (commit-point recovery, F1/F2).
 */
export class ReasoningEngine {
  private readonly memory: MemoryStore
  private readonly logger: Logger
  private readonly approvals: ApprovalGate
  private readonly budget: CycleContext["budget"]
  private readonly referenceDate: string | null

  constructor(private readonly options: ReasoningEngineOptions) {
    this.memory = options.memory
    this.logger = options.logger ?? getLogger()
    this.referenceDate = options.referenceDate ?? null
    this.approvals = options.approvals ?? new AutoApprover()
    this.budget = {
      maxSteps: options.budget?.maxSteps ?? 100,
      maxSources: options.budget?.maxSources ?? 40,
      maxQueries: options.budget?.maxQueries ?? 40,
      maxFollowUpRounds: options.budget?.maxFollowUpRounds ?? 5,
    }
  }

  async run(opts?: { force?: boolean }): Promise<ReasoningState> {
    const force = opts?.force === true

    const loaded = await loadReasoningCursor(this.memory)
    let cursor = loaded.cursor
    let previousSessionId: string | null = null

    // A session is (project, question)-scoped; a different question is a new
    // session whose cycles append to the same ledger with fresh ids.
    if (cursor !== null && cursor.question !== this.options.question) {
      previousSessionId = cursor.sessionId
      cursor = null
    }

    const cycles = await readReasoningCycles(this.memory)

    let currentResearch = await this.memory.get<ResearchBundle>("research")
    if (!currentResearch && this.options.research) currentResearch = this.options.research
    if (!currentResearch) {
      throw new Error(
        'reasoning requires a research bundle (memory key "research" or engine option)',
      )
    }
    let currentVersions = (await this.memory.get<HypothesisVersion[]>("hypothesis-versions")) ?? []

    // In-memory migration of a v0.5 `{version:1, state}` wrapper.
    if (
      cursor === null &&
      loaded.legacyState !== null &&
      loaded.legacyState.question === this.options.question
    ) {
      cursor = migrateLegacyReasoning(
        loaded.legacyState,
        currentVersions,
        this.options.project,
        this.budget,
      )
    }

    // A RUNNING/PAUSED cursor whose cycle is already COMPLETED in the ledger
    // means the seal committed but the control write did not — rebuild.
    if (
      cursor !== null &&
      (cursor.status === "RUNNING" || cursor.status === "PAUSED") &&
      cycles.some((c) => c.cycleId === cursor?.currentCycleId && c.status === "COMPLETED")
    ) {
      const rebuilt = rebuildCursorFromLedger(cursor, cycles, currentVersions)
      if (rebuilt) cursor = rebuilt
    }

    // Guarantee a baseline hypothesis version log for the session.
    if (currentVersions.length === 0) {
      await this.seedBaseline()
      currentVersions = (await this.memory.get<HypothesisVersion[]>("hypothesis-versions")) ?? []
    }

    if (!cursor || cursor.status === "STOPPED" || cursor.status === "PAUSED") {
      const outcome = await this.maybeOpenNewCycle(
        cursor,
        cycles,
        force,
        currentResearch,
        currentVersions,
        previousSessionId,
      )
      if (!outcome.opened) return outcome.state
      cursor = outcome.cursor
    }

    return this.continueCycle(cursor)
  }

  /**
   * Terminal-state entry: eligibility gate. Returns the terminal `ReasoningState`
   * unchanged (zero writes) when no trigger fires; otherwise seeds + persists a
   * fresh cursor for the new cycle.
   */
  private async maybeOpenNewCycle(
    cursor: ReasoningCursor | null,
    cycles: ReasoningCycle[],
    force: boolean,
    research: ResearchBundle,
    versions: HypothesisVersion[],
    previousSessionId: string | null,
  ): Promise<{ opened: false; state: ReasoningState } | { opened: true; cursor: ReasoningCursor }> {
    const artifact = await this.memory.get<{ hypotheses: Hypothesis[] }>("hypotheses")
    const activePtrs = artifact?.hypotheses ?? []
    const epistemicSignature = computeSessionEpistemicSignature(
      this.options.question,
      research,
      versions,
      activePtrs,
    )

    // Cursor lost entirely: fall back to the ledger. A COMPLETED last cycle is
    // a terminal baseline; a SEEDED/PAUSED row is sealed RECOVERED first.
    if (cursor === null && previousSessionId === null && cycles.length > 0) {
      const last = cycles[cycles.length - 1]!
      if (last.status !== "COMPLETED") {
        const recovered: ReasoningCycle = {
          ...last,
          status: "RECOVERED",
          endedWithEpistemicSignature: epistemicSignature,
          endedWithStateSignature: "",
        }
        await writeReasoningCycles(this.memory, [...cycles.slice(0, -1), recovered])
        cycles = await readReasoningCycles(this.memory)
        cursor = this.cursorFromLedgerView(recovered, versions)
      } else {
        cursor = this.cursorFromLedgerView(last, versions)
      }
    }

    let prev =
      cursor === null ? null : (cycles.find((c) => c.cycleId === cursor.currentCycleId) ?? null)

    // Legacy archive: a migrated state is archived as a `legacy-v1` row before
    // the first real v0.6 cycle is minted.
    if (prev === null && cursor !== null && previousSessionId === null) {
      const archiveId = cycles.length === 0 ? "CYC_001" : makeCycleId(nextCycleSequence(cycles))
      const archive = {
        cycleId: archiveId,
        status: "COMPLETED" as const,
        trigger: "first" as const,
        referenceDate: cursor.referenceDate,
        budget: cursor.budget,
        humanInTheLoop: this.options.humanInTheLoop === true,
        startedWithStateSignature: cursor.stateSignature,
        endedWithStateSignature: cursor.stateSignature,
        endedWithEpistemicSignature: epistemicSignature,
        steps: cursor.steps,
        stopping: cursor.lastStopping,
        delta: computeDelta(cursor.steps, versions),
        source: "legacy-v1" as const,
      }
      await writeReasoningCycles(this.memory, [...cycles, archive])
      cycles = await readReasoningCycles(this.memory)
      prev = archive
    }

    // Complete a pending seal: cursor STOPPED but ledger row still SEEDED/PAUSED.
    if (prev !== null && prev.status !== "COMPLETED" && cursor?.status === "STOPPED") {
      const row = this.buildSealRow(prev, cursor, versions, epistemicSignature)
      await sealCycle(this.memory, cycles, row)
      prev = row
    }

    const referenceDate = await this.resolveReferenceDateFor(prev, cursor)

    const gate = isEligibleForNewCycle(prev, {
      epistemicSignature,
      referenceDate,
      budget: cursor?.budget ?? this.budget,
      pendingDecisionIds: await this.pendingForEligibility(cursor),
      force,
    })

    if (!gate.eligible) return { opened: false, state: toReasoningState(cursor!) }

    const newCycleId = makeCycleId(nextCycleSequence(cycles))
    const sessionId =
      previousSessionId !== null
        ? makeSessionId(sessionNumber(previousSessionId) + 1)
        : (cursor?.sessionId ?? freshSessionId(null))

    const nextCursor: ReasoningCursor = {
      sessionId,
      project: this.options.project,
      question: this.options.question,
      status: "RUNNING",
      currentCycleId: newCycleId,
      nextStepNumber: deriveNextStepNumber(
        [
          ...cycles.flatMap((c) => c.steps.map((s) => s.id)),
          ...(cursor?.steps.map((s) => s.id) ?? []),
        ],
        versions.map((v) => v.createdAfterStep),
      ),
      previousCycleId: prev?.cycleId ?? null,
      referenceDate,
      budget: this.budget,
      stateSignature: "",
      consumedDecisionIds: cursor?.consumedDecisionIds ?? [],
      steps: [],
      lastStopping: null,
    }

    // Commit point (F3): attribute the new cycle to the ledger BEFORE any
    // epistemic write of this cycle can happen.
    await seedCycleHeader(this.memory, cycles, {
      cycleId: newCycleId,
      status: "SEEDED",
      trigger: gate.trigger,
      referenceDate,
      budget: this.budget,
      humanInTheLoop: this.options.humanInTheLoop === true,
      startedWithStateSignature: "",
      endedWithStateSignature: "",
      endedWithEpistemicSignature: "",
      steps: [],
      stopping: null,
      delta: {
        producedVersionIds: [],
        supersededVersionIds: [],
        rejectedVersionIds: [],
        keysWritten: [],
      },
      source: "engine",
    })
    await this.persistCursor(nextCursor)
    this.logger.info("reasoning", `new cycle ${newCycleId} (${gate.trigger})`)
    return { opened: true, cursor: nextCursor }
  }

  /** Resumes PAUSED / RUNNING cursors within the current cycle. */
  private async continueCycle(cursor: ReasoningCursor): Promise<ReasoningState> {
    const currentResearch =
      (await this.memory.get<ResearchBundle>("research")) ?? this.options.research!
    const currentVersions =
      (await this.memory.get<HypothesisVersion[]>("hypothesis-versions")) ?? []
    const cycles = await readReasoningCycles(this.memory)

    const signatureNow = await this.computeFullSignatureFor(
      currentResearch,
      currentVersions,
      cursor,
    )
    const reconciled = reconcileCursor(
      cursor,
      cycles,
      currentVersions,
      currentResearch,
      signatureNow,
    )
    if (reconciled.healed > 0) {
      this.logger.warn("reasoning", `reconciled ${reconciled.healed} unrecorded effects`)
      cursor = reconciled.cursor
    }

    if (cursor.status === "PAUSED") {
      const requestStep = this.pendingHumanStep(cursor)
      const decisions = await readDecisions(this.memory)
      const decision = requestStep
        ? pendingDecisionsOf(decisions, cursor).find(
            (d) => d.stepId === requestStep.id && d.response === "answer",
          )
        : undefined
      if (!decision || !requestStep) {
        await this.persistCursor(cursor)
        this.logger.info("reasoning", "no-op resume: waiting on human input")
        return toReasoningState(cursor)
      }
      cursor = {
        ...cursor,
        status: "RUNNING",
        consumedDecisionIds: [...cursor.consumedDecisionIds, decision.decisionId],
        steps: [
          ...cursor.steps,
          {
            id: makeStepId(cursor.nextStepNumber),
            cycleContext: {
              cycleId: cursor.currentCycleId ?? "CYC_001",
              referenceDate: cursor.referenceDate,
            },
            action: requestStep.action,
            status: "COMPLETED",
            stateSignatureBefore: cursor.stateSignature,
            stateSignatureAfter: cursor.stateSignature,
            performedAt: cursor.referenceDate,
            writes: ["reasoning"],
            notes: [`answer: ${decision.responseDetail ?? ""}`],
          },
        ],
        nextStepNumber: cursor.nextStepNumber + 1,
      }
      await this.persistCursor(cursor)
      this.logger.info("reasoning", `resumed ${cursor.currentCycleId} on ${decision.decisionId}`)
    }

    return this.runLoop(cursor, blockedStepsOf(cursor, cycles))
  }

  /** The decision–effect loop over the cursor's current cycle. */
  private async runLoop(
    cursor: ReasoningCursor,
    blockedSteps: ReasoningStep[] = [],
  ): Promise<ReasoningState> {
    let currentResearch: ResearchBundle =
      (await this.memory.get<ResearchBundle>("research")) ?? this.options.research!
    let currentVersions: HypothesisVersion[] =
      (await this.memory.get<HypothesisVersion[]>("hypothesis-versions")) ?? []
    const cycleContext = this.cycleContextOf(cursor)

    while (true) {
      const cycleSteps = cursor.steps.filter(
        (s) => s.cycleContext.cycleId === cursor.currentCycleId,
      )
      if (cycleSteps.length >= cycleContext.budget.maxSteps) {
        const intelligence = await this.readIntelligence(
          currentResearch,
          currentVersions,
          cycleContext,
        )
        const signatureBefore = this.computeSignature(
          currentResearch,
          currentVersions,
          intelligence,
          cycleContext,
        )
        const action: Extract<ReasoningAction, { kind: "STOP" }> = {
          kind: "STOP",
          stoppingKind: "STOP_RESEARCH_LIMIT",
          reason: `maximum reasoning steps (${cycleContext.budget.maxSteps}) exceeded`,
        }
        const stopping: StoppingRecord = {
          stoppingKind: action.stoppingKind,
          reason: action.reason,
          at: cycleContext.referenceDate,
        }
        cursor = this.finishCursor(cursor, cycleContext, action, signatureBefore, stopping)
        await this.seal(cursor, currentVersions)
        await this.persistCursor(cursor)
        return toReasoningState(cursor)
      }

      const intelligence = await this.readIntelligence(
        currentResearch,
        currentVersions,
        cycleContext,
      )
      const signatureBefore = this.computeSignature(
        currentResearch,
        currentVersions,
        intelligence,
        cycleContext,
      )
      const situation = assessSituation({
        question: this.options.question,
        research: currentResearch,
        intelligence,
        versions: currentVersions,
        cycleSteps,
        blockedSteps,
        stateSignatureBefore: signatureBefore,
        cycleContext,
        humanInTheLoop: this.options.humanInTheLoop,
      })
      const plan = planReasoning(situation)

      if (plan.terminating) {
        const action = plan.action as Extract<ReasoningAction, { kind: "STOP" }>
        const stopping: StoppingRecord = {
          stoppingKind: action.stoppingKind,
          reason: plan.terminalReason ?? action.reason,
          at: cycleContext.referenceDate,
        }
        cursor = this.finishCursor(cursor, cycleContext, action, signatureBefore, stopping)
        await this.seal(cursor, currentVersions)
        await this.persistCursor(cursor)
        this.logger.info("reasoning", `stopped: ${action.stoppingKind} — ${stopping.reason}`)
        return toReasoningState(cursor)
      }

      const stepId = makeStepId(cursor.nextStepNumber)

      if (GATED_KINDS.has(plan.action.kind)) {
        const decision = await this.approvals.review(
          "reasoning",
          this.candidateSummary(plan.action),
        )
        if (!decision.approved) {
          cursor = await this.recordGateFailure(
            cursor,
            stepId,
            cycleContext,
            plan.action,
            signatureBefore,
            decision,
          )
          await this.persistCursor(cursor)
          continue
        }
      }

      const result = await this.executeStep(
        plan.action,
        stepId,
        currentResearch,
        currentVersions,
        cycleContext,
      )
      if (result.research) currentResearch = result.research
      if (result.versions) currentVersions = result.versions

      if (result.requiresHuman) {
        const stopping: StoppingRecord = {
          stoppingKind: "STOP_HUMAN_REQUIRED",
          reason:
            plan.action.kind === "REQUEST_HUMAN_INPUT"
              ? plan.action.target
              : "human input required",
          at: cycleContext.referenceDate,
        }
        cursor = {
          ...this.bumpNext(cursor),
          status: "PAUSED",
          lastStopping: stopping,
        }
        await this.markHeaderPaused(cursor)
        await this.persistCursor(cursor)
        return toReasoningState(cursor)
      }

      const signatureAfter = this.computeSignature(
        currentResearch,
        currentVersions,
        result.intelligence ?? intelligence,
        cycleContext,
      )
      cursor = this.record(
        cursor,
        stepId,
        cycleContext,
        plan.action,
        signatureBefore,
        signatureAfter,
        result.writes,
        result.notes,
        "COMPLETED",
      )
      cursor = this.bumpNext(cursor)
      await this.persistCursor(cursor)
      this.logger.info(
        "reasoning",
        `step ${stepId}: ${plan.action.kind} → ${this.targetLabel(plan.action)}`,
      )
    }
  }

  private cycleContextOf(cursor: ReasoningCursor): CycleContext {
    return {
      cycleId: cursor.currentCycleId ?? "CYC_001",
      referenceDate: cursor.referenceDate,
      budget: cursor.budget,
      stateSignature: cursor.stateSignature,
    }
  }

  private async markHeaderPaused(cursor: ReasoningCursor): Promise<void> {
    const cycles = await readReasoningCycles(this.memory)
    const index = cycles.findIndex((c) => c.cycleId === cursor.currentCycleId)
    if (index === -1 || cycles[index]!.status === "COMPLETED") return
    const next = [...cycles]
    next[index] = { ...next[index]!, status: "PAUSED" }
    await writeReasoningCycles(this.memory, next)
  }

  private buildSealRow(
    header: ReasoningCycle,
    cursor: ReasoningCursor,
    versions: HypothesisVersion[],
    endedWithEpistemicSignature: string,
  ): ReasoningCycle {
    const steps = cursor.steps.filter((s) => s.cycleContext.cycleId === cursor.currentCycleId)
    return {
      cycleId: cursor.currentCycleId ?? "",
      status: "COMPLETED",
      trigger: header.trigger,
      referenceDate: cursor.referenceDate,
      budget: cursor.budget,
      humanInTheLoop: header.humanInTheLoop,
      startedWithStateSignature: steps[0]?.stateSignatureBefore ?? header.startedWithStateSignature,
      endedWithStateSignature: cursor.stateSignature,
      endedWithEpistemicSignature,
      steps,
      stopping: cursor.lastStopping,
      delta: computeDelta(steps, versions),
      source: "engine",
    }
  }

  private async seal(cursor: ReasoningCursor, versions: HypothesisVersion[]): Promise<void> {
    let cycles = await readReasoningCycles(this.memory)
    let header = cycles.find((c) => c.cycleId === cursor.currentCycleId)
    if (!header) {
      // Migrated/mid-flight cycle that never had a ledger header: backfill one
      // so the row the seal will complete is attributed before it is sealed.
      const fallback: ReasoningCycle = {
        cycleId: cursor.currentCycleId ?? "CYC_001",
        status: "SEEDED",
        trigger: "first",
        referenceDate: cursor.referenceDate,
        budget: cursor.budget,
        humanInTheLoop: this.options.humanInTheLoop === true,
        startedWithStateSignature: "",
        endedWithStateSignature: "",
        endedWithEpistemicSignature: "",
        steps: [],
        stopping: null,
        delta: {
          producedVersionIds: [],
          supersededVersionIds: [],
          rejectedVersionIds: [],
          keysWritten: [],
        },
        source: "engine",
      }
      await seedCycleHeader(this.memory, cycles, fallback)
      cycles = await readReasoningCycles(this.memory)
      header = cycles.find((c) => c.cycleId === cursor.currentCycleId) ?? fallback
    }
    const research = (await this.memory.get<ResearchBundle>("research")) ?? null
    const artifact = await this.memory.get<{ hypotheses: Hypothesis[] }>("hypotheses")
    const endedWithEpistemic = computeSessionEpistemicSignature(
      this.options.question,
      research,
      versions,
      artifact?.hypotheses ?? [],
    )
    await sealCycle(
      this.memory,
      cycles,
      this.buildSealRow(header, cursor, versions, endedWithEpistemic),
    )
  }

  private cursorFromLedgerView(
    cycle: ReasoningCycle,
    versions: HypothesisVersion[],
  ): ReasoningCursor {
    return {
      sessionId: freshSessionId(null),
      project: this.options.project,
      question: this.options.question,
      status: "STOPPED",
      currentCycleId: cycle.cycleId,
      nextStepNumber: deriveNextStepNumber(
        [...cycle.steps.map((s) => s.id)],
        versions.map((v) => v.createdAfterStep),
      ),
      previousCycleId: null,
      referenceDate: cycle.referenceDate,
      budget: cycle.budget,
      stateSignature: cycle.endedWithStateSignature,
      consumedDecisionIds: [],
      steps: cycle.steps,
      lastStopping: cycle.stopping,
    }
  }

  private async pendingForEligibility(cursor: ReasoningCursor | null): Promise<string[]> {
    const decisions = await readDecisions(this.memory)
    const consumed = new Set(cursor?.consumedDecisionIds ?? [])
    return decisions
      .filter((d) => d.response !== "rejected" && !consumed.has(d.decisionId))
      .map((d) => d.decisionId)
  }

  private async resolveReferenceDateFor(
    prev: ReasoningCycle | null,
    cursor: ReasoningCursor | null,
  ): Promise<string> {
    if (this.referenceDate) return this.referenceDate
    if (cursor?.referenceDate) return cursor.referenceDate
    if (prev?.referenceDate) return prev.referenceDate
    const explicit = await this.memory.get<{
      generatedAt?: string
      report?: { generatedAt?: string }
    }>("intelligence")
    return explicit?.report?.generatedAt ?? explicit?.generatedAt ?? new Date().toISOString()
  }

  /** Records a BLOCKED step (gate rejection) + its DecisionRecord + new id. */
  private async recordGateFailure(
    cursor: ReasoningCursor,
    stepId: string,
    cycleContext: CycleContext,
    action: ReasoningAction,
    signatureBefore: string,
    decision: { message?: string | null },
  ): Promise<ReasoningCursor> {
    const withStep = this.record(
      cursor,
      stepId,
      cycleContext,
      action,
      signatureBefore,
      signatureBefore,
      ["reasoning"],
      [decision.message ?? "blocked by the approval gate"],
      "BLOCKED",
    )
    const records = await readDecisions(this.memory)
    let seq = 0
    for (const record of records) {
      const n = decisionNumber(record.decisionId)
      if (n > seq) seq = n
    }
    const record: DecisionRecord = {
      decisionId: makeDecisionId(seq + 1),
      kind: action.kind,
      subject: stepId,
      proposedAction: this.candidateSummary(action),
      response: "rejected",
      responseDetail: decision.message ?? null,
      cycleId: cycleContext.cycleId,
      stepId,
      createdAt: cycleContext.referenceDate,
    }
    await appendDecision(this.memory, records, record)
    this.logger.warn("reasoning", `blocked ${action.kind} (${stepId})`)
    return this.bumpNext(withStep)
  }

  private bumpNext(cursor: ReasoningCursor): ReasoningCursor {
    return { ...cursor, nextStepNumber: cursor.nextStepNumber + 1 }
  }

  // ------------------------------------------------------------------
  // Action execution (v0.5 parity).
  // ------------------------------------------------------------------

  private async executeStep(
    action: ReasoningAction,
    stepId: string,
    research: ResearchBundle,
    versions: HypothesisVersion[],
    cycleContext: CycleContext,
  ): Promise<ExecuteResult> {
    switch (action.kind) {
      case "RESEARCH": {
        const result = await runFollowUpResearch({
          bundle: research,
          target: action.target,
          search: this.options.search,
          agent: this.options.agent,
          maxSourcesPerQuery: FOLLOW_UP_LIMIT_PER_QUERY,
          maxSources: this.budget.maxSources,
        })
        if (!result.performed) {
          return { writes: ["reasoning"], notes: result.notes }
        }
        // Commit marker (F1/F2): stamp the emitting step id onto the follow-up
        // query entry so a crash after this write can be reconciled.
        const stamped = Object.assign({}, result.bundle, {
          queries: stampCreatedAfterStep(result.bundle.queries, stepId),
        })
        const intelligence = this.rebuildIntelligence(stamped, versions, cycleContext.referenceDate)
        await this.epistemicWrite("RESEARCH", {
          research: stamped,
          intelligence,
        })
        return {
          research: stamped,
          intelligence,
          writes: ["research", "intelligence"],
          notes: result.notes,
        }
      }

      case "GENERATE_HYPOTHESIS": {
        const next = await generateAlternative({
          research,
          versions,
          stepId,
          targetHypothesisId: action.targetHypothesis,
          agent: this.options.agent,
        })
        return await this.applyHypothesis(
          appendVersion(versions, next),
          research,
          cycleContext,
          next,
        )
      }

      case "REVISE_HYPOTHESIS": {
        const verification = this.verificationOf(action.targetHypothesis, versions, research)
        const next = await buildRevision({
          research,
          versions,
          stepId,
          targetHypothesisId: action.targetHypothesis,
          verification,
          agent: this.options.agent,
        })
        return await this.applyHypothesis(
          appendVersion(versions, next),
          research,
          cycleContext,
          next,
          `revised ${next.versionId} (${verification.status} → untested)`,
        )
      }

      case "REJECT_HYPOTHESIS": {
        const verification = this.verificationOf(action.targetHypothesis, versions, research)
        const next = buildRejection({
          research,
          versions,
          stepId,
          targetHypothesisId: action.targetHypothesis,
          verification,
        })
        return await this.applyHypothesis(
          appendVersion(versions, next),
          research,
          cycleContext,
          next,
          `rejected ${next.versionId}: ${verification.rationale}`,
        )
      }

      case "REQUEST_HUMAN_INPUT":
        return { writes: ["reasoning"], notes: [action.target], requiresHuman: true }

      case "STOP":
        throw new Error("STOP is terminating and never executes as a step")
    }
  }

  private async applyHypothesis(
    versions: HypothesisVersion[],
    research: ResearchBundle,
    cycleContext: CycleContext,
    next: HypothesisVersion,
    note?: string,
  ): Promise<ExecuteResult> {
    const intelligence = this.rebuildIntelligence(research, versions, cycleContext.referenceDate)
    await this.epistemicWrite("GENERATE_HYPOTHESIS", {
      "hypothesis-versions": versions,
      hypotheses: this.hypothesesArtifact(versions, research),
      intelligence,
    })
    return {
      versions,
      intelligence,
      writes: ["hypotheses", "hypothesis-versions", "intelligence"],
      notes: [note ?? `generated ${next.versionId}: "${next.statement.slice(0, 80)}"`],
    }
  }

  private hypothesesArtifact(
    versions: HypothesisVersion[],
    research: ResearchBundle | undefined,
  ): { hypotheses: Hypothesis[]; verifications: HypothesisVerification[] } {
    const hypotheses = toActiveHypotheses(versions)
    return {
      hypotheses,
      verifications: verifyPureHypotheses({ hypotheses, research }),
    }
  }

  private verificationOf(
    hypothesisId: string,
    versions: HypothesisVersion[],
    research: ResearchBundle,
  ) {
    const active = toActiveHypotheses(versions).find((h) => h.id === hypothesisId)
    if (!active) throw new Error(`unknown active hypothesis ${hypothesisId}`)
    return verifyPureHypotheses({ hypotheses: [active], research })[0]!
  }

  private rebuildIntelligence(
    research: ResearchBundle,
    versions: HypothesisVersion[],
    referenceDate: string,
  ): ResearchIntelligenceReport {
    const verifications = verifyPureHypotheses({
      hypotheses: toActiveHypotheses(versions),
      research,
    })
    return new ResearchIntelligenceEngine({
      research,
      verifications,
      referenceDate,
      limits: {
        maxSources: this.budget.maxSources,
        maxSubQuestions: this.budget.maxQueries,
        maxFollowUpRounds: this.budget.maxFollowUpRounds,
        maxIterations: this.budget.maxSteps,
      },
    }).run()
  }

  private computeSignature(
    research: ResearchBundle,
    versions: HypothesisVersion[],
    intelligence: ResearchIntelligenceReport,
    cycleContext: CycleContext,
  ): string {
    return computeStateSignature({
      question: this.options.question,
      research,
      intelligence,
      hypotheses: toActiveHypotheses(versions),
      versions,
      referenceDate: cycleContext.referenceDate,
    })
  }

  private async computeFullSignatureFor(
    research: ResearchBundle,
    versions: HypothesisVersion[],
    cursor: ReasoningCursor,
  ): Promise<string> {
    const context = this.cycleContextOf(cursor)
    const intelligence = await this.readIntelligence(research, versions, context)
    return this.computeSignature(research, versions, intelligence, context)
  }

  private async readIntelligence(
    research: ResearchBundle,
    versions: HypothesisVersion[],
    cycleContext: CycleContext,
  ): Promise<ResearchIntelligenceReport> {
    const existing = await this.readIntelligenceArtifact()
    const inputs = {
      research,
      versions,
      referenceDate: cycleContext.referenceDate,
      budget: cycleContext.budget,
    }
    if (existing !== null) {
      if (
        isIntelligenceEnvelope(existing) ||
        (typeof existing === "object" &&
          existing !== null &&
          Object.prototype.hasOwnProperty.call(existing, "version") &&
          Object.prototype.hasOwnProperty.call(existing, "report"))
      ) {
        const envelope = existing as {
          version: number
          inputSignature?: string
          report: ResearchIntelligenceReport
        }
        if (
          envelope.inputSignature === undefined ||
          envelope.inputSignature === intelligenceInputSignature(inputs)
        ) {
          const report = ResearchIntelligenceReportSchema.safeParse(envelope.report)
          if (report.success) return report.data
        }
        // Signature mismatch: stale report, recompute and repersist.
        const rebuilt = this.rebuildIntelligence(research, versions, cycleContext.referenceDate)
        await this.persistIntelligence(buildIntelligenceEnvelope(inputs, rebuilt))
        return rebuilt
      }
      // Bare v0.4/v0.5 report: wrap it in the envelope with a fresh signature.
      const report = ResearchIntelligenceReportSchema.safeParse(existing)
      if (report.success) {
        await this.persistIntelligence(buildIntelligenceEnvelope(inputs, report.data))
        return report.data
      }
    }
    const rebuilt = this.rebuildIntelligence(research, versions, cycleContext.referenceDate)
    await this.persistIntelligence(buildIntelligenceEnvelope(inputs, rebuilt))
    return rebuilt
  }

  private async readIntelligenceArtifact(): Promise<unknown> {
    const raw = await this.memory.readRaw("intelligence")
    if (raw === null) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  private async persistIntelligence(envelope: unknown): Promise<void> {
    await this.memory.save("intelligence", envelope)
  }

  // ------------------------------------------------------------------
  // Cursor / control-state bookkeeping.
  // ------------------------------------------------------------------

  /** Baseline import (v0.4 hypotheses → v1 versions) at STEP_000. */
  private async seedBaseline(): Promise<void> {
    const research = (await this.memory.get<ResearchBundle>("research")) ?? this.options.research
    const seeded = importHypotheses(this.options.hypotheses, "STEP_000")
    await this.memory.save("hypothesis-versions", seeded)
    await this.memory.save("hypotheses", this.hypothesesArtifact(seeded, research))
  }

  private record(
    reasoning: ReasoningCursor,
    id: string,
    cycleContext: CycleContext,
    action: ReasoningAction,
    signatureBefore: string,
    signatureAfter: string,
    writes: string[],
    notes: string[],
    status: StepStatus,
  ): ReasoningCursor {
    const step: ReasoningStep = {
      id,
      cycleContext: { cycleId: cycleContext.cycleId, referenceDate: cycleContext.referenceDate },
      action,
      status,
      stateSignatureBefore: signatureBefore,
      stateSignatureAfter: signatureAfter,
      performedAt: cycleContext.referenceDate,
      writes,
      notes,
    }
    return { ...reasoning, steps: [...reasoning.steps, step] }
  }

  private finishCursor(
    reasoning: ReasoningCursor,
    cycleContext: CycleContext,
    action: Extract<ReasoningAction, { kind: "STOP" }>,
    signatureBefore: string,
    stopping: StoppingRecord,
  ): ReasoningCursor {
    const stepId = makeStepId(reasoning.nextStepNumber)
    const withStep = this.record(
      reasoning,
      stepId,
      cycleContext,
      action,
      signatureBefore,
      signatureBefore,
      ["reasoning"],
      [],
      "COMPLETED",
    )
    return {
      ...withStep,
      stateSignature: signatureBefore,
      lastStopping: stopping,
      status: "STOPPED",
      nextStepNumber: withStep.nextStepNumber + 1,
    }
  }

  private pendingHumanStep(cursor: ReasoningCursor): ReasoningStep | null {
    for (let i = cursor.steps.length - 1; i >= 0; i--) {
      const step = cursor.steps[i]!
      if (step.action.kind === "REQUEST_HUMAN_INPUT" && step.status === "COMPLETED") return step
    }
    return null
  }

  private async persistCursor(cursor: ReasoningCursor): Promise<void> {
    await this.memory.save("reasoning", { version: 2, state: cursor })
  }

  private async epistemicWrite(
    kind: ReasoningActionKind,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const scoped = new ScopedMemory(this.memory, readScopeFor(kind), true)
    for (const [key, value] of Object.entries(changes)) {
      await scoped.save(key, value)
    }
  }

  private targetLabel(action: ReasoningAction): string {
    switch (action.kind) {
      case "RESEARCH":
        return action.target.id
      case "GENERATE_HYPOTHESIS":
        return action.targetHypothesis ?? "FIRST"
      case "REVISE_HYPOTHESIS":
      case "REJECT_HYPOTHESIS":
        return action.targetHypothesis
      case "REQUEST_HUMAN_INPUT":
        return action.target
      case "STOP":
        return action.stoppingKind
    }
  }

  private candidateSummary(action: ReasoningAction): unknown {
    return {
      kind: action.kind,
      ...(action.kind === "RESEARCH"
        ? { target: { subject: action.target.subject, id: action.target.id } }
        : action.kind === "GENERATE_HYPOTHESIS"
          ? { targetHypothesis: action.targetHypothesis, basis: action.basis }
          : action.kind === "REVISE_HYPOTHESIS" || action.kind === "REJECT_HYPOTHESIS"
            ? { targetHypothesis: action.targetHypothesis }
            : { target: (action as { target: string }).target }),
    }
  }
}

function stampCreatedAfterStep(
  queries: ResearchBundle["queries"],
  stepId: string,
): ResearchBundle["queries"] {
  const entries = queries.map((q) => Object.assign({}, q))
  const last = entries[entries.length - 1] as { createdAfterStep?: string } | undefined
  if (last && !last.createdAfterStep) last.createdAfterStep = stepId
  return entries as ResearchBundle["queries"]
}

/**
 * BLOCKED steps from earlier sealed cycles (THE foreclosure source for
 * §18.12): a rejection recorded in any prior cycle is replayed into the
 * current cycle's loop guard whenever the state signature is unchanged.
 */
function blockedStepsOf(cursor: ReasoningCursor, cycles: ReasoningCycle[]): ReasoningStep[] {
  return cycles
    .filter((c) => c.cycleId !== cursor.currentCycleId)
    .flatMap((c) => c.steps.filter((s) => s.status === "BLOCKED"))
}
