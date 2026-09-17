import { NarrativeSchema } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
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
}

export class NarrativeAgent {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: NarrativeInput): Promise<Narrative> {
    return this.agent.run("narrative", NarrativeSchema, input)
  }
}
