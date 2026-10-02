import type { MemoryStore } from "../../core/memory/json-memory.js"
import type {
  Hypothesis,
  HypothesisVerification,
  ResearchBundle,
  ResearchIntelligenceReport,
} from "../../core/schemas.js"
import type {
  HypothesisVersion,
  IntelligenceEnvelope,
  ReasoningBudget,
} from "../../core/reasoning/types.js"
import type { IntelligenceLimits } from "../../core/reasoning/types.js"
import { loadReasoningCursor } from "../reasoning/reasoning-repository.js"
import { isResearchBundle } from "./reasoning-context.js"
import { ResearchIntelligenceEngine } from "../research/research-intelligence.js"
import {
  buildIntelligenceEnvelope,
  resolveIntelligence,
  resolveReferenceDate,
  type IntelligenceInputs,
  type IntelligenceResolution,
} from "../reasoning/intelligence-envelope.js"

/**
 * v0.7 — the EPISTEMIC PREPARATION phase.
 *
 * `intelligence` is a derived epistemic artifact, and a PROTECTED key: the
 * production scope physically refuses to write it. That is deliberate, and it
 * is why this phase exists as an explicit, separately-scoped, upstream step:
 *
 *   • it prepares a v0.6 `IntelligenceEnvelope` for the upstream pipeline;
 *   • it is idempotent — a fresh envelope is reused byte-identically, so a
 *     production-only resume performs ZERO writes to the epistemic side;
 *   • it resolves the report through the same `resolveIntelligence` freshness
 *     decision the production context builder uses, so the two sides can never
 *     disagree about whether intelligence is stale.
 *
 * The run-time `referenceDate` is resolved in a fixed order and NEVER falls
 * back to a wall clock when a persisted value exists:
 *   1. the persisted reasoning cursor,
 *   2. the persisted envelope's recorded reference date,
 *   3. the persisted report's own `generatedAt`,
 *   4. the caller's run-pinned value,
 *   5. only then, `new Date()`.
 *
 * The reasoning budget likewise comes from persisted state when it exists, so
 * the signature validated here is the one the reasoning cycle actually used.
 */

export interface EpistemicPreparationInput {
  research: ResearchBundle | null
  hypotheses: Array<Hypothesis & { verifications?: HypothesisVerification[] }> | null
  verifications?: HypothesisVerification[] | null
  /** Run-pinned reference date; falls back to persisted state, then a clock. */
  referenceDate?: string
  /** Research-engine caps in force for this run (they shape the report). */
  limits?: IntelligenceLimits
  memory: MemoryStore
}

export interface EpistemicPreparationResult {
  report: ResearchIntelligenceReport | null
  inputSignature: string | null
  /** True when the persisted envelope was reused, so nothing was written. */
  fresh: boolean
  /** The reference date and budget the signature was validated against. */
  inputs: IntelligenceInputs | null
  resolution: IntelligenceResolution
  referenceDate: string
  budget: ReasoningBudget | null
}

const DEFAULT_BUDGET: ReasoningBudget = {
  maxSteps: 100,
  maxSources: 40,
  maxQueries: 40,
  maxFollowUpRounds: 5,
}

export async function prepareEpistemicState(
  input: EpistemicPreparationInput,
): Promise<EpistemicPreparationResult> {
  const persistedRaw = await input.memory.readRaw("intelligence")
  const persisted = parseJson(persistedRaw)
  const versions = (await input.memory.get<HypothesisVersion[]>("hypothesis-versions")) ?? []
  const loaded = await loadReasoningCursor(input.memory)
  const persistedCursor = loaded?.cursor ?? null

  // v0.7 (H1): the SAME resolver the production context builder uses, so the two
  // signatures can never disagree about which reference date was in force.
  const referenceDate = resolveReferenceDate({
    ...(input.referenceDate === undefined ? {} : { runReferenceDate: input.referenceDate }),
    cursor: persistedCursor,
    persisted,
  })

  const budget: ReasoningBudget = persistedCursor?.budget ?? DEFAULT_BUDGET
  // A legacy (v0.3) `ResearchOutput` has sources + summary but no evidence
  // chain, so the intelligence engine has nothing to score. Degrade to "no
  // report" rather than feeding it undefined arrays.
  const research = isResearchBundle(input.research) ? input.research : null

  if (research === null) {
    return {
      report: null,
      inputSignature: null,
      fresh: false,
      inputs: null,
      resolution: {
        report: null,
        signature: null,
        fresh: false,
        source: "absent",
        staleReason: null,
      },
      referenceDate,
      budget: persistedCursor?.budget ?? null,
    }
  }
  const stored = input.hypotheses ?? []
  const verifications = [
    ...(input.verifications ?? []),
    ...stored.flatMap((entry) => entry.verifications ?? []),
  ]
  const limits = input.limits
  const computationLimits =
    limits ??
    (persistedCursor
      ? {
          maxSources: budget.maxSources,
          maxSubQuestions: budget.maxQueries,
          maxFollowUpRounds: budget.maxFollowUpRounds,
          maxIterations: budget.maxSteps,
        }
      : undefined)
  const inputs: IntelligenceInputs = {
    research,
    versions,
    referenceDate,
    budget,
    ...(limits === undefined ? {} : { limits }),
  }

  const resolution = resolveIntelligence({
    ...inputs,
    persisted,
    recompute: ({ referenceDate: date }) =>
      new ResearchIntelligenceEngine({
        research,
        verifications,
        referenceDate: date,
        ...(computationLimits === undefined ? {} : { limits: computationLimits }),
      }).run(),
  })

  return {
    report: resolution.report,
    inputSignature: resolution.signature,
    fresh: resolution.fresh,
    inputs,
    resolution,
    referenceDate,
    budget,
  }
}

/**
 * The envelope to persist, or null when no write is warranted.
 *
 * A FRESH envelope is never rewritten: that is what keeps a production-only
 * resume byte-identical on the epistemic side. The returned value is written
 * through the epistemic-preparation scope, so this is the only code path in the
 * pipeline that can touch `intelligence`.
 */
export function intelligenceEnvelopeToPersist(
  preparation: EpistemicPreparationResult,
): IntelligenceEnvelope | null {
  if (preparation.fresh || preparation.report === null || preparation.inputs === null) return null
  return buildIntelligenceEnvelope(preparation.inputs, preparation.report)
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
