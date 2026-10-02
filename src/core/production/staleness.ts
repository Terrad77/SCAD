import { artifactContentSignature, verifyContextIntegrity } from "./signature.js"
import type {
  ArtifactStaleness,
  ProductionArtifactStaleness,
  ProductionDependency,
  ProductionStaleness,
  ReasoningContext,
  StalenessReason,
} from "./types.js"
import type { ProductionProvenance, SelfCheckProductionReport } from "./types.js"

/**
 * v0.7 — Staleness detection (§18).
 *
 * A production artifact is CURRENT only if it was produced from exactly the
 * reasoning context and the upstream artifacts that exist NOW. Three
 * independent comparisons are made, in this order, because each catches drift
 * the others cannot:
 *
 *   1. INPUT SIGNATURE. The context signs every epistemic + reasoning input, so
 *      a later change to claims, hypotheses, intelligence or the reasoning
 *      result makes every derived artifact STALE. This is the coarse net.
 *   2. DEPENDENCY CONTENT SIGNATURES. A rebuilt narrative that differs in content
 *      to the one `visual` was cut against leaves the input signature untouched
 *      while making `visual` wrong. Each artifact therefore records the content
 *      signatures of the artifacts it was actually built from.
 *   3. CONTEXT INTEGRITY. A hand-edited or truncated context is CORRUPT: no
 *      artifact derived from it is current, regardless of what it claims.
 *
 * Deliberately: `autoRegenerate` is always `false`. v0.7 DETECTS staleness and
 * reports it; regenerating narrative/visual is always an explicit, human-driven
 * action, so a signature change can never silently rewrite an approved film.
 */

/** The only fields staleness reads; both provenance shapes carry them. */
export type StalenessMarker = ProductionProvenance | SelfCheckProductionReport

export interface StalenessInput {
  /** The current context's input signature (or null when no context exists). */
  currentInputSignature: string | null
  /**
   * v0.7 (H3) — the current context's content signature. A persisted artifact
   * whose `contextSignature` disagrees is STALE even if the coarse input
   * signature happens to match.
   */
  currentContextSignature?: string | null
  /** v0.7 (H3) — current content signature per upstream artifact. */
  dependencies?: Record<string, string | null | undefined>
  /** v0.7 (H3) — false when the persisted context no longer signs itself. */
  contextIntegrity?: { valid: boolean }
  /** Artifact name → the marker it recorded, or null when absent. */
  artifacts: Record<string, StalenessMarker | null | undefined>
  /** Artifact names that are expected to exist even if not provided. */
  expected?: string[]
}

function dependenciesOf(marker: StalenessMarker | null | undefined): ProductionDependency[] {
  const value = (marker as { dependencies?: unknown } | null | undefined)?.dependencies
  return Array.isArray(value) ? (value as ProductionDependency[]) : []
}

function result(
  artifact: string,
  status: ArtifactStaleness,
  marker: StalenessMarker | null | undefined,
  reason: StalenessReason | null,
  dependency: string | null,
): ProductionArtifactStaleness {
  return {
    artifact,
    status,
    inputSignature: marker?.inputSignature ?? null,
    reasoningCycleId: marker?.reasoningCycleId ?? null,
    reason,
    dependency,
  }
}

export function artifactStaleness(
  artifact: string,
  input: Pick<
    StalenessInput,
    "currentInputSignature" | "currentContextSignature" | "dependencies" | "contextIntegrity"
  >,
  marker: StalenessMarker | null | undefined,
): ProductionArtifactStaleness {
  if (marker === null || marker === undefined) {
    return result(artifact, "MISSING", marker, "DEPENDENCY_MISSING", null)
  }
  if (input.currentInputSignature === null) {
    return result(artifact, "UNKNOWN", marker, "NO_CURRENT_SIGNATURE", null)
  }

  // 3. integrity first: nothing derived from a corrupt context can be current.
  if (input.contextIntegrity !== undefined && !input.contextIntegrity.valid) {
    return result(artifact, "STALE", marker, "CONTEXT_CORRUPT", "reasoningContext")
  }

  // 1. coarse net.
  if (marker.inputSignature !== input.currentInputSignature) {
    return result(artifact, "STALE", marker, "INPUT_SIGNATURE_CHANGED", null)
  }
  if (
    input.currentContextSignature != null &&
    marker.contextSignature !== input.currentContextSignature
  ) {
    return result(artifact, "STALE", marker, "INPUT_SIGNATURE_CHANGED", "reasoningContext")
  }

  // 2. per-dependency content signatures.
  const recordedDependencies = dependenciesOf(marker)
  const required =
    artifact === "narrative"
      ? ["reasoningContext"]
      : artifact === "visual"
        ? ["reasoningContext", "narrative"]
        : artifact === "selfCheck"
          ? ["reasoningContext", "narrative", "visual"]
          : []
  for (const name of required) {
    if (
      input.dependencies &&
      name in input.dependencies &&
      !recordedDependencies.some((d) => d.artifact === name)
    ) {
      return result(artifact, "STALE", marker, "DEPENDENCY_MISSING", name)
    }
  }
  for (const dependency of recordedDependencies) {
    const current = input.dependencies?.[dependency.artifact]
    if (current === undefined) continue // not part of this comparison
    if (current === null) {
      return result(artifact, "STALE", marker, "DEPENDENCY_MISSING", dependency.artifact)
    }
    if (current !== dependency.contentSignature) {
      return result(artifact, "STALE", marker, "DEPENDENCY_CHANGED", dependency.artifact)
    }
  }

  return result(artifact, "CURRENT", marker, null, null)
}

export function detectProductionStaleness(input: StalenessInput): ProductionStaleness {
  const names = new Set<string>([...(input.expected ?? []), ...Object.keys(input.artifacts)])
  const artifacts = [...names]
    .sort()
    .map((artifact) => artifactStaleness(artifact, input, input.artifacts[artifact]))
  return {
    currentInputSignature: input.currentInputSignature,
    currentContextSignature: input.currentContextSignature ?? null,
    artifacts,
    stale: artifacts.some((a) => a.status === "STALE" || a.status === "MISSING"),
    autoRegenerate: false,
  }
}

/**
 * v0.7 (H2) — the LIVE staleness view.
 *
 * The manifest's own staleness block is a HISTORICAL record: it was true at
 * write time. Inspection compares the persisted artifacts against the state
 * that exists NOW, recomputed read-only. It never persists, and never
 * regenerates.
 */
export async function detectLiveProductionStaleness(options: {
  store: {
    get<T>(key: string): Promise<T | null>
  }
  context: ReasoningContext | null
  expected?: readonly string[]
}): Promise<ProductionStaleness> {
  const { context, store, expected } = options
  const integrity = verifyContextIntegrity(context)
  const artifacts: Record<string, StalenessMarker | null> = {}
  for (const name of expected ?? ["narrative", "visual", "selfCheck"]) {
    const stored = await store.get<{ production?: StalenessMarker }>(name)
    artifacts[name] = stored?.production ?? null
  }
  // The live dependency signatures: the context's own content signature, and
  // each production artifact's content signature as it stands on disk now.
  const dependencies: Record<string, string | null> = { reasoningContext: null }
  if (context !== null) {
    dependencies.reasoningContext = artifactContentSignature(context)
  }
  for (const name of ["narrative", "visual"] as const) {
    const artifact = await store.get<unknown>(name)
    dependencies[name] = artifact === null ? null : artifactContentSignature(artifact)
  }
  return detectProductionStaleness({
    currentInputSignature: context?.inputSignature ?? null,
    currentContextSignature: context?.contextSignature ?? null,
    dependencies,
    contextIntegrity: integrity.valid ? { valid: true } : { valid: false },
    artifacts,
    ...(expected === undefined ? {} : { expected: [...expected] }),
  })
}

export function stalenessOf(staleness: ProductionStaleness, artifact: string): ArtifactStaleness {
  return staleness.artifacts.find((a) => a.artifact === artifact)?.status ?? "UNKNOWN"
}
