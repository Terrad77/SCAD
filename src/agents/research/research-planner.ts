import { ResearchPlanOutputSchema } from "../../core/schemas.js"
import type { ResearchPlan } from "../../core/schemas.js"
import { StructuredAgent, StructuredError } from "../../core/structured-agent.js"
import { getLogger } from "../../core/log.js"
import { RESEARCH_SUBQUESTION_PREFIX } from "./ids.js"

export interface ResearchPlannerInput {
  question: string
  maxSubQuestions?: number
}

/**
 * Decomposes a research question into 4-10 researchable sub-questions.
 * The LLM output is validated with Zod; if the model output is unusable the
 * planner falls back to a deterministic single-focus plan so the pipeline
 * never hard-blocks on one failed call.
 */
export class ResearchPlanner {
  constructor(private readonly agent: StructuredAgent) {}

  async plan(input: ResearchPlannerInput): Promise<ResearchPlan> {
    const { question, maxSubQuestions = 10 } = input
    try {
      const output = await this.agent.run<typeof ResearchPlanOutputSchema>(
        "research-plan",
        ResearchPlanOutputSchema,
        { question },
        { maxRetries: 0 },
      )
      const subs = output.plan.subQuestions.slice(0, maxSubQuestions)
      return { ...output.plan, subQuestions: subs }
    } catch (error) {
      getLogger().warn(
        "research",
        `research-plan fell back to deterministic planner: ${String(error)}`,
      )
      if (error instanceof StructuredError || error instanceof SyntaxError) {
        return buildFallbackPlan(question, [], `PLAN_001`)
      }
      throw error
    }
  }
}

/**
 * Deterministic fallback planner. Generates a minimal research plan so the
 * pipeline works offline or when the LLM response cannot be validated.
 */
export function buildFallbackPlan(
  question: string,
  subQuestionTexts: string[] = [],
  planId = "PLAN_001",
): ResearchPlan {
  const texts =
    subQuestionTexts.length > 0
      ? subQuestionTexts
      : [`Foundational background on: ${question}`, `Evidence and counter-evidence on: ${question}`]
  const subQuestions = texts.map((text, index) => ({
    id: `${RESEARCH_SUBQUESTION_PREFIX}${String(index + 1).padStart(3, "0")}`,
    text,
  }))
  return { id: planId, question, scope: "Fallback deterministic scope.", subQuestions }
}
