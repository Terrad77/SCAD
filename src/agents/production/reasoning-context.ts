import type { MemoryStore } from "../../core/memory/json-memory.js"
import type {
  Claim,
  Contradiction,
  Hypothesis,
  HypothesisVerification,
  ResearchBundle,
  ResearchGap,
  ResearchIntelligenceReport,
  Uncertainty,
} from "../../core/schemas.js"
import type { HypothesisVersion, ReasoningCursor } from "../../core/reasoning/types.js"
import type { IntelligenceLimits, ReasoningBudget } from "../../core/reasoning/types.js"
import {
  computeEpistemicSignature,
  computeStateSignature,
} from "../../core/reasoning/state-signature.js"
import { loadReasoningCursor, readReasoningCycles } from "../reasoning/reasoning-repository.js"
import { resolveIntelligence, resolveReferenceDate } from "../reasoning/intelligence-envelope.js"
import { ResearchIntelligenceEngine } from "../research/research-intelligence.js"
import {
  claimIsUsableForFact,
  deriveProductionConstraints,
} from "../../core/production/constraints.js"
import {
  computeReasoningContextSignature,
  reasoningContextInputSignature,
} from "../../core/production/signature.js"
import {
  REASONING_CONTEXT_VERSION,
  type ContextClaimTraceEdge,
  type ContextClaimView,
  type ContextHypothesisView,
  type ContextUncertaintyView,
  type EpistemicSummary,
  type ReasoningContext,
  type ReasoningContextTraceRefs,
  type ReasoningDecision,
} from "../../core/production/types.js"

/**
 * v0.7 — the ReasoningContext builder: the ONLY place the cognitive side is
 * projected into the production side.
 *
 * One-way by construction: this module READS the epistemic and reasoning stores
 * and WRITES nothing. In particular, if `intelligence` has not been persisted
 * yet (the context stage can run before the intelligence envelope exists) the
 * report is recomputed **in memory** so production sees the same deterministic
 * view, without persisting it — production must not become a second writer of an
 * epistemic artifact.
 *
 * The whole function is deterministic: the same stores + the same pinned
 * reference date always produce a byte-identical context.
 */

export interface BuildReasoningContextInput {
  project: string
  question: string
  research: ResearchBundle | null
  /**
   * Active hypothesis pointers. `verifications` is the sibling array as it is
   * actually persisted (`HypothesesWithVerifications`), *and* per-entry
   * verifications are still honoured for callers that inline them.
   */
  hypotheses: Array<Hypothesis & { verifications?: HypothesisVerification[] }> | null
  /** v0.4 verifications, as persisted alongside the hypotheses. */
  verifications?: HypothesisVerification[] | null
  /** Pinned once per run and shared with the intelligence computation. */
  referenceDate: string
  /**
   * v0.7 (H1/H2): the research caps in force for this run. They shape the
   * intelligence report, so they are part of its freshness signature.
   */
  intelligenceLimits?: IntelligenceLimits
  memory?: MemoryStore
}

/** How the intelligence projection was obtained. Surfaced in the trace refs. */
export type IntelligenceFreshness = "fresh" | "recomputed" | "absent"

const DEFAULT_REASONING_BUDGET: ReasoningBudget = {
  maxSteps: 100,
  maxSources: 40,
  maxQueries: 40,
  maxFollowUpRounds: 5,
}

interface EpistemicSnapshot {
  research: ResearchBundle | null
  claims: Claim[]
  hypotheses: Hypothesis[]
  verifications: HypothesisVerification[]
  versions: HypothesisVersion[]
  intelligence: ResearchIntelligenceReport | null
  intelligenceInputSignature: string | null
  intelligenceFreshness: IntelligenceFreshness
  intelligenceBudget: ReasoningBudget | null
  cursor: ReasoningCursor | null
  /** v0.7 (H1): the reference date persisted state dictates, shared by every
   * signature in the context. */
  referenceDate: string
}

async function loadSnapshot(input: BuildReasoningContextInput): Promise<EpistemicSnapshot> {
  const research = input.research
  const claims = research?.claims ?? []
  const stored = input.hypotheses ?? []
  const hypotheses = stored.map((entry) => {
    const { verifications: _verifications, ...hypothesis } = entry
    return hypothesis
  })
  const verifications = [
    ...(input.verifications ?? []),
    ...stored.flatMap((entry) => entry.verifications ?? []),
  ]
  const versions = (await input.memory?.get<HypothesisVersion[]>("hypothesis-versions")) ?? []

  const loaded = input.memory ? await loadReasoningCursor(input.memory) : null
  const cursor = loaded?.cursor ?? null

  // v0.7 (H1): the persisted intelligence artifact is TRUSTED only when its
  // signature re-verifies against the inputs that were actually in force. The
  // validation uses the PERSISTED reference date and reasoning budget, never a
  // run-time clock, and a stale report is recomputed **in memory only** —
  // production reads intelligence, it never rewrites it.
  const envelope = (await input.memory?.get<unknown>("intelligence")) ?? null
  let intelligence: ResearchIntelligenceReport | null = null
  let intelligenceInputSignature: string | null = null
  let intelligenceFreshness: IntelligenceFreshness = "absent"

  // v0.7 (H1): persisted state decides the reference date — see
  // `resolveReferenceDate`. A resumed run re-enters with a new wall clock, and
  // using it here would mark every production artifact stale for a change that
  // never happened epistemically.
  const referenceDate = resolveReferenceDate({
    ...(input.referenceDate === undefined ? {} : { runReferenceDate: input.referenceDate }),
    cursor,
    persisted: envelope,
  })

  if (isResearchBundle(research)) {
    const budget = cursor?.budget ?? DEFAULT_REASONING_BUDGET
    const computationLimits =
      input.intelligenceLimits ??
      (cursor
        ? {
            maxSources: budget.maxSources,
            maxSubQuestions: budget.maxQueries,
            maxFollowUpRounds: budget.maxFollowUpRounds,
            maxIterations: budget.maxSteps,
          }
        : undefined)
    const resolution = resolveIntelligence({
      research,
      versions,
      referenceDate,
      budget,
      ...(input.intelligenceLimits === undefined ? {} : { limits: input.intelligenceLimits }),
      persisted: envelope,
      recompute: ({ referenceDate: date }) =>
        new ResearchIntelligenceEngine({
          research,
          verifications,
          referenceDate: date,
          ...(computationLimits === undefined ? {} : { limits: computationLimits }),
        }).run(),
    })
    intelligence = resolution.report
    intelligenceInputSignature = resolution.signature
    // "absent" means no report could be produced at all. A report that was
    // computed because the envelope was missing is "recomputed" — the
    // production side obtained a value that is not the persisted one.
    intelligenceFreshness = resolution.fresh
      ? "fresh"
      : resolution.report === null
        ? "absent"
        : "recomputed"
  } else if (envelope !== null) {
    // Legacy research artifact: no evidence chain, so intelligence is not
    // computable. Surface the persisted report as-is rather than inventing one.
    intelligence = isRawIntelligence(envelope) ? envelope : null
    intelligenceFreshness = intelligence === null ? "absent" : "recomputed"
  }

  return {
    research,
    claims,
    hypotheses,
    verifications,
    versions,
    intelligence,
    intelligenceInputSignature,
    intelligenceFreshness,
    cursor,
    intelligenceBudget: cursor?.budget ?? null,
    referenceDate,
  }
}

function isRawIntelligence(value: unknown): value is ResearchIntelligenceReport {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return Array.isArray(candidate.claims) && candidate.completeness !== undefined
}

/**
 * A legacy `ResearchOutput` (v0.3 `sources` + `summary` only) is not a
 * ResearchBundle: it has no evidence chain, so neither the intelligence engine
 * nor the production audit can read it. v0.7 degrades safely — the context is
 * still built, with `completenessStatus: UNKNOWN`, rather than throwing.
 */
export function isResearchBundle(research: ResearchBundle | null): research is ResearchBundle {
  if (research === null || typeof research !== "object") return false
  const candidate = research as unknown as { claims?: unknown; evidence?: unknown }
  return Array.isArray(candidate.claims) && Array.isArray(candidate.evidence)
}

function buildClaimViews(
  claims: Claim[],
  contradictions: Contradiction[],
  gaps: ResearchGap[],
  uncertainties: Uncertainty[],
): ContextClaimView[] {
  return claims
    .map((claim): ContextClaimView => {
      const contradictionIds = contradictions
        .filter((c) => c.claimA === claim.id || c.claimB === claim.id)
        .map((c) => c.id)
      const gapIds = gaps.filter((g) => g.relatedClaims.includes(claim.id)).map((g) => g.id)
      const uncertaintyIds = uncertainties
        .filter((u) => u.subjectType === "claim" && u.subjectId === claim.id)
        .map((u) => u.id)
      const usable = claimIsUsableForFact({
        knowledge: claim.knowledge,
        status: claim.status,
        confidence: claim.confidence,
        contradictionIds,
        uncertaintyIds,
      })
      return {
        claimId: claim.id,
        knowledge: claim.knowledge,
        status: claim.status,
        confidence: claim.confidence,
        usable,
        requiresQualification: !usable,
        contradictionIds,
        gapIds,
        uncertaintyIds,
      }
    })
    .sort((a, b) => a.claimId.localeCompare(b.claimId))
}

/**
 * Persisted artifacts may be partial (hand-edited, written by an older version,
 * or a resumed run mid-flight). Production must degrade to "no data", never
 * throw — a missing array is an absent fact, not a crash.
 */
function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
}

function buildHypothesisViews(
  hypotheses: Hypothesis[],
  verifications: HypothesisVerification[],
  versions: HypothesisVersion[],
): ContextHypothesisView[] {
  const verificationById = new Map(verifications.map((v) => [v.hypothesisId, v]))
  // A hypothesis and its current immutable version are different identities:
  // the hypothesis is the thread, the version is one immutable state of it.
  // Production must cite the *version* so a later revision is detectable.
  const currentVersionById = new Map<string, HypothesisVersion>()
  for (const version of versions) {
    const previous = currentVersionById.get(version.hypothesisId)
    if (previous === undefined || version.version > previous.version) {
      currentVersionById.set(version.hypothesisId, version)
    }
  }
  return hypotheses
    .filter((hypothesis) => hypothesis.status !== "REJECTED" && hypothesis.status !== "SUPERSEDED")
    .map((hypothesis): ContextHypothesisView => {
      const verification = verificationById.get(hypothesis.id)
      const version = currentVersionById.get(hypothesis.id)
      // v0.7 (H5): `statement` and the verification rationale are kept APART.
      // Concatenating them made every hypothesis reference match the
      // concatenated blob, so a sentence that merely echoed the reasoning
      // tripped (or, worse, evaded) the hypothesis-assertion test.
      return {
        hypothesisId: hypothesis.id,
        versionId: version?.versionId ?? hypothesis.id,
        statement: hypothesis.statement,
        verificationRationale: verification?.rationale ?? null,
        status: hypothesis.status,
        confidence: verification?.confidence ?? hypothesis.confidence,
        verificationStatus: verification?.status ?? "UNVERIFIED",
        supportingClaimIds: idsOf(hypothesis.supportingClaims),
        contradictingClaimIds: idsOf(hypothesis.contradictingClaims),
        researchGapIds: idsOf(hypothesis.researchGaps),
        isAlternative: /alternative/i.test(hypothesis.statement) || hypothesis.id.startsWith("ALT"),
      }
    })
    .sort((a, b) => a.hypothesisId.localeCompare(b.hypothesisId))
}

function buildUncertaintyViews(uncertainties: Uncertainty[]): ContextUncertaintyView[] {
  return uncertainties
    .map((u) => ({
      uncertaintyId: u.id,
      kind: u.kind,
      subjectType: u.subjectType,
      subjectId: u.subjectId,
      detail: u.detail,
    }))
    .sort((a, b) => a.uncertaintyId.localeCompare(b.uncertaintyId))
}

/**
 * v0.7 (M2) — the claim → evidence → source edges production needs in order to
 * tell "referenced" apart from "backed".
 *
 * A claim that lists no evidence (or only evidence whose source is missing) is
 * recorded as `supported: false`, which is what stops a FACT sentence from
 * passing traceability on the strength of a claim id alone.
 */
export function buildClaimTraceEdges(
  research: ResearchBundle | null,
  claims: readonly ContextClaimView[],
): ContextClaimTraceEdge[] {
  const evidence = research?.evidence ?? []
  const sources = research?.sources ?? []
  const knownSourceIds = new Set(sources.map((s) => s.id))
  const evidenceById = new Map(evidence.map((ev) => [ev.id, ev]))

  return claims
    .map((claim): ContextClaimTraceEdge => {
      const claimRecord = research?.claims?.find((c) => c.id === claim.claimId)
      // `evidence` contains prose; only evidenceIds declares provenance edges.
      // Keep dangling references visible so one valid edge cannot hide another
      // broken edge. The reverse support link must agree with the claim.
      const evidenceIds = [...new Set(claimRecord?.evidenceIds ?? [])]
      const sourceIds = [
        ...new Set(
          evidenceIds.flatMap((id) => {
            const item = evidenceById.get(id)
            return item ? [item.sourceId] : []
          }),
        ),
      ]
      return {
        claimId: claim.claimId,
        evidenceIds: evidenceIds.sort(),
        sourceIds: sourceIds.sort(),
        supported:
          evidenceIds.length > 0 &&
          evidenceIds.every((id) => {
            const item = evidenceById.get(id)
            return (
              item !== undefined &&
              knownSourceIds.has(item.sourceId) &&
              item.supportsClaims.includes(claim.claimId) &&
              !item.contradictsClaims.includes(claim.claimId)
            )
          }),
      }
    })
    .sort((a, b) => a.claimId.localeCompare(b.claimId))
}

function buildDecision(
  cursor: ReasoningCursor | null,
  cycles: Awaited<ReturnType<typeof readReasoningCycles>>,
): ReasoningDecision {
  if (cursor === null) {
    return {
      cycleId: null,
      sessionId: null,
      stepId: null,
      trigger: null,
      actionKind: "NONE",
      actionTarget: null,
      status: "NONE",
      stoppingKind: null,
      stoppingReason: null,
      humanInTheLoop: false,
      cycleCompleted: false,
    }
  }
  const cycleId = cursor.currentCycleId
  const cycle = cycleId === null ? undefined : cycles.find((c) => c.cycleId === cycleId)
  const cycleSteps = cycle?.steps ?? []
  const lastStep = cycleSteps[cycleSteps.length - 1] ?? cursor.steps[cursor.steps.length - 1]
  const stopping = cycle?.stopping ?? cursor.lastStopping
  const completed = cycle !== undefined && cycle.status !== "SEEDED"
  const action = lastStep?.action

  return {
    cycleId,
    sessionId: cursor.sessionId,
    stepId: lastStep?.id ?? null,
    trigger: cycle?.trigger ?? null,
    actionKind: completed ? "STOP" : ((action?.kind ?? "NONE") as ReasoningDecision["actionKind"]),
    actionTarget:
      action && "targetHypothesis" in action
        ? action.targetHypothesis
        : action && "target" in action && typeof action.target === "string"
          ? action.target
          : null,
    status: completed ? "STOPPED" : cursor.status,
    stoppingKind: stopping?.stoppingKind ?? null,
    stoppingReason: stopping?.reason ?? null,
    humanInTheLoop: cycle?.humanInTheLoop ?? false,
    cycleCompleted: completed,
  }
}

function buildSummary(
  claims: ContextClaimView[],
  hypotheses: ContextHypothesisView[],
  uncertainties: ContextUncertaintyView[],
  intelligence: ResearchIntelligenceReport | null,
  contradictionCount: number,
  gapCount: number,
): EpistemicSummary {
  const confidences = claims.map((claim) => claim.confidence)
  const mean =
    confidences.length === 0
      ? 0
      : confidences.reduce((total, value) => total + value, 0) / confidences.length
  return {
    claimCount: claims.length,
    usableClaimCount: claims.filter((claim) => claim.usable).length,
    qualifiedClaimCount: claims.filter((claim) => claim.requiresQualification).length,
    unsupportedClaimCount: claims.filter((claim) => claim.status === "UNSUPPORTED").length,
    hypothesisCount: hypotheses.length,
    activeHypothesisCount: hypotheses.filter(
      (h) => h.status === "ACTIVE" || h.status === "UNTESTED" || h.status === "APPROVED",
    ).length,
    contradictionCount,
    openGapCount: gapCount,
    uncertaintyCount: uncertainties.length,
    meanClaimConfidence: mean,
    completenessStatus: intelligence?.completeness.status ?? "UNKNOWN",
    continueResearch: intelligence?.continueResearch ?? true,
  }
}

export async function buildReasoningContext(
  input: BuildReasoningContextInput,
): Promise<ReasoningContext> {
  const snapshot = await loadSnapshot(input)
  const cycles = input.memory ? await readReasoningCycles(input.memory) : []
  const intelligence = snapshot.intelligence
  // v0.7 (H1): every signature in the context is computed against the SAME
  // resolved reference date the intelligence projection was validated with.
  const referenceDate = snapshot.referenceDate

  const contradictions = snapshot.research?.contradictions ?? []
  const gaps = snapshot.research?.gaps ?? []
  const uncertainties = intelligence?.uncertainties ?? []

  const claimViews = buildClaimViews(snapshot.claims, contradictions, gaps, uncertainties)
  const hypothesisViews = buildHypothesisViews(
    snapshot.hypotheses,
    snapshot.verifications,
    snapshot.versions,
  )
  const uncertaintyViews = buildUncertaintyViews(uncertainties)
  const decision = buildDecision(snapshot.cursor, cycles)

  const inputSignature = reasoningContextInputSignature({
    question: input.question,
    research: snapshot.research,
    hypotheses: snapshot.hypotheses,
    verifications: snapshot.verifications,
    intelligence,
    decision,
    referenceDate,
  })

  const constraints = deriveProductionConstraints({
    claims: claimViews,
    activeHypotheses: hypothesisViews,
    uncertainties: uncertaintyViews,
    contradictions: contradictions.map((c) => ({
      id: c.id,
      severity: c.severity,
      claimA: c.claimA,
      claimB: c.claimB,
    })),
    gaps: gaps.map((g) => ({ id: g.id, question: g.question, importance: g.importance })),
    decision,
  })

  const evidenceIds = (snapshot.research?.evidence ?? []).map((e) => e.id)
  const sourceIds = (snapshot.research?.sources ?? []).map((s) => s.id)

  const traceRefs: ReasoningContextTraceRefs = {
    reasoningCycleId: decision.cycleId,
    reasoningSessionId: decision.sessionId,
    reasoningStepId: decision.stepId,
    epistemicSignature: computeEpistemicSignature({
      question: input.question,
      research: snapshot.research,
      versions: snapshot.versions,
      hypotheses: snapshot.hypotheses,
    }),
    stateSignature: computeStateSignature({
      question: input.question,
      research: snapshot.research,
      intelligence,
      hypotheses: snapshot.hypotheses,
      versions: snapshot.versions,
      referenceDate,
    }),
    intelligenceInputSignature: snapshot.intelligenceInputSignature,
    intelligenceFreshness: snapshot.intelligenceFreshness,
    intelligenceBudget: snapshot.intelligenceBudget,
    claimIds: claimViews.map((claim) => claim.claimId),
    claimTraceEdges: buildClaimTraceEdges(snapshot.research, claimViews),
    hypothesisVersionIds: hypothesisViews.map((hypothesis) => hypothesis.versionId),
    contradictionIds: contradictions.map((c) => c.id),
    gapIds: gaps.map((gap) => gap.id),
    uncertaintyIds: uncertaintyViews.map((u) => u.uncertaintyId),
    evidenceIds,
    sourceIds,
  }

  const body = {
    version: REASONING_CONTEXT_VERSION,
    inputSignature,
    project: input.project,
    question: input.question,
    referenceDate,
    reasoningCycleId: decision.cycleId,
    decision,
    epistemicSummary: buildSummary(
      claimViews,
      hypothesisViews,
      uncertaintyViews,
      intelligence,
      contradictions.length,
      gaps.length,
    ),
    claims: claimViews,
    activeHypotheses: hypothesisViews,
    uncertainties: uncertaintyViews,
    constraints,
    traceRefs,
  } satisfies Omit<ReasoningContext, "contextSignature">

  return { ...body, contextSignature: computeReasoningContextSignature(body) }
}
