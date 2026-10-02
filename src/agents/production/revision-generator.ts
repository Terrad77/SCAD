import type { MemoryStore } from "../../core/memory/json-memory.js"
import {
  ClaimsOutputSchema,
  HypothesesOutputSchema,
  ResearchOutputSchema,
  NarrativeSchema,
  VisualOutputSchema,
  FactCheckOutputSchema,
  type ResearchBundle,
} from "../../core/schemas.js"
import type { RevisionGenerator } from "../../core/production/revisions.js"
import { StructuredAgent, readPromptFile } from "../../core/structured-agent.js"
import type { LLMProvider } from "../../providers/llm/llm.js"
import { contextForPrompt } from "../narrative/narrative.js"
import { SelfCheckEngine } from "../self-check/self-check.js"

/** Stateless generation reuses existing prompts and deterministic SelfCheck. No write capability. */
export function createRevisionGenerator(
  memory: MemoryStore,
  provider: LLMProvider,
): RevisionGenerator {
  const agent = new StructuredAgent(provider, readPromptFile)
  const read = async (key: string): Promise<unknown> => {
    const raw = await memory.readRaw(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  }
  return async (stage, draft) => {
    const context = draft.reasoningContext
    switch (stage) {
      case "reasoningContext":
        throw new Error("Only the revision engine builds the context")
      case "narrative":
        return agent.run("narrative", NarrativeSchema, {
          question: context.question,
          title: draft.narrative?.title ?? context.project,
          research: ResearchOutputSchema.parse(await read("research")),
          claims: ClaimsOutputSchema.parse(await read("claims")),
          hypotheses: HypothesesOutputSchema.parse(await read("hypotheses")),
          reasoningContext: contextForPrompt(context),
        })
      case "visual": {
        if (!draft.narrative) throw new Error("Narrative is required")
        return agent.run("visual", VisualOutputSchema, {
          narrative: draft.narrative,
          reasoningContext: contextForPrompt(context),
        })
      }
      case "selfCheck": {
        if (!draft.narrative || !draft.visual) throw new Error("Narrative and visual are required")
        const research = (await read("research")) as ResearchBundle
        const assessments = FactCheckOutputSchema.parse(await read("factCheck")).assessments
        return new SelfCheckEngine().run({
          claims: ClaimsOutputSchema.parse(await read("claims")).claims,
          narrative: draft.narrative,
          shots: draft.visual.shots,
          visual: draft.visual,
          research,
          assessments,
          reasoningContext: context,
          // Generation makes no stage-key writes. The audit does not certify future publication.
          productionWrites: [],
        })
      }
    }
  }
}
