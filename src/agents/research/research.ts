import { ResearchOutputSchema } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import type { ResearchOutput } from "../../core/schemas.js"

export interface ResearchInput {
  question: string
  title: string
}

export class ResearchAgent {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: ResearchInput): Promise<ResearchOutput> {
    return this.agent.run("research", ResearchOutputSchema, input)
  }
}
