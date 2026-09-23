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
  ReasoningAction,
  ReasoningActionKind,
  ReasoningState,
  ReasoningStep,
  StepStatus,
} from "../../core/reasoning/types.js"
import { CYCLE_PREFIX, STEP_PREFIX } from "../../core/reasoning/types.js"
import { ReasoningStateVersionSchema } from "../../core/reasoning/schemas.js"
import { computeStateSignature } from "../../core/reasoning/state-signature.js"
import {
  appendVersion,
  importHypotheses,
  toActiveHypotheses,
} from "../../core/reasoning/hypothesis-version.js"
import { verifyPureHypotheses } from "../../core/reasoning/hypothesis-verification.js"
import { makeId } from "../research/ids.js"
import { ResearchIntelligenceEngine } from "../research/research-intelligence.js"
import { assessSituation } from "./situation-assessment.js"
import { planReasoning } from "./action-selection.js"
import { runFollowUpResearch } from "./follow-up.js"
import { buildRejection, buildRevision, generateAlternative } from "./hypothesis-lifecycle.js"
import { getLogger, type Logger } from "../../core/log.js"

export interface ReasoningEngineOptions {
  project: string
  question: string
  memory: MemoryStore
  agent: StructuredAgent
  search: SearchProvider
  /** The v0.4 research bundle the reasoning cycle reasons over. */
  research: ResearchBundle
  /** v0.4 active hypotheses, imported as v1 versions on the first cycle. */
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

/**
 * v0.5 — Reasoning engine.
 *
 * A decision–effect loop over the epistemic state:
 *
 *   read epistemic state → compute its signature → assess the situation →
 *   the policy picks the next action or a STOP verdict → approval gate for
 *   hypothesis-touching actions → execute within the action's write-scope →
 *   record the step → repeat.
 *
 * Epistemic writes are physically scoped per action (ScopedMemory): a
 * RESEARCH action can never rewrite hypotheses and a GENERATE action can
 * never touch research. The reference date is pinned per cycle so every
 * derived recompute (intelligence, signatures) replays identically.
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

  async run(): Promise<ReasoningState> {
    let reasoning = await this.readReasoning()
    if (reasoning && (reasoning.status === "STOPPED" || reasoning.status === "NEEDS_HUMAN")) {
      this.logger.info("reasoning", `no-op resume: state is ${reasoning.status}`)
      return reasoning
    }

    const research = await this.memory.get<ResearchBundle>("research")
    if (!research && !this.options.research) {
      throw new Error(
        'reasoning requires a research bundle (memory key "research" or engine option)',
      )
    }

    // Pin the reference date once: same baseline artifact + same date → the
    // whole cycle replays byte-identically (Scenario F determinism).
    const referenceDate =
      reasoning?.cycleContext?.referenceDate ?? (await this.resolveReferenceDate())

    if (!reasoning) {
      await this.seedFirstCycle(referenceDate)
      reasoning = {
        project: this.options.project,
        question: this.options.question,
        cycleContext: null,
        steps: [],
        lastStopping: null,
        status: "RUNNING",
      }
    }

    let currentResearch = research ?? this.options.research!
    let currentVersions = await this.readVersions()

    const cycleContext =
      reasoning.cycleContext ??
      (await this.buildCycleContext(currentResearch, currentVersions, referenceDate))
    reasoning = { ...reasoning, cycleContext }
    await this.controlWrite(reasoning)

    while (true) {
      if (reasoning.steps.length >= cycleContext.budget.maxSteps) {
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
        reasoning = this.finishReasoning(
          reasoning,
          {
            kind: "STOP",
            stoppingKind: "STOP_RESEARCH_LIMIT",
            reason: `maximum reasoning steps (${cycleContext.budget.maxSteps}) exceeded`,
          },
          signatureBefore,
          cycleContext,
        )
        await this.controlWrite(reasoning)
        return reasoning
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
        cycleSteps: reasoning.steps,
        stateSignatureBefore: signatureBefore,
        cycleContext,
        humanInTheLoop: this.options.humanInTheLoop,
      })
      const plan = planReasoning(situation)

      if (plan.terminating) {
        reasoning = this.finishReasoning(
          reasoning,
          plan.action as Extract<ReasoningAction, { kind: "STOP" }>,
          signatureBefore,
          cycleContext,
        )
        await this.controlWrite(reasoning)
        this.logger.info(
          "reasoning",
          `stopped: ${(plan.action as Extract<ReasoningAction, { kind: "STOP" }>).stoppingKind} — ${plan.terminalReason ?? ""}`,
        )
        return reasoning
      }

      const stepId = makeId(STEP_PREFIX, reasoning.steps.length + 1)

      if (GATED_KINDS.has(plan.action.kind)) {
        const decision = await this.approvals.review(
          "reasoning",
          this.candidateSummary(plan.action),
        )
        if (!decision.approved) {
          reasoning = this.record(
            reasoning,
            stepId,
            cycleContext,
            plan.action,
            signatureBefore,
            signatureBefore,
            ["reasoning"],
            [decision.message ?? "blocked by the approval gate"],
            "BLOCKED",
          )
          this.logger.warn("reasoning", `blocked ${plan.action.kind} (${stepId})`)
          await this.controlWrite(reasoning)
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
      const signatureAfter = this.computeSignature(
        currentResearch,
        currentVersions,
        result.intelligence ?? intelligence,
        cycleContext,
      )

      reasoning = this.record(
        reasoning,
        stepId,
        cycleContext,
        plan.action,
        signatureBefore,
        signatureAfter,
        result.writes,
        result.notes,
        "COMPLETED",
      )
      await this.controlWrite(reasoning)
      this.logger.info(
        "reasoning",
        `step ${stepId}: ${plan.action.kind} → ${this.targetLabel(plan.action)}`,
      )

      if (result.requiresHuman) {
        reasoning = {
          ...reasoning,
          status: "NEEDS_HUMAN",
          lastStopping: {
            stoppingKind: "STOP_HUMAN_REQUIRED",
            reason:
              plan.action.kind === "REQUEST_HUMAN_INPUT"
                ? plan.action.question
                : "human input required",
            at: cycleContext.referenceDate,
          },
        }
        await this.controlWrite(reasoning)
        return reasoning
      }
    }
  }

  /** Seeds a fresh cycle: v0.4 hypotheses become v1 versions, intelligence recomputed. */
  private async seedFirstCycle(referenceDate: string): Promise<void> {
    const existing = await this.readVersions()
    if (existing.length > 0) return
    const bundle = (await this.memory.get<ResearchBundle>("research")) ?? this.options.research
    const seeded = importHypotheses(this.options.hypotheses, "STEP_000")
    await this.memory.save("hypothesis-versions", seeded)
    await this.memory.save("hypotheses", this.hypothesesArtifact(seeded, bundle))
    // Intelligence is only (re)built when it does not yet exist: at a cycle
    // boundary the epistemic state is unchanged, so the persisted report is
    // kept byte-for-byte instead of being rewritten with cycle-specific limits.
    if (bundle) {
      const existingIntelligence = await this.memory.get<ResearchIntelligenceReport>("intelligence")
      if (existingIntelligence === null) {
        await this.memory.save(
          "intelligence",
          this.rebuildIntelligence(bundle, seeded, referenceDate),
        )
      }
    }
  }

  private async buildCycleContext(
    research: ResearchBundle,
    versions: HypothesisVersion[],
    referenceDate: string,
  ): Promise<CycleContext> {
    const base: CycleContext = {
      cycleId: makeId(CYCLE_PREFIX, 1),
      referenceDate,
      budget: this.budget,
      stateSignature: "",
    }
    const intelligence = await this.readIntelligence(research, versions, base)
    base.stateSignature = this.computeSignature(research, versions, intelligence, base)
    return base
  }

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
        const intelligence = this.rebuildIntelligence(
          result.bundle,
          versions,
          cycleContext.referenceDate,
        )
        await this.epistemicWrite("RESEARCH", {
          research: result.bundle,
          intelligence,
        })
        return {
          research: result.bundle,
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
        return { writes: ["reasoning"], notes: [action.question], requiresHuman: true }

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

  /**
   * The published `hypotheses` artifact keeps the v0.4 wrapper shape
   * `{ hypotheses, verifications }` so the pipeline stages, the trace viewer
   * and re-seeding all consume a consistent, non-destructive format. The
   * version log remains the source of truth; verifications are the pure
   * derivative of the active pointers (never written into the versions).
   */
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

  private record(
    reasoning: ReasoningState,
    id: string,
    cycleContext: CycleContext,
    action: ReasoningAction,
    signatureBefore: string,
    signatureAfter: string,
    writes: string[],
    notes: string[],
    status: StepStatus,
  ): ReasoningState {
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
    return { ...reasoning, cycleContext, steps: [...reasoning.steps, step] }
  }

  private finishReasoning(
    reasoning: ReasoningState,
    action: Extract<ReasoningAction, { kind: "STOP" }>,
    signatureBefore: string,
    cycleContext: CycleContext,
  ): ReasoningState {
    const step: ReasoningStep = {
      id: makeId(STEP_PREFIX, reasoning.steps.length + 1),
      cycleContext: { cycleId: cycleContext.cycleId, referenceDate: cycleContext.referenceDate },
      action,
      status: "COMPLETED",
      stateSignatureBefore: signatureBefore,
      stateSignatureAfter: signatureBefore,
      performedAt: cycleContext.referenceDate,
      writes: ["reasoning"],
      notes: [],
    }
    return {
      ...reasoning,
      cycleContext,
      steps: [...reasoning.steps, step],
      lastStopping: {
        stoppingKind: action.stoppingKind,
        reason: action.reason,
        at: cycleContext.referenceDate,
      },
      status: "STOPPED",
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
      case "STOP":
        return action.kind === "REQUEST_HUMAN_INPUT" ? action.target : action.stoppingKind
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

  /** Pins the date to the baseline intelligence artifact when nothing else says otherwise. */
  private async resolveReferenceDate(): Promise<string> {
    if (this.referenceDate) return this.referenceDate
    const existing = await this.memory.get<ResearchIntelligenceReport>("intelligence")
    return existing?.generatedAt ?? new Date().toISOString()
  }

  private async readVersions(): Promise<HypothesisVersion[]> {
    return (await this.memory.get<HypothesisVersion[]>("hypothesis-versions")) ?? []
  }

  private async readIntelligence(
    research: ResearchBundle,
    versions: HypothesisVersion[],
    cycleContext: CycleContext,
  ): Promise<ResearchIntelligenceReport> {
    const existing = await this.memory.get<ResearchIntelligenceReport>("intelligence")
    if (existing) return existing
    return this.rebuildIntelligence(research, versions, cycleContext.referenceDate)
  }

  private async readReasoning(): Promise<ReasoningState | null> {
    const raw = await this.memory.get<unknown>("reasoning")
    if (raw === null) return null
    const { state } = ReasoningStateVersionSchema.parse(raw)
    return state
  }

  private async controlWrite(state: ReasoningState): Promise<void> {
    await this.memory.save("reasoning", { version: 1, state })
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
}
