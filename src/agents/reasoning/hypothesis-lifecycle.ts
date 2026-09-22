import { z } from "zod"
import type { Hypothesis, HypothesisVerification, ResearchBundle } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import type { HypothesisVersion } from "../../core/reasoning/types.js"
import { buildVersion, latestVersion } from "../../core/reasoning/hypothesis-version.js"

/**
 * v0.5 — Hypothesis lifecycle: generation, revision and rejection.
 *
 * Every mutation produces a NEW immutable version. LLM attempts degrade to
 * deterministic fallbacks so the whole lifecycle remains offline-capable and
 * fully reproducible (mirroring the Evidence & Research Engine convention).
 */

export const ALTERNATIVE_REASON_PREFIX = "alternative explanation of "

export function alternativeReasonFor(targetHypothesisId: string): string {
  return `${ALTERNATIVE_REASON_PREFIX}${targetHypothesisId}`
}

const AlternativeExplanationsSchema = z.object({
  hypothesis: z.object({
    statement: z.string().min(1),
    basis: z.array(z.string().min(1)).default([]),
    supportingClaims: z.array(z.string().min(1)).default([]),
    contradictingClaims: z.array(z.string().min(1)).default([]),
    assumptions: z.array(z.string().min(1)).default([]),
    missingInfo: z.array(z.string().min(1)).default([]),
    verificationTasks: z.array(z.string().min(1)).default([]),
  }),
})

const RevisionSchema = z.object({
  statement: z.string().min(1),
})

export interface HypothesisLifecycleContext {
  research: ResearchBundle
  versions: HypothesisVersion[]
  stepId: string
  /** Optional LLM stage; deterministic fallbacks are used when absent/failing. */
  agent?: StructuredAgent
}

function strongestClaim(research: ResearchBundle) {
  const claims = [...research.claims].sort(
    (a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id),
  )
  return claims[0] ?? null
}

function opposingClaim(
  research: ResearchBundle,
  hypothesis: Hypothesis,
): { id: string; statement: string } | null {
  const byId = new Map(research.claims.map((c) => [c.id, c]))
  const contradicting = hypothesis.contradictingClaims
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
  if (contradicting[0]) return { id: contradicting[0].id, statement: contradicting[0].statement }
  const contradictingEvidence = (hypothesis.contradictingEvidence ?? [])
    .map((id) => research.evidence.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
  if (contradictingEvidence[0]) {
    return { id: contradictingEvidence[0].id, statement: contradictingEvidence[0].statement }
  }
  return null
}

/**
 * Generates an alternative hypothesis. With no target (first hypothesis) it is
 * derived deterministically from the strongest claim; with a target it either
 * uses the LLM stage or flips support/contradiction axes into the opposite
 * stance.
 */
export async function generateAlternative(
  input: HypothesisLifecycleContext & { targetHypothesisId: string | null },
): Promise<HypothesisVersion> {
  const { research, versions, stepId, agent, targetHypothesisId } = input
  const hypothesisId = nextHypothesisId(versions)

  if (!targetHypothesisId) {
    const claim = strongestClaim(research)
    if (!claim) {
      throw new Error("generateAlternative: no claim to derive a first hypothesis from")
    }
    const first: Hypothesis = {
      id: hypothesisId,
      statement: claim.statement,
      basis: [`Derived from claim ${claim.id}`],
      supportingClaims: [claim.id],
      contradictingClaims: [],
      supportingEvidence: claim.evidenceIds ?? [],
      contradictingEvidence: [],
      researchGaps: [],
      confidence: Math.round(claim.confidence * 100) / 100,
      status: "UNTESTED",
      assumptions: [],
      missingInfo: [],
      verificationTasks: [],
    }
    return buildVersion(first, 1, stepId, "generated as the first hypothesis")
  }

  const base = latestVersion(versions, targetHypothesisId)
  if (!base) {
    throw new Error(`generateAlternative: unknown hypothesis ${targetHypothesisId}`)
  }

  const llmAttempt = agent ? await tryAlternativeExplanations(agent, base, research) : null
  const opposing = opposingClaim(research, base)
  const statement =
    llmAttempt?.statement ??
    (opposing
      ? `Rather than "${base.statement}", ${opposing.statement}`
      : `An alternative explanation of "${base.statement}" not yet covered by the collected evidence.`)

  const alternativeHypothesis: Hypothesis = {
    id: hypothesisId,
    statement,
    basis: llmAttempt?.basis.length
      ? llmAttempt.basis
      : [...base.basis, alternativeReasonFor(base.id)],
    supportingClaims: llmAttempt?.supportingClaims.length
      ? llmAttempt.supportingClaims
      : opposing
        ? [opposing.id]
        : base.contradictingClaims,
    contradictingClaims: llmAttempt?.contradictingClaims.length
      ? llmAttempt.contradictingClaims
      : base.supportingClaims,
    supportingEvidence: base.contradictingEvidence ?? [],
    contradictingEvidence: base.supportingEvidence ?? [],
    researchGaps: base.researchGaps,
    confidence: 0.5,
    status: "UNTESTED",
    assumptions: llmAttempt?.assumptions.length ? llmAttempt.assumptions : [],
    missingInfo: llmAttempt?.missingInfo.length ? llmAttempt.missingInfo : base.missingInfo,
    verificationTasks: llmAttempt?.verificationTasks.length
      ? llmAttempt.verificationTasks
      : base.verificationTasks,
  }

  return buildVersion(alternativeHypothesis, 1, stepId, alternativeReasonFor(base.id), {
    parentVersionId: base.versionId,
    hypothesisId,
  })
}

/** Builds a revised version: fresh UNTESTED status, latest evidence reflected. */
export async function buildRevision(
  input: HypothesisLifecycleContext & {
    targetHypothesisId: string
    verification: HypothesisVerification
  },
): Promise<HypothesisVersion> {
  const { versions, stepId, agent, targetHypothesisId, verification } = input
  const base = latestVersion(versions, targetHypothesisId)
  if (!base) throw new Error(`buildRevision: unknown hypothesis ${targetHypothesisId}`)

  const llmAttempt = agent ? await tryRevision(agent, base, verification) : null
  const statement = llmAttempt ?? `${base.statement} — revised: ${verification.rationale}`

  const revised: Hypothesis = {
    ...base,
    statement,
    status: "UNTESTED",
    confidence: base.confidence,
    supportingEvidence: verification.supportingEvidence,
    contradictingEvidence: verification.contradictingEvidence,
    researchGaps: verification.researchGaps,
  }

  return buildVersion(
    revised,
    base.version + 1,
    stepId,
    `revised from v${base.version} (${verification.status})`,
    { parentVersionId: base.versionId, hypothesisId: base.hypothesisId },
  )
}

/** Builds a rejected version. The hypothesis leaves the active set but stays in the log. */
export function buildRejection(
  input: HypothesisLifecycleContext & {
    targetHypothesisId: string
    verification: HypothesisVerification
  },
): HypothesisVersion {
  const { versions, stepId, targetHypothesisId, verification } = input
  const base = latestVersion(versions, targetHypothesisId)
  if (!base) throw new Error(`buildRejection: unknown hypothesis ${targetHypothesisId}`)
  const rejected: Hypothesis = { ...base, status: "REJECTED" }
  return buildVersion(rejected, base.version + 1, stepId, `rejected: ${verification.rationale}`, {
    parentVersionId: base.versionId,
    hypothesisId: base.hypothesisId,
  })
}

function nextHypothesisId(versions: HypothesisVersion[]): string {
  const existing = new Set(versions.map((v) => v.hypothesisId))
  let index = versions.length + 1
  let candidate = `HYP_${String(index).padStart(3, "0")}`
  while (existing.has(candidate)) {
    index += 1
    candidate = `HYP_${String(index).padStart(3, "0")}`
  }
  return candidate
}

async function tryAlternativeExplanations(
  agent: StructuredAgent,
  base: HypothesisVersion,
  research: ResearchBundle,
): Promise<z.infer<typeof AlternativeExplanationsSchema>["hypothesis"] | null> {
  try {
    const output = await agent.run(
      "alternative-explanations",
      AlternativeExplanationsSchema,
      {
        hypothesis: {
          id: base.id,
          statement: base.statement,
          supportingClaims: base.supportingClaims,
          contradictingClaims: base.contradictingClaims,
        },
        research: {
          claims: research.claims.map((c) => ({ id: c.id, statement: c.statement })),
        },
      },
      { maxRetries: 0 },
    )
    return output.hypothesis
  } catch {
    return null
  }
}

async function tryRevision(
  agent: StructuredAgent,
  base: HypothesisVersion,
  verification: HypothesisVerification,
): Promise<string | null> {
  try {
    const output = await agent.run(
      "revision",
      RevisionSchema,
      {
        hypothesis: { id: base.id, statement: base.statement },
        verification: { status: verification.status, rationale: verification.rationale },
      },
      { maxRetries: 0 },
    )
    return output.statement
  } catch {
    return null
  }
}
