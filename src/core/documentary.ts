import { StructuredAgent, readPromptFile } from "./structured-agent.js"
import { JsonMemoryStore } from "./memory/json-memory.js"
import { Pipeline, AutoApprover, ApprovalGate, type PipelineArtifacts } from "./pipeline.js"
import { ResearchAgent } from "../agents/research/research.js"
import { ClaimsAgent } from "../agents/claims/claims.js"
import { HypothesisAgent } from "../agents/hypothesis/hypothesis.js"
import { FactCheckEngine } from "../agents/fact-check/fact-check.js"
import { NarrativeAgent } from "../agents/narrative/narrative.js"
import { VisualAgent } from "../agents/visual/visual.js"
import { SelfCheckEngine } from "../agents/self-check/self-check.js"
import { buildTraceabilityReport } from "./traceability.js"
import type { LLMProvider } from "../providers/llm/llm.js"
import type { ClaimsOutput, Narrative, ResearchOutput, VisualOutput } from "./schemas.js"

export interface DocumentaryOptions {
  provider: LLMProvider
  memoryDir: string
  question: string
  title: string
  approvals?: ApprovalGate
  force?: boolean
}

export interface DocumentaryResult extends PipelineArtifacts {
  traceability: ReturnType<typeof buildTraceabilityReport>
}

/** Wires every agent and engine stage into the resumable pipeline. */
export async function runDocumentaryPipeline(
  options: DocumentaryOptions,
  sharedContext: Record<string, unknown> = {},
): Promise<DocumentaryResult> {
  const memory = new JsonMemoryStore(options.memoryDir)
  const approvals = options.approvals ?? new AutoApprover()
  const agent = new StructuredAgent(options.provider, readPromptFile)

  const researchAgent = new ResearchAgent(agent)
  const claimsAgent = new ClaimsAgent(agent)
  const hypothesisAgent = new HypothesisAgent(agent)
  const narrativeAgent = new NarrativeAgent(agent)
  const visualAgent = new VisualAgent(agent)

  const pipeline = new Pipeline(
    memory,
    approvals,
    async (stage, context) => {
      switch (stage) {
        case "research":
          return researchAgent.run({
            question: options.question,
            title: options.title,
          })
        case "claims": {
          const research = context.research as ResearchOutput
          return claimsAgent.run({ question: options.question, research })
        }
        case "hypotheses": {
          const claims = context.claims as ClaimsOutput
          return hypothesisAgent.run({ question: options.question, claims })
        }
        case "factCheck": {
          const research = context.research as ResearchOutput
          const claims = context.claims as ClaimsOutput
          return { assessments: new FactCheckEngine(research).run(claims.claims) }
        }
        case "narrative": {
          const research = context.research as ResearchOutput
          const claims = context.claims as ClaimsOutput
          const hypotheses = context.hypotheses as PipelineArtifacts["hypotheses"]
          return narrativeAgent.run({
            question: options.question,
            title: options.title,
            research,
            claims,
            hypotheses: hypotheses ?? { hypotheses: [] },
          })
        }
        case "visual": {
          const narrative = context.narrative as Narrative
          return visualAgent.run({ narrative })
        }
        case "selfCheck": {
          const claims = context.claims as ClaimsOutput
          const narrative = context.narrative as Narrative
          const visual = context.visual as VisualOutput
          const factCheck = context.factCheck as {
            assessments?: Array<{ claimId: string; verdict: string }>
          }
          return new SelfCheckEngine().run({
            claims: claims.claims,
            narrative,
            shots: visual.shots,
            assessments: factCheck?.assessments,
          })
        }
        default:
          throw new Error(`Unknown stage: ${stage}`)
      }
    },
    sharedContext,
  )

  const artifacts = await pipeline.run(options.force ?? false)
  const research = artifacts.research!
  const claims = artifacts.claims!
  const narrative = artifacts.narrative!
  const visual = artifacts.visual!

  const traceability = buildTraceabilityReport(visual.shots, narrative, claims.claims, research)
  return { ...artifacts, traceability }
}

/** Renders a human-readable script markdown from the approved narrative. */
export function renderScript(narrative: Parameters<typeof buildTraceabilityReport>[1]): string {
  const lines: string[] = []
  lines.push(`# ${narrative.title}`)
  lines.push("")
  lines.push(`**Logline:** ${narrative.logline}`)
  lines.push("")
  lines.push(narrative.thesis)
  lines.push("")

  for (const section of narrative.sections) {
    lines.push(`## ${section.heading}`)
    lines.push("")
    for (const sentence of section.sentences) {
      const tag = `[${sentence.knowledge}]`
      const trace = sentence.claimIds.length ? ` *(claims: ${sentence.claimIds.join(", ")})*` : ""
      lines.push(`${tag} ${sentence.text}${trace}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
