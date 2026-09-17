import { VisualOutputSchema } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import type { VisualOutput, Narrative } from "../../core/schemas.js"

export interface VisualInput {
  narrative: Narrative
}

export class VisualAgent {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: VisualInput): Promise<VisualOutput> {
    return this.agent.run("visual", VisualOutputSchema, input)
  }
}
