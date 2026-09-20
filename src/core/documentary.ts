import { StructuredAgent, readPromptFile } from "./structured-agent.js"
import { JsonMemoryStore } from "./memory/json-memory.js"
import { Pipeline, AutoApprover, ApprovalGate, type PipelineArtifacts } from "./pipeline.js"
import { ResearchEngine, type ResearchEngineOptions } from "../agents/research/research-engine.js"
import { ClaimsAgent } from "../agents/claims/claims.js"
import { HypothesisAgent } from "../agents/hypothesis/hypothesis.js"
import { verifyHypotheses } from "../agents/hypothesis/verify.js"
import { FactCheckEngine } from "../agents/fact-check/fact-check.js"
import { NarrativeAgent } from "../agents/narrative/narrative.js"
import { VisualAgent } from "../agents/visual/visual.js"
import { SelfCheckEngine } from "../agents/self-check/self-check.js"
import { ResearchIntelligenceEngine } from "../agents/research/research-intelligence.js"
import { TraceService } from "./trace.js"
import { buildTraceabilityReport } from "./traceability.js"
import type { LLMProvider } from "../providers/llm/llm.js"
import { MockSearchProvider } from "../providers/search/mock-search-provider.js"
import type { SearchProvider } from "../providers/search/search-provider.js"
import type { ContentProvider } from "../providers/content/content-provider.js"
import type {
  ClaimsOutput,
  HypothesisVerification,
  HypothesesOutput,
  Narrative,
  ResearchBundle,
  ResearchIntelligenceReport,
  VisualOutput,
} from "./schemas.js"

export interface DocumentaryOptions {
  provider: LLMProvider
  memoryDir: string
  question: string
  title: string
  approvals?: ApprovalGate
  force?: boolean
  /** Regenerate only this stage (with `--force` on a stage command). */
  forceStage?: string
  /** Search backend for the Evidence & Research Engine (defaults to mock). */
  search?: SearchProvider
  /** Optional full-content fetcher for evidence extraction (defaults to none). */
  content?: ContentProvider
  /**
   * ISO date the freshness calculation is relative to. When omitted, the run
   * time is used; set it explicitly (e.g. via SCAD_REFERENCE_DATE) for
   * reproducible intelligence scores.
   */
  referenceDate?: string
  research?: Pick<
    ResearchEngineOptions,
    | "maxSubQuestions"
    | "maxFollowUpRounds"
    | "followUpLimit"
    | "maxSourcesPerQuery"
    | "maxSources"
    | "maxContentBytes"
  >
}

export interface HypothesesWithVerifications extends HypothesesOutput {
  verifications?: HypothesisVerification[]
}

export interface DocumentaryResult extends PipelineArtifacts {
  traceability: ReturnType<typeof buildTraceabilityReport>
  hypothesisVerifications?: HypothesisVerification[]
  /** v0.4 Research Intelligence report (deterministic, when research is a bundle). */
  intelligence?: ResearchIntelligenceReport
}

/** Narrowing check: is this (legacy) research artifact actually a ResearchBundle? */
function isResearchBundle(research: unknown): research is ResearchBundle {
  return Boolean(
    research &&
    typeof research === "object" &&
    Array.isArray((research as { claims?: unknown }).claims),
  )
}

/** Wires every agent and engine stage into the resumable pipeline. */
export async function runDocumentaryPipeline(
  options: DocumentaryOptions,
  sharedContext: Record<string, unknown> = {},
): Promise<DocumentaryResult> {
  const memory = new JsonMemoryStore(options.memoryDir)
  const approvals = options.approvals ?? new AutoApprover()
  const agent = new StructuredAgent(options.provider, readPromptFile)
  const search = options.search ?? new MockSearchProvider()

  const researchEngine = new ResearchEngine({
    question: options.question,
    agent,
    search,
    ...(options.content ? { content: options.content } : {}),
    ...(options.research ?? {}),
  })
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
          return researchEngine.run()
        case "claims": {
          const research = context.research as ResearchBundle
          if (research.claims && research.claims.length > 0) {
            // Deterministic passthrough: evidence-backed claims from research.
            return { claims: research.claims }
          }
          // Legacy research artifact (no claims) — fall back to the LLM claims stage.
          return claimsAgent.run({ question: options.question, research })
        }
        case "hypotheses": {
          const claims = context.claims as ClaimsOutput
          const research = context.research as ResearchBundle
          const output = await hypothesisAgent.run({
            question: options.question,
            claims,
            research,
          })
          const result = verifyHypotheses({
            hypotheses: output.hypotheses,
            research: research && research.claims ? research : undefined,
          })
          return { ...output, verifications: result.verifications } as HypothesesWithVerifications
        }
        case "factCheck": {
          const research = context.research as ResearchBundle
          const claims = context.claims as ClaimsOutput
          return { assessments: new FactCheckEngine(research).run(claims.claims) }
        }
        case "narrative": {
          const research = context.research as ResearchBundle
          const claims = context.claims as ClaimsOutput
          const hypotheses = context.hypotheses as HypothesesWithVerifications
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
          const research = context.research as ResearchBundle
          return new SelfCheckEngine().run({
            claims: claims.claims,
            narrative,
            shots: visual.shots,
            assessments: factCheck?.assessments,
            research: research && research.claims ? research : undefined,
          })
        }
        default:
          throw new Error(`Unknown stage: ${stage}`)
      }
    },
    sharedContext,
  )

  const artifacts = await pipeline.run(
    options.force ?? false,
    options.forceStage ? new Set([options.forceStage]) : undefined,
  )
  const research = artifacts.research as ResearchBundle | undefined
  const claims = artifacts.claims!
  const narrative = artifacts.narrative!
  const visual = artifacts.visual!
  const hypotheses = artifacts.hypotheses as HypothesesWithVerifications | undefined
  const verifications = hypotheses?.verifications ?? []

  const traceability = isResearchBundle(research)
    ? new TraceService(research, verifications).report(narrative, visual.shots)
    : buildTraceabilityReport(
        visual.shots,
        narrative,
        claims.claims,
        research ?? { sources: [], summary: "" },
      )

  let intelligence: ResearchIntelligenceReport | undefined
  if (isResearchBundle(research)) {
    intelligence = new ResearchIntelligenceEngine({
      research,
      verifications,
      referenceDate: options.referenceDate,
      limits: {
        maxSources: options.research?.maxSources,
        maxSubQuestions: options.research?.maxSubQuestions,
        maxFollowUpRounds: options.research?.maxFollowUpRounds,
      },
    }).run()
    await memory.save("intelligence", intelligence)
  }

  return {
    ...artifacts,
    traceability,
    ...(verifications.length > 0 ? { hypothesisVerifications: verifications } : {}),
    ...(intelligence ? { intelligence } : {}),
  }
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
