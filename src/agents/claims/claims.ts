import { ClaimsOutputSchema } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import type { ResearchOutput, ClaimsOutput } from "../../core/schemas.js"

export interface ClaimsInput {
  question: string
  research: ResearchOutput
}

export class ClaimsAgent {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: ClaimsInput): Promise<ClaimsOutput> {
    return this.agent.run("claims", ClaimsOutputSchema, input)
  }
}
