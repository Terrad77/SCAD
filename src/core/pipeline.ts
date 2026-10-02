import type { MemoryStore } from "./memory/json-memory.js"
import { ScopedMemory } from "./memory/scoped-memory.js"
import { RecordingMemory } from "./memory/recording-memory.js"
import { STAGE_WRITE_SCOPE } from "./production/write-scope.js"
import {
  ApprovalLedger,
  contentSignature,
  dependencySignature,
  type ApprovalAuthority,
  type StageProposal,
} from "./production/approval.js"
import type { EpistemicPreparationResult } from "../agents/production/epistemic-prep.js"
import type { ReasoningContext } from "./production/types.js"
import type {
  ClaimsOutput,
  FactCheckOutput,
  HypothesesOutput,
  Narrative,
  ResearchOutput,
  SelfCheckOutput,
  VisualOutput,
} from "./schemas.js"

export interface PipelineArtifacts {
  research?: ResearchOutput
  claims?: ClaimsOutput
  hypotheses?: HypothesesOutput
  factCheck?: FactCheckOutput
  /** v0.7 — the idempotent epistemic-preparation result (intelligence envelope). */
  epistemicPreparation?: EpistemicPreparationResult
  /** v0.7 — the signed reasoning→production handoff, built once and reused. */
  reasoningContext?: ReasoningContext
  narrative?: Narrative
  visual?: VisualOutput
  selfCheck?: SelfCheckOutput
}

export type PipelineRunner = (
  stage: string,
  context: Record<string, unknown>,
  options?: { regenerate?: boolean },
) => Promise<unknown>

export interface ApprovalDecision {
  approved: boolean
  message?: string
  /** Re-run the current stage and review the freshly generated artifact again. */
  regenerate?: boolean
  /** Human-edited replacement for the current artifact (considered approved). */
  replacement?: unknown
  /**
   * v0.7 (H7) — who decided. Absent means a human (the interactive gate is the
   * default); `auto` records that a machine made the call. Recorded verbatim, so
   * an automated run can never be read back as a human sign-off.
   */
  authority?: ApprovalAuthority
}

export interface ApprovalGate {
  review(stage: string, artifact: unknown): Promise<ApprovalDecision>
}

/** Auto-approves every checkpoint — used for automation and tests. */
export class AutoApprover implements ApprovalGate {
  async review(): Promise<ApprovalDecision> {
    // Explicitly `auto`: this is a machine disposition, and the ledger must be
    // able to tell it apart from a person having read the artifact.
    return { approved: true, authority: "auto" }
  }
}

export const PIPELINE_ORDER = [
  "research",
  "claims",
  "hypotheses",
  "factCheck",
  "epistemicPreparation",
  "reasoningContext",
  "narrative",
  "visual",
  "selfCheck",
] as const

export type PipelineStage = (typeof PIPELINE_ORDER)[number]

/**
 * Runs the SCAD reasoning pipeline with resumable checkpoints.
 * Each completed stage is persisted to memory. On resume, completed stages are
 * skipped and execution continues from the first incomplete stage.
 *
 * v0.7 — every stage persists through a `ScopedMemory` restricted to that
 * stage's declared write scope (`STAGE_WRITE_SCOPE`), so the cognitive side and
 * the production side are physically separated: a production stage cannot write
 * an epistemic artifact even if it tries (I1, I16, I18).
 *
 * v0.7 (H7) — "completed" is no longer inferred from the artifact existing.
 * A stage is skipped on resume only when an approval record exists that is bound
 * to the sha256 of that exact artifact content AND of the upstream artifacts it
 * was built from. Otherwise the checkpoint is re-reviewed, so a crash inside a
 * review can never hand an unapproved artifact — a reasoning context in
 * particular — to the stage downstream of it.
 */
export class Pipeline {
  private readonly ledger: ApprovalLedger

  constructor(
    private readonly memory: MemoryStore,
    private readonly approvals: ApprovalGate,
    private readonly runStage: PipelineRunner,
    readonly initialContext: Record<string, unknown> = {},
    private readonly onStageWrite?: (stage: string, key: string) => void,
  ) {
    this.ledger = new ApprovalLedger(memory)
  }

  /** The store a stage may use: scoped when the stage declares a scope. */
  private storeFor(stage: string): MemoryStore {
    const scope = STAGE_WRITE_SCOPE[stage]
    const scoped = scope === undefined ? this.memory : new ScopedMemory(this.memory, new Set(scope))
    return new RecordingMemory(scoped, (key) => this.onStageWrite?.(stage, key))
  }

  async run(
    force = false,
    forceStages: ReadonlySet<string> = new Set(),
  ): Promise<PipelineArtifacts> {
    const artifacts: PipelineArtifacts = {}
    const context = { ...this.initialContext }
    const regenerate = (stage: string) => force || forceStages.has(stage)
    /** The upstream artifacts each stage was given, for dependency binding. */
    const consumed: Record<string, unknown> = {}
    let epistemicChanged = false

    for (const stage of PIPELINE_ORDER) {
      const store = this.storeFor(stage)
      const existing = await this.memory.get<unknown>(stage)

      const epistemicStage = ["research", "claims", "hypotheses", "factCheck"].includes(stage)
      const refreshPreparation = stage === "epistemicPreparation" && epistemicChanged
      if (existing !== null && !regenerate(stage) && !refreshPreparation) {
        const proposal = proposalFor(stage, existing, consumed)
        if (await this.ledger.isApproved(proposal)) {
          artifacts[stage as keyof PipelineArtifacts] = existing as never
          context[stage] = existing
          consumed[stage] = existing
          continue
        }
        // The artifact is on disk but nothing proves anyone approved THIS
        // content. Re-open the checkpoint on the persisted artifact rather than
        // silently treating a file's existence as a human decision.
        artifacts[stage as keyof PipelineArtifacts] = existing as never
        context[stage] = existing
        await this.review(stage, store, existing, consumed, artifacts, context)
        if (epistemicStage && contentSignature(existing) !== contentSignature(context[stage])) {
          epistemicChanged = true
        }
        consumed[stage] = context[stage]
        continue
      }

      const result = await this.runStage(stage, context)
      if (epistemicStage) epistemicChanged = true
      if (result !== undefined) {
        await store.save(stage, result)
        artifacts[stage as keyof PipelineArtifacts] = result as never
      }
      context[stage] = result

      await this.review(stage, store, result, consumed, artifacts, context)
      consumed[stage] = context[stage]
    }

    return artifacts
  }

  /**
   * The review loop for one stage, ending with a recorded approval.
   *
   * Only a HUMAN decision is recorded. A machine disposition (`auto`) is
   * accepted and moved past, but it is never written to the ledger, for two
   * reasons: governance state stays something a person authored, and an `auto`
   * record could otherwise let a later interactive run skip a checkpoint that no
   * person has ever read. Re-running an auto gate costs nothing.
   *
   * A human approval is written AFTER the (possibly replaced) artifact is
   * persisted, so the recorded signature always describes what is actually on
   * disk. A crash in between leaves no approval, and the next run re-reviews —
   * the safe direction, since re-asking a human is cheap and acting on an
   * unapproved artifact is not.
   */
  private async review(
    stage: string,
    store: MemoryStore,
    initial: unknown,
    consumed: Record<string, unknown>,
    artifacts: PipelineArtifacts,
    context: Record<string, unknown>,
  ): Promise<void> {
    let result = initial

    while (true) {
      const decision = await this.approvals.review(stage, result)

      if (decision.approved) {
        if (decision.replacement !== undefined && result !== undefined) {
          // A human reviewer hand-edited the artifact; persist the new version.
          result = decision.replacement
          await store.save(stage, result)
          artifacts[stage as keyof PipelineArtifacts] = result as never
          context[stage] = result
        }
        // An unset authority is read as human: a gate that cannot say who
        // decided gets the stricter treatment.
        if ((decision.authority ?? "human") === "human") {
          const proposal = proposalFor(stage, result, consumed)
          await this.ledger.record({
            stage,
            artifactSignature: proposal.artifactSignature,
            dependencySignature: proposal.dependencySignature,
            decidedAt: new Date().toISOString(),
            authority: "human",
            modified: decision.replacement !== undefined,
          })
        }
        return
      }

      if (decision.regenerate) {
        result = await this.runStage(stage, context, { regenerate: true })
        if (result !== undefined) {
          await store.save(stage, result)
          artifacts[stage as keyof PipelineArtifacts] = result as never
        }
        context[stage] = result
        continue
      }

      await store.remove(stage)
      throw new StageRejectedError(stage, decision.message ?? "Rejected by human reviewer")
    }
  }
}

/** The identity a reviewer is asked to consent to. */
function proposalFor(
  stage: string,
  artifact: unknown,
  consumed: Record<string, unknown>,
): StageProposal {
  return {
    stage,
    artifactSignature: contentSignature(artifact),
    dependencySignature: dependencySignature(consumed),
  }
}

export class StageRejectedError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(`Stage ${stage} was rejected: ${message}`)
  }
}
