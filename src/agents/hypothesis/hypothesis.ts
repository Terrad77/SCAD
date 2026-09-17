import { HypothesesOutputSchema } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import type { HypothesesOutput, ClaimsOutput } from "../../core/schemas.js"

export interface HypothesesInput {
  question: string
  claims: ClaimsOutput
}

export class HypothesisAgent {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: HypothesesInput): Promise<HypothesesOutput> {
    return this.agent.run("hypothesis", HypothesesOutputSchema, input)
  }
}
