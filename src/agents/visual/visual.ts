import { VisualOutputSchema } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import { guardVisual } from "../../core/production/guards.js"
import { contextForPrompt } from "../narrative/narrative.js"
import type { ReasoningContext } from "../../core/production/types.js"
import type { VisualOutput, Narrative } from "../../core/schemas.js"

export interface VisualInput {
  narrative: Narrative
  /** v0.7 — the signed reasoning→production handoff (optional; v0.6 compatible). */
  reasoningContext?: ReasoningContext
}

export class VisualAgent {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: VisualInput): Promise<VisualOutput> {
    const context = input.reasoningContext
    const visual = await this.agent.run("visual", VisualOutputSchema, {
      narrative: input.narrative,
      ...(context ? { reasoningContext: contextForPrompt(context) } : {}),
    })
    if (context === undefined) return visual
    return guardVisual(visual, input.narrative, context).artifact
  }
}
