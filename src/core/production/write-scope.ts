/**
 * v0.7 — physical write-scope for the production side.
 *
 * The one-way boundary is not a convention here: the pipeline persists each
 * stage through a `ScopedMemory` restricted to that stage's declared scope, so
 * a production stage physically cannot overwrite an epistemic, reasoning or
 * governance artifact (I1, I16, I18).
 *
 * Groups (mutually disjoint):
 *   EPISTEMIC   research, claims, hypotheses, factCheck, intelligence, versions
 *   REASONING   reasoning cursor, cycle ledger, decision journal
 *   PRODUCTION  reasoningContext, narrative, visual, selfCheck, production
 *   GOVERNANCE  approved
 *
 * `intelligence` sits in EPISTEMIC and is therefore unreachable from the
 * production scope: production can *detect* that intelligence is stale, or
 * recompute a projection in memory, but persisting it is the job of the
 * explicit `epistemicPreparation` phase, which has its own narrow scope.
 *
 * `EPISTEMIC_WRITE_KEYS` in `core/memory/scoped-memory.ts` is the v0.5
 * action-scope vocabulary and is intentionally left untouched: the v0.7 groups
 * describe pipeline stages, not reasoning actions.
 */

export const EPISTEMIC_PIPELINE_KEYS = [
  "research",
  "claims",
  "hypotheses",
  "factCheck",
  "intelligence",
  "hypothesis-versions",
] as const

export const REASONING_ARTIFACT_KEYS = ["reasoning", "reasoning-history", "decisions"] as const

export const PRODUCTION_WRITE_KEYS = [
  "reasoningContext",
  "narrative",
  "visual",
  "selfCheck",
  "production",
] as const

export const GOVERNANCE_WRITE_KEYS = ["approved"] as const

/**
 * v0.7 — the epistemic-preparation scope. Deliberately NARROWER than
 * `EPISTEMIC_PIPELINE_KEYS`: the preparation phase owns exactly one write, the
 * v0.6 `IntelligenceEnvelope`. It cannot touch research, claims, hypotheses or
 * versions, so "the phase that refreshes the derived intelligence view" cannot
 * quietly become a second writer of the epistemic record.
 */
export const EPISTEMIC_PREP_WRITE_KEYS = ["intelligence", "epistemicPreparation"] as const

/** Pipeline stage → the only memory keys that stage may write. */
export const STAGE_WRITE_SCOPE: Readonly<Record<string, readonly string[]>> = {
  research: EPISTEMIC_PIPELINE_KEYS,
  claims: EPISTEMIC_PIPELINE_KEYS,
  hypotheses: EPISTEMIC_PIPELINE_KEYS,
  factCheck: EPISTEMIC_PIPELINE_KEYS,
  epistemicPreparation: EPISTEMIC_PREP_WRITE_KEYS,
  reasoningContext: PRODUCTION_WRITE_KEYS,
  narrative: PRODUCTION_WRITE_KEYS,
  visual: PRODUCTION_WRITE_KEYS,
  selfCheck: PRODUCTION_WRITE_KEYS,
}

export function writeScopeForStage(stage: string): ReadonlySet<string> {
  return new Set(STAGE_WRITE_SCOPE[stage] ?? [])
}

/** Every key production is forbidden from touching, for guard tests. */
export function protectedKeys(): string[] {
  return [...EPISTEMIC_PIPELINE_KEYS, ...REASONING_ARTIFACT_KEYS, ...GOVERNANCE_WRITE_KEYS]
}
