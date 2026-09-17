import type { MemoryStore } from "./memory/json-memory.js"
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
  narrative?: Narrative
  visual?: VisualOutput
  selfCheck?: SelfCheckOutput
}

export type PipelineRunner = (stage: string, context: Record<string, unknown>) => Promise<unknown>

export interface ApprovalDecision {
  approved: boolean
  message?: string
}

export interface ApprovalGate {
  review(stage: string, artifact: unknown): Promise<ApprovalDecision>
}

/** Auto-approves every checkpoint — used for automation and tests. */
export class AutoApprover implements ApprovalGate {
  async review(): Promise<ApprovalDecision> {
    return { approved: true }
  }
}

export const PIPELINE_ORDER = [
  "research",
  "claims",
  "hypotheses",
  "factCheck",
  "narrative",
  "visual",
  "selfCheck",
] as const

export type PipelineStage = (typeof PIPELINE_ORDER)[number]

/**
 * Runs the SCAD reasoning pipeline with resumable checkpoints.
 * Each completed stage is persisted to memory. On resume, completed stages are
 * skipped and execution continues from the first incomplete stage.
 */
export class Pipeline {
  constructor(
    private readonly memory: MemoryStore,
    private readonly approvals: ApprovalGate,
    private readonly runStage: PipelineRunner,
    readonly initialContext: Record<string, unknown> = {},
  ) {}

  async run(force = false): Promise<PipelineArtifacts> {
    const artifacts: PipelineArtifacts = {}
    const context = { ...this.initialContext }

    for (const stage of PIPELINE_ORDER) {
      const existing = await this.memory.get<unknown>(stage)
      if (existing !== null && !force) {
        artifacts[stage as keyof PipelineArtifacts] = existing as never
        context[stage] = existing
        continue
      }

      const result = await this.runStage(stage, context)
      if (result !== undefined) {
        await this.memory.save(stage, result)
        artifacts[stage as keyof PipelineArtifacts] = result as never
      }
      context[stage] = result

      const decision = await this.approvals.review(stage, result)
      if (!decision.approved) {
        await this.memory.remove(stage)
        throw new StageRejectedError(stage, decision.message ?? "Rejected by human reviewer")
      }
    }

    return artifacts
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
