import { assertNoPendingProductionRevision } from "./production/revisions.js"
import { StructuredAgent, readPromptFile } from "./structured-agent.js"
import { JsonMemoryStore } from "./memory/json-memory.js"
import { ScopedMemory } from "./memory/scoped-memory.js"
import { Pipeline, AutoApprover, ApprovalGate, type PipelineArtifacts } from "./pipeline.js"
import { ResearchEngine, type ResearchEngineOptions } from "../agents/research/research-engine.js"
import { ClaimsAgent } from "../agents/claims/claims.js"
import { HypothesisAgent } from "../agents/hypothesis/hypothesis.js"
import { verifyHypotheses } from "../agents/hypothesis/verify.js"
import { FactCheckEngine } from "../agents/fact-check/fact-check.js"
import { NarrativeAgent } from "../agents/narrative/narrative.js"
import { VisualAgent } from "../agents/visual/visual.js"
import { SelfCheckEngine } from "../agents/self-check/self-check.js"
import { buildReasoningContext } from "../agents/production/reasoning-context.js"
import { ProductionEngine } from "../agents/production/production-engine.js"
import {
  intelligenceEnvelopeToPersist,
  prepareEpistemicState,
} from "../agents/production/epistemic-prep.js"
import type { IntelligenceLimits } from "./reasoning/types.js"
import { PRODUCTION_WRITE_KEYS, EPISTEMIC_PREP_WRITE_KEYS } from "./production/write-scope.js"
import { TraceService } from "./trace.js"
import { verifyContextIntegrity } from "./production/signature.js"
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
import type {
  ProductionManifest,
  ProductionStaleness,
  ReasoningContext,
} from "./production/types.js"

export interface DocumentaryOptions {
  provider: LLMProvider
  memoryDir: string
  question: string
  title: string
  /** Project name; defaults to the memory directory basename. */
  project?: string
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
   *
   * v0.7: resolved ONCE per run and shared by the intelligence computation and
   * the reasoning context, so the two can never disagree about "now".
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
  /** v0.7 reasoning→production handoff (present once the stage has run). */
  reasoningContext?: ReasoningContext
  /** v0.7 production manifest: context refs, constraints, staleness. */
  production?: ProductionManifest
  /** v0.7 staleness of the persisted production artifacts. */
  staleness?: ProductionStaleness
}

/** Narrowing check: is this (legacy) research artifact actually a ResearchBundle? */
function isResearchBundle(research: unknown): research is ResearchBundle {
  return Boolean(
    research &&
    typeof research === "object" &&
    Array.isArray((research as { claims?: unknown }).claims),
  )
}

/** The research options are always present in practice; the shape guard is for
 * the in-memory re-read used to decide whether limits apply. */
function isResearchBundleShape(
  research: DocumentaryOptions["research"],
): research is NonNullable<DocumentaryOptions["research"]> {
  return research !== undefined
}

/**
 * v0.7: the caps that actually shape the intelligence report, or `undefined`
 * when none were configured. `undefined` (not a bag of `undefined` fields) is
 * what keeps the freshness signature identical to a run with no caps at all.
 */
function intelligenceLimitsOf(
  research: DocumentaryOptions["research"],
): IntelligenceLimits | undefined {
  if (!isResearchBundleShape(research)) return undefined
  const limits: IntelligenceLimits = {
    maxSources: research.maxSources,
    maxSubQuestions: research.maxSubQuestions,
    maxFollowUpRounds: research.maxFollowUpRounds,
  }
  return Object.values(limits).some((value) => value !== undefined) ? limits : undefined
}

/** Wires every agent and engine stage into the resumable pipeline. */
export async function runDocumentaryPipeline(
  options: DocumentaryOptions,
  sharedContext: Record<string, unknown> = {},
): Promise<DocumentaryResult> {
  const memory = new JsonMemoryStore(options.memoryDir)
  await assertNoPendingProductionRevision(memory)
  const approvals = options.approvals ?? new AutoApprover()
  const agent = new StructuredAgent(options.provider, readPromptFile)
  const search = options.search ?? new MockSearchProvider()
  const project = options.project ?? basename(options.memoryDir)
  // v0.7: one pinned reference date for the whole run, shared by intelligence
  // and the reasoning context so the two signatures can never diverge.
  const referenceDate = options.referenceDate ?? new Date().toISOString()
  // v0.7: the production side gets its own store, physically unable to write an
  // epistemic / reasoning / governance key. The context builder and the manifest
  // writer go through it as well, so "one-way" is enforced rather than merely
  // documented — and reads still fan in to the full memory.
  const productionMemory = new ScopedMemory(memory, new Set(PRODUCTION_WRITE_KEYS))
  const production = new ProductionEngine(productionMemory)

  // v0.7: the research caps shape the intelligence report, so they are part of
  // its freshness signature. Resolved once and shared with the context builder.
  const intelligenceLimits = intelligenceLimitsOf(options.research)

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

  // v0.7: keys each production stage actually wrote, for the scope-compliance
  // audit. Recorded as the pipeline runs, not asserted afterwards.
  const productionWrites: Array<{ artifact: string; keys: string[] }> = []
  let epistemicStageWrote = false

  const pipeline = new Pipeline(
    memory,
    approvals,
    async (stage, context) => {
      if (["narrative", "visual", "selfCheck"].includes(stage)) {
        const handoff = context.reasoningContext as ReasoningContext | undefined
        if (handoff && !verifyContextIntegrity(handoff).valid) {
          throw new Error(
            "Reasoning context signature is invalid; explicitly rebuild the handoff before generating production.",
          )
        }
      }
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
        case "epistemicPreparation": {
          // v0.7 (B1): the ONLY writer of the v0.6 intelligence envelope, and it
          // runs with the pipeline's epistemic-preparation scope. The production
          // half below physically cannot write `intelligence` at all, so a
          // production-only resume leaves the epistemic side byte-identical.
          const research = context.research as ResearchBundle | undefined
          const hypotheses = context.hypotheses as HypothesesWithVerifications | undefined
          const preparation = await prepareEpistemicState({
            research: research ?? null,
            hypotheses: hypotheses?.hypotheses ?? null,
            verifications: hypotheses?.verifications ?? null,
            referenceDate,
            ...(intelligenceLimits === undefined ? {} : { limits: intelligenceLimits }),
            memory,
          })
          // Idempotent: a FRESH envelope is reused, so nothing is written and
          // the file stays byte-identical. Only a genuine staleness (a changed
          // upstream, budget or limit) refreshes it — and that happens here, on
          // the epistemic side, where it belongs.
          const envelope = intelligenceEnvelopeToPersist(preparation)
          // Entering production over an existing research/reasoning state is
          // read-only on that state, even if its cached intelligence is stale.
          if (envelope !== null && epistemicStageWrote) {
            await new ScopedMemory(memory, new Set(EPISTEMIC_PREP_WRITE_KEYS)).save(
              "intelligence",
              envelope,
            )
          }
          return preparation
        }
        case "reasoningContext": {
          // v0.7: the one-way handoff. Built ONCE and persisted; a resumed run
          // reuses it instead of re-deriving production from a new state, so
          // the approved film is never silently rebuilt.
          const research = context.research as ResearchBundle | undefined
          const hypotheses = context.hypotheses as HypothesesWithVerifications | undefined
          const built = await buildReasoningContext({
            project,
            question: options.question,
            research: research ?? null,
            hypotheses: hypotheses?.hypotheses ?? null,
            // Persisted as a sibling array, not inlined per hypothesis.
            verifications: hypotheses?.verifications ?? null,
            referenceDate,
            ...(intelligenceLimits === undefined ? {} : { intelligenceLimits }),
            memory: productionMemory,
          })
          return built
        }
        case "narrative": {
          const research = context.research as ResearchBundle
          const claims = context.claims as ClaimsOutput
          const hypotheses = context.hypotheses as HypothesesWithVerifications
          const reasoningContext = context.reasoningContext as ReasoningContext | undefined
          const narrative = await narrativeAgent.run({
            question: options.question,
            title: options.title,
            research,
            claims,
            hypotheses: hypotheses ?? { hypotheses: [] },
            ...(reasoningContext ? { reasoningContext } : {}),
          })
          return narrative
        }
        case "visual": {
          const narrative = context.narrative as Narrative
          const reasoningContext = context.reasoningContext as ReasoningContext | undefined
          const visual = await visualAgent.run({
            narrative,
            ...(reasoningContext ? { reasoningContext } : {}),
          })
          return visual
        }
        case "selfCheck": {
          const claims = context.claims as ClaimsOutput
          const narrative = context.narrative as Narrative
          const visual = context.visual as VisualOutput
          const factCheck = context.factCheck as {
            assessments?: Array<{ claimId: string; verdict: string }>
          }
          const research = context.research as ResearchBundle
          const reasoningContext = context.reasoningContext as ReasoningContext | undefined
          // Only completed writes are evidence. This audit cannot attest its
          // own future persistence or the later manifest write.
          return new SelfCheckEngine().run({
            claims: claims.claims,
            narrative,
            shots: visual.shots,
            // The guarded visual artifact, so its provenance is audited too.
            visual,
            assessments: factCheck?.assessments,
            research: research && research.claims ? research : undefined,
            ...(reasoningContext ? { reasoningContext, productionWrites } : {}),
          })
        }
        default:
          throw new Error(`Unknown stage: ${stage}`)
      }
    },
    sharedContext,
    (stage, key) => {
      if (["research", "claims", "hypotheses", "factCheck"].includes(stage)) {
        epistemicStageWrote = true
      }
      if (["reasoningContext", "narrative", "visual", "selfCheck"].includes(stage)) {
        productionWrites.push({ artifact: stage, keys: [key] })
      }
    },
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

  // v0.7 (B1): intelligence is NOT recomputed or saved here. The
  // `epistemicPreparation` stage above is the single owner of that artifact and
  // persisted it through the epistemic scope; this orchestrator only reads the
  // result. A bare `memory.save("intelligence", …)` on the production path is
  // exactly the bug that replaced the signed v0.6 envelope with an unsigned
  // report and made a stale intelligence view look authoritative.
  const intelligence = artifacts.epistemicPreparation?.report

  // v0.7: build and persist the production manifest. Detection of staleness
  // never triggers a regeneration (I14, I15) — it is reported, not acted on.
  const reasoningContext = artifacts.reasoningContext
  let productionManifest: ProductionManifest | undefined
  let staleness: ProductionStaleness | undefined
  if (reasoningContext) {
    const selfCheck = artifacts.selfCheck ?? null
    productionManifest = production.buildManifest({
      context: reasoningContext,
      narrative,
      visual,
      selfCheck,
    })
    await production.writeManifest(productionManifest)
    staleness = productionManifest.staleness
  }

  return {
    ...artifacts,
    traceability,
    ...(verifications.length > 0 ? { hypothesisVerifications: verifications } : {}),
    ...(intelligence ? { intelligence } : {}),
    ...(productionManifest ? { production: productionManifest } : {}),
    ...(staleness ? { staleness } : {}),
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
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
      const references = [
        ...(sentence.hypothesisIds ?? []).map((id) => `hypothesis: ${id}`),
        ...(sentence.uncertaintyIds ?? []).map((id) => `uncertainty: ${id}`),
        ...(sentence.contradictionIds ?? []).map((id) => `contradiction: ${id}`),
        ...(sentence.constraintTreatments ?? []).map(
          (t) => `constraint: ${t.constraintId} (${t.treatment})`,
        ),
      ]
      lines.push(
        `${tag} ${sentence.text}${trace}${references.length ? ` *(${references.join("; ")})*` : ""}`,
      )
    }
    lines.push("")
  }

  return lines.join("\n")
}
