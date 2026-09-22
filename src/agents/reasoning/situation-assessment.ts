import type {
  HypothesisVerification,
  ResearchBundle,
  ResearchIntelligenceReport,
} from "../../core/schemas.js"
import type {
  ContradictionSignal,
  CycleContext,
  GapSignal,
  HypothesisVersion,
  LowQualitySignal,
  ReasoningSituation,
  ReasoningStep,
} from "../../core/reasoning/types.js"
import { STRONG_EVIDENCE_QUALITY } from "../../core/evidence/weights.js"
import { activeVersions, toActiveHypotheses } from "../../core/reasoning/hypothesis-version.js"
import { verifyPureHypotheses } from "../../core/reasoning/hypothesis-verification.js"
import { ALTERNATIVE_REASON_PREFIX, alternativeReasonFor } from "./hypothesis-lifecycle.js"

export interface SituationInput {
  question: string
  research: ResearchBundle
  intelligence: ResearchIntelligenceReport
  versions: HypothesisVersion[]
  /** Steps of the current cycle (all signatures) to detect repeat attempts. */
  cycleSteps: ReasoningStep[]
  /** Signature of the epistemic state the upcoming decision is made against. */
  stateSignatureBefore: string
  cycleContext: CycleContext
  humanInTheLoop?: boolean
}

export function researchKeyOf(subject: string, id: string): string {
  return `RESEARCH|${subject}|${id}`
}

export function actionKeyOf(actionKind: string, subject: string, id: string): string {
  return `${actionKind}|${subject}|${id}`
}

/** The fixed nesting the loop guard uses: object-key collisions cannot occur. */
export function researchTargetKey(target: { subject: string; id: string }): string {
  return researchKeyOf(target.subject, target.id)
}

/**
 * Assembles the deterministic view the policy reasons over: pure derivations
 * only. Nothing here mutates state; verifications are recomputed from the
 * evidence chain and the active pointers.
 */
export function assessSituation(input: SituationInput): ReasoningSituation {
  const active = toActiveHypotheses(input.versions)
  const verifications: HypothesisVerification[] = verifyPureHypotheses({
    hypotheses: active,
    research: input.research,
  })
  const byClaim = new Map(input.research.claims.map((c) => [c.id, c]))
  const claimStatement = (claimId: string): string => byClaim.get(claimId)?.statement ?? claimId

  const researchAttemptedThisCycle = new Set(
    input.cycleSteps
      .filter((s) => s.action.kind === "RESEARCH")
      .map((s) => (s.action.kind === "RESEARCH" ? researchTargetKey(s.action.target) : "")),
  )

  const attemptedAtSignature = new Set(
    input.cycleSteps
      .filter((s) => s.stateSignatureBefore === input.stateSignatureBefore)
      .flatMap((s) => {
        if (s.action.kind === "RESEARCH") return [researchTargetKey(s.action.target)]
        if (s.action.kind === "STOP") return []
        if (s.action.kind === "GENERATE_HYPOTHESIS")
          return [actionKeyOf("GENERATE_HYPOTHESIS", s.action.targetHypothesis ?? "", "")]
        if (s.action.kind === "REQUEST_HUMAN_INPUT")
          return [actionKeyOf("REQUEST_HUMAN_INPUT", s.action.target, "")]
        return [actionKeyOf(s.action.kind, s.action.targetHypothesis, "")]
      }),
  )

  const openContradictions: ContradictionSignal[] = input.intelligence.unresolvedContradictions
    .filter((c) => c.severity === "HIGH")
    .map((c) => {
      const analysis = input.intelligence.contradictions.find((a) => a.contradictionId === c.id)
      const relatedGap = input.research.gaps.find(
        (g) => g.relatedClaims.includes(c.claimA) || g.relatedClaims.includes(c.claimB),
      )
      const claimA = byClaim.get(c.claimA)
      const claimB = byClaim.get(c.claimB)
      return {
        id: c.id,
        claimA: c.claimA,
        claimB: c.claimB,
        analysis: analysis?.analysis ?? c.classification,
        gapId: relatedGap?.id ?? null,
        subquestionId:
          relatedGap?.subquestionId ??
          claimA?.subquestionIds?.[0] ??
          claimB?.subquestionIds?.[0] ??
          null,
        evidenceId: claimA?.evidenceIds?.[0] ?? claimB?.evidenceIds?.[0] ?? null,
        query:
          relatedGap?.suggestedResearchQueries[0] ??
          `Independent evidence adjudicating "${claimStatement(c.claimA)}" vs "${claimStatement(c.claimB)}"`,
      }
    })

  const gaps: GapSignal[] = input.research.gaps.map((g) => ({
    id: g.id,
    importance: g.importance,
    query: g.suggestedResearchQueries[0] ?? input.question,
  }))

  const lowQualityEvidence: LowQualitySignal[] = input.intelligence.evidenceQuality
    .filter((q) => q.overall < STRONG_EVIDENCE_QUALITY)
    .map((q) => {
      const statement = input.research.evidence.find((e) => e.id === q.evidenceId)?.statement
      return {
        id: q.evidenceId,
        overall: q.overall,
        query: statement
          ? `Higher-quality evidence for: "${statement}"`
          : `Higher-quality evidence for ${q.evidenceId}`,
      }
    })

  const alternativeCounts = new Map<string, number>()
  for (const hypothesis of active) {
    alternativeCounts.set(
      hypothesis.id,
      input.versions.filter(
        (v) => v.hypothesisId !== hypothesis.id && v.reason === alternativeReasonFor(hypothesis.id),
      ).length,
    )
  }

  const researchExists = input.research.claims.length > 0 || input.research.evidence.length > 0
  const activeCount = activeVersions(input.versions).length

  const isAlternative = new Set<string>()
  for (const hypothesis of active) {
    if (
      input.versions.some(
        (v) => v.hypothesisId === hypothesis.id && v.reason.startsWith(ALTERNATIVE_REASON_PREFIX),
      )
    ) {
      isAlternative.add(hypothesis.id)
    }
  }

  return {
    question: input.question,
    researchCompleted: researchExists,
    verifications,
    alternativeCounts,
    isAlternative,
    activeCount,
    attemptedKeys: attemptedAtSignature,
    researchAttemptedThisCycle,
    cycleContext: input.cycleContext,
    limitsExhausted: !input.intelligence.stopping.limitsRespected,
    continueResearch: input.intelligence.continueResearch,
    humanInTheLoop: input.humanInTheLoop ?? false,
    stoppingReasons: input.intelligence.stopping.reasons,
    openContradictions,
    gaps,
    lowQualityEvidence,
  }
}
