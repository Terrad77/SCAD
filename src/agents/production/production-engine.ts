import type { MemoryStore } from "../../core/memory/json-memory.js"
import type {
  Hypothesis,
  HypothesisVerification,
  Narrative,
  ResearchBundle,
  SelfCheckOutput,
  VisualOutput,
} from "../../core/schemas.js"
import { auditProduction } from "../../core/production/self-check-rules.js"
import { detectProductionStaleness, type StalenessMarker } from "../../core/production/staleness.js"
import {
  artifactContentSignature,
  verifyContextIntegrity,
} from "../../core/production/signature.js"
import { buildReasoningContext } from "./reasoning-context.js"
import type { EpistemicPreparationResult } from "./epistemic-prep.js"
import {
  PRODUCTION_MANIFEST_VERSION,
  type ProductionArtifactRef,
  type ProductionManifest,
  type ProductionProvenance,
  type ProductionStaleness,
  type ReasoningContext,
} from "../../core/production/types.js"
import { PRODUCTION_WRITE_KEYS, writeScopeForStage } from "../../core/production/write-scope.js"

/**
 * v0.7 — the production side's own engine: it owns the reasoning→production
 * manifest, the staleness view, and the independent production audit.
 *
 * It reads the cognitive side and writes ONLY inside `PRODUCTION_WRITE_KEYS`
 * (`reasoningContext`, `narrative`, `visual`, `selfCheck`, `production`). The
 * pipeline additionally routes every production write through a `ScopedMemory`
 * restricted to that set, so the boundary holds even if a stage misbehaves.
 */

export const PRODUCTION_ARTIFACTS = ["narrative", "visual", "selfCheck"] as const

export interface ProductionInputs {
  context: ReasoningContext
  narrative: Narrative
  visual: VisualOutput
  selfCheck?: SelfCheckOutput | null
}

export class ProductionEngine {
  constructor(private readonly memory: MemoryStore) {}

  /**
   * The independent production audit, run by SelfCheck. Returns the report only:
   * a finding here is a DIAGNOSTIC routed to a human or to a future reasoning
   * cycle, never a mutation of the epistemic state (I4, I5, I9).
   */
  audit(input: ProductionInputs, writes: Array<{ artifact: string; keys: string[] }> = []) {
    return auditProduction({
      context: input.context,
      narrative: input.narrative,
      visual: input.visual,
      narrativeProvenance: input.narrative.production ?? null,
      visualProvenance: input.visual.production ?? null,
      writes,
    })
  }

  buildManifest(input: ProductionInputs): ProductionManifest {
    const { context } = input
    const report = input.selfCheck?.production ?? null
    return {
      version: PRODUCTION_MANIFEST_VERSION,
      project: context.project,
      question: context.question,
      context: {
        version: context.version,
        inputSignature: context.inputSignature,
        contextSignature: context.contextSignature,
        reasoningCycleId: context.reasoningCycleId,
        referenceDate: context.referenceDate,
      },
      artifacts: artifactRefs(input),
      constraints: context.constraints,
      selfCheck: report === null ? null : { verdict: report.verdict, checks: report.checks },
      staleness: detectProductionStaleness({
        currentInputSignature: context.inputSignature,
        currentContextSignature: context.contextSignature,
        dependencies: liveDependencySignatures(context, input),
        contextIntegrity: { valid: verifyContextIntegrity(context).valid },
        artifacts: {
          narrative: input.narrative.production ?? null,
          visual: input.visual.production ?? null,
          selfCheck: report,
        },
        expected: [...PRODUCTION_ARTIFACTS],
      }),
    }
  }

  /**
   * v0.7 (H2) — the LIVE staleness view.
   *
   * The manifest's staleness block is a HISTORICAL record: it was true when the
   * film was built. It cannot answer "is what I have now still current?", and
   * using it for that is exactly how an upstream edit after the run went
   * unnoticed. So the current signatures are RECOMPUTED here, read-only, from
   * the epistemic stores as they stand on disk, and the persisted artifacts are
   * compared against those.
   *
   * This is the permitted kind of recomputation: in memory, deterministic, and
   * writing nothing. `autoRegenerate` stays `false` — staleness is reported,
   * never acted on.
   */
  async staleness(
    context: ReasoningContext | null,
    input?: ProductionInputs,
  ): Promise<ProductionStaleness> {
    const artifacts: Record<string, StalenessMarker | null> = {}
    if (input) {
      artifacts.narrative = input.narrative.production ?? null
      artifacts.visual = input.visual.production ?? null
      artifacts.selfCheck = input.selfCheck?.production ?? null
    } else {
      for (const name of PRODUCTION_ARTIFACTS) {
        const stored = await this.memory.get<{ production?: StalenessMarker }>(name)
        artifacts[name] = stored?.production ?? null
      }
    }

    // When the caller hands us the production inputs, that context IS the
    // current one: the artifacts in hand were built from it, mid-run. Only the
    // inspection path (`input === undefined`) has to go and find out what the
    // world looks like now.
    const inspecting = input === undefined
    const live = inspecting ? await this.recomputeContext(context) : context
    const dependencies: Record<string, string | null> = { reasoningContext: null }
    if (live !== null) {
      dependencies.reasoningContext = artifactContentSignature(live)
    }
    for (const name of ["narrative", "visual"] as const) {
      const artifact = input === undefined ? await this.memory.get<unknown>(name) : input[name]
      dependencies[name] = artifact == null ? null : artifactContentSignature(artifact)
    }
    return detectProductionStaleness({
      currentInputSignature: live?.inputSignature ?? null,
      currentContextSignature: live?.contextSignature ?? null,
      dependencies,
      // v0.7 (H3): a context read back from disk must still sign its own body.
      // This is a check on PERSISTED state, so it belongs to the read path —
      // mid-run the context was just built here and is intact by construction.
      ...(inspecting && context !== null
        ? { contextIntegrity: { valid: verifyContextIntegrity(context).valid } }
        : {}),
      artifacts,
      expected: [...PRODUCTION_ARTIFACTS],
    })
  }

  /**
   * Rebuilds the reasoning context in memory from the CURRENT epistemic stores.
   *
   * Returns the persisted context unchanged when there is nothing to rebuild
   * from, and `null` when there is no context at all. The intelligence limits
   * are read back from the persisted epistemic-preparation record rather than
   * guessed: they were part of the intelligence signature, so inventing a
   * different set here would make every artifact look stale for a reason that
   * has nothing to do with the epistemic state.
   */
  private async recomputeContext(
    persisted: ReasoningContext | null,
  ): Promise<ReasoningContext | null> {
    if (persisted === null) return null
    const research = await this.memory.get<ResearchBundle>("research")
    const hypotheses = await this.memory.get<{
      hypotheses?: Hypothesis[]
      verifications?: HypothesisVerification[]
    }>("hypotheses")
    const preparation = await this.memory.get<EpistemicPreparationResult>("epistemicPreparation")
    const limits = preparation?.inputs?.limits
    const rebuilt = await buildReasoningContext({
      project: persisted.project,
      question: persisted.question,
      research: research ?? null,
      hypotheses: hypotheses?.hypotheses ?? null,
      verifications: hypotheses?.verifications ?? null,
      referenceDate: persisted.referenceDate,
      ...(limits === undefined ? {} : { intelligenceLimits: limits }),
      memory: this.memory,
    })
    return rebuilt
  }

  async writeManifest(manifest: ProductionManifest): Promise<void> {
    await this.memory.save("production", manifest)
  }

  async readManifest(): Promise<ProductionManifest | null> {
    return this.memory.get<ProductionManifest>("production")
  }

  /** Persists the context through a store restricted to the production scope. */
  async writeContext(context: ReasoningContext): Promise<void> {
    await this.memory.save("reasoningContext", context)
  }

  async readContext(): Promise<ReasoningContext | null> {
    return this.memory.get<ReasoningContext>("reasoningContext")
  }
}

export function artifactRefs(input: ProductionInputs): ProductionArtifactRef[] {
  const { context } = input
  const ref = (
    artifact: string,
    provenance: ProductionProvenance | null | undefined,
  ): ProductionArtifactRef => ({
    artifact,
    inputSignature: provenance?.inputSignature ?? null,
    contextSignature: provenance?.contextSignature ?? null,
    reasoningCycleId: provenance?.reasoningCycleId ?? context.reasoningCycleId,
    dependencies: provenance?.dependencies ?? [],
  })
  return [
    ref("narrative", input.narrative.production),
    ref("visual", input.visual.production),
    {
      artifact: "selfCheck",
      inputSignature: input.selfCheck?.production?.inputSignature ?? null,
      contextSignature: input.selfCheck?.production?.contextSignature ?? null,
      reasoningCycleId: input.selfCheck?.production?.reasoningCycleId ?? context.reasoningCycleId,
      dependencies: input.selfCheck?.production?.dependencies ?? [],
    },
  ]
}

/** v0.7 (H3) — current content signatures of every artifact a production
 * artifact can depend on, derived from the artifacts in hand. */
function liveDependencySignatures(
  context: ReasoningContext,
  input: ProductionInputs,
): Record<string, string | null> {
  return {
    reasoningContext: artifactContentSignature(context),
    narrative: artifactContentSignature(input.narrative),
    visual: artifactContentSignature(input.visual),
  }
}

/** Asserts a stage may only write production keys. Used by the pipeline guard. */
export function assertProductionWrite(key: string, stage: string): void {
  if (PRODUCTION_WRITE_KEYS.includes(key as (typeof PRODUCTION_WRITE_KEYS)[number])) return
  throw new Error(
    `production stage "${stage}" may not write "${key}"; allowed: ${writeScopeForStage(stage).size ? [...writeScopeForStage(stage)].join(", ") : "none"}`,
  )
}
