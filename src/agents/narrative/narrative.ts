import { NarrativeSchema } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import { guardNarrative } from "../../core/production/guards.js"
import type { ReasoningContext } from "../../core/production/types.js"
import type {
  Narrative,
  ClaimsOutput,
  HypothesesOutput,
  ResearchOutput,
} from "../../core/schemas.js"

export interface NarrativeInput {
  question: string
  title: string
  research: ResearchOutput
  claims: ClaimsOutput
  hypotheses: HypothesesOutput
  targetMinutes?: number
  /**
   * v0.7 — the signed reasoning→production handoff. When present it is passed to
   * the LLM as the constraint source AND the deterministic guard runs on the
   * result, so the prompt is never the only carrier of an epistemic rule.
   * Optional: without it the agent behaves exactly as in v0.6.
   */
  reasoningContext?: ReasoningContext
}

export class NarrativeAgent {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: NarrativeInput): Promise<Narrative> {
    const context = input.reasoningContext
    const narrative = await this.agent.run("narrative", NarrativeSchema, {
      question: input.question,
      title: input.title,
      research: input.research,
      claims: input.claims,
      hypotheses: input.hypotheses,
      ...(input.targetMinutes !== undefined ? { targetMinutes: input.targetMinutes } : {}),
      ...(context ? { reasoningContext: contextForPrompt(context) } : {}),
    })
    // The guard is not optional when a context exists: it is the enforcement.
    if (context === undefined) return narrative
    return guardNarrative(narrative, context).artifact
  }
}

/**
 * The LLM-facing projection of the context: the constraint list plus the
 * classification it must obey. Omits internal signatures so the prompt stays
 * readable and no hash leaks into model output.
 */
export function contextForPrompt(context: ReasoningContext): Record<string, unknown> {
  return {
    decision: {
      actionKind: context.decision.actionKind,
      status: context.decision.status,
      stoppingKind: context.decision.stoppingKind,
      cycleCompleted: context.decision.cycleCompleted,
      humanInTheLoop: context.decision.humanInTheLoop,
    },
    epistemicSummary: context.epistemicSummary,
    claims: context.claims.map((claim) => ({
      id: claim.claimId,
      knowledge: claim.knowledge,
      status: claim.status,
      confidence: claim.confidence,
      usableAsFact: claim.usable,
    })),
    activeHypotheses: context.activeHypotheses.map((hypothesis) => ({
      id: hypothesis.hypothesisId,
      status: hypothesis.status,
      verificationStatus: hypothesis.verificationStatus,
      confidence: hypothesis.confidence,
      supportingClaimIds: hypothesis.supportingClaimIds,
      contradictingClaimIds: hypothesis.contradictingClaimIds,
    })),
    uncertainties: context.uncertainties.map((uncertainty) => ({
      id: uncertainty.uncertaintyId,
      kind: uncertainty.kind,
      subjectId: uncertainty.subjectId,
      detail: uncertainty.detail,
    })),
    constraints: context.constraints.map((constraint) => ({
      id: constraint.id,
      kind: constraint.kind,
      severity: constraint.severity,
      rule: constraint.rule,
      subjectIds: constraint.subjectIds,
    })),
  }
}
