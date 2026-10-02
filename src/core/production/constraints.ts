import type { ContradictionSeverity } from "../types.js"
import {
  PRODUCTION_CONSTRAINT_KINDS,
  type ContextClaimView,
  type ContextHypothesisView,
  type ContextUncertaintyView,
  type ProductionConstraint,
  type ProductionConstraintKind,
  type ReasoningDecision,
} from "./types.js"

/**
 * v0.7 — deterministic production constraints (§8).
 *
 * Every rule that production must obey is an explicit, serializable object
 * derived from the epistemic state and the reasoning result — never a sentence
 * buried in a prompt. The narrative/visual prompts *describe* these rules to
 * the LLM; the guards in `integrity.ts` / `guards.ts` *enforce* them.
 *
 * The derivation is a pure function of its inputs, so identical epistemic +
 * reasoning state always yields a byte-identical constraint list.
 */

/** A claim carrying an explicit gap above this importance is not "settled". */
export const CRITICAL_GAP_IMPORTANCE = 0.75

/** Claims below this confidence are never narratable as established fact. */
export const QUALIFIED_CLAIM_CONFIDENCE = 0.7

export function constraintIdOf(kind: ProductionConstraintKind, subjectId?: string): string {
  return `${kind}#${subjectId ?? "global"}`
}

export interface ConstraintInput {
  claims: ContextClaimView[]
  activeHypotheses: ContextHypothesisView[]
  uncertainties: ContextUncertaintyView[]
  contradictions: Array<{
    id: string
    severity: ContradictionSeverity
    claimA: string
    claimB: string
  }>
  gaps: Array<{ id: string; question: string; importance: number }>
  decision: ReasoningDecision
}

export function claimIsUsableForFact(claim: {
  knowledge: string
  status: string
  confidence: number
  contradictionIds: string[]
  uncertaintyIds: string[]
}): boolean {
  return claimBlockingReason(claim) === null
}

/**
 * Why a claim may not be narrated as fact — or `null` when it may. Exposed so
 * diagnostics can say WHY a label was downgraded instead of restating the
 * claim's own classification.
 */
export function claimBlockingReason(claim: {
  knowledge: string
  status: string
  confidence: number
  contradictionIds: string[]
  uncertaintyIds: string[]
}): string | null {
  if (claim.knowledge !== "FACT") return `it is classified ${claim.knowledge}, not FACT`
  if (claim.status === "UNSUPPORTED") return "it is UNSUPPORTED"
  if (claim.status === "DISPUTED") return "it is DISPUTED"
  if (claim.confidence < QUALIFIED_CLAIM_CONFIDENCE) {
    return `its confidence ${claim.confidence.toFixed(2)} is below ${QUALIFIED_CLAIM_CONFIDENCE.toFixed(2)}`
  }
  if (claim.contradictionIds.length > 0) {
    return `it is involved in unresolved contradiction(s) ${claim.contradictionIds.join(", ")}`
  }
  if (claim.uncertaintyIds.length > 0) {
    return `explicit uncertainty ${claim.uncertaintyIds.join(", ")} is recorded against it`
  }
  return null
}

export function deriveProductionConstraints(input: ConstraintInput): ProductionConstraint[] {
  const constraints: ProductionConstraint[] = []

  for (const claim of input.claims) {
    if (claim.requiresQualification || !claim.usable) {
      // A claim is a hard block when the epistemic layer has evidence against
      // it (unsupported, disputed, or in an unresolved contradiction); a soft
      // one when the block is only a confidence/uncertainty shortfall.
      const reason = claimBlockingReason(claim)
      const hard =
        claim.status === "UNSUPPORTED" ||
        claim.status === "DISPUTED" ||
        claim.contradictionIds.length > 0
      constraints.push({
        id: constraintIdOf("DO_NOT_PRESENT_AS_FACT", claim.claimId),
        kind: "DO_NOT_PRESENT_AS_FACT",
        severity: hard ? "critical" : "warning",
        rule:
          reason === null
            ? `Do not present claim ${claim.claimId} as established fact.`
            : `Do not present claim ${claim.claimId} as established fact: ${reason}.`,
        subjectIds: [claim.claimId],
        source: "epistemic",
      })
    }
  }

  for (const hypothesis of input.activeHypotheses) {
    if (hypothesis.verificationStatus === "SUPPORTED") continue
    constraints.push({
      id: constraintIdOf("QUALIFY_AS_HYPOTHESIS", hypothesis.hypothesisId),
      kind: "QUALIFY_AS_HYPOTHESIS",
      severity: "critical",
      rule: `Qualify hypothesis ${hypothesis.hypothesisId} explicitly as a scientific hypothesis (${hypothesis.verificationStatus}).`,
      subjectIds: [hypothesis.hypothesisId],
      source: "epistemic",
    })
  }

  for (const contradiction of input.contradictions) {
    constraints.push({
      id: constraintIdOf("DO_NOT_RESOLVE_CONTRADICTION", contradiction.id),
      kind: "DO_NOT_RESOLVE_CONTRADICTION",
      severity: contradiction.severity === "HIGH" ? "critical" : "warning",
      rule: `Do not resolve contradiction ${contradiction.id} (${contradiction.claimA} vs ${contradiction.claimB}) in narration; present both sides.`,
      subjectIds: [contradiction.id, contradiction.claimA, contradiction.claimB],
      source: "epistemic",
    })
  }

  for (const uncertainty of input.uncertainties) {
    constraints.push({
      id: constraintIdOf("ACKNOWLEDGE_UNCERTAINTY", uncertainty.uncertaintyId),
      kind: "ACKNOWLEDGE_UNCERTAINTY",
      severity: "warning",
      rule: `Explicitly acknowledge uncertainty ${uncertainty.uncertaintyId} (${uncertainty.kind}) about ${uncertainty.subjectId}.`,
      subjectIds: [uncertainty.uncertaintyId, uncertainty.subjectId],
      source: "epistemic",
    })
  }

  if (input.contradictions.length > 0 || input.uncertainties.length > 0) {
    constraints.push({
      id: constraintIdOf("DO_NOT_USE_UNSUPPORTED_CAUSAL_LANGUAGE"),
      kind: "DO_NOT_USE_UNSUPPORTED_CAUSAL_LANGUAGE",
      severity: "warning",
      rule: "Do not use causal or definitive language that the unresolved contradictions and uncertainties do not support.",
      subjectIds: [],
      source: "epistemic",
    })
  }

  const terminalConfident =
    input.decision.stoppingKind === "STOP_CONFIDENT_ENOUGH" &&
    input.decision.status === "STOPPED" &&
    input.decision.cycleCompleted
  if (!terminalConfident) {
    constraints.push({
      id: constraintIdOf("NO_DEFINITIVE_CONCLUSION"),
      kind: "NO_DEFINITIVE_CONCLUSION",
      severity: "critical",
      rule: `Do not produce a definitive conclusion: reasoning ended as ${
        input.decision.stoppingKind ?? "unresolved"
      }.`,
      subjectIds: [],
      source: "reasoning",
    })
  }

  for (const gap of input.gaps) {
    if (gap.importance < CRITICAL_GAP_IMPORTANCE) continue
    constraints.push({
      id: constraintIdOf("PRESERVE_RESEARCH_GAPS", gap.id),
      kind: "PRESERVE_RESEARCH_GAPS",
      severity: "warning",
      rule: `Research gap ${gap.id} (importance ${gap.importance.toFixed(2)}) is unresolved: ${gap.question}`,
      subjectIds: [gap.id],
      source: "epistemic",
    })
  }

  if (input.claims.some((claim) => claim.usable)) {
    constraints.push({
      id: constraintIdOf("KEEP_TRACEABLE_TO_CLAIMS"),
      kind: "KEEP_TRACEABLE_TO_CLAIMS",
      severity: "critical",
      rule: "Every factual sentence must reference the claim id(s) it rests on; an untraceable sentence must not be labelled FACT.",
      subjectIds: input.claims.filter((claim) => claim.usable).map((claim) => claim.claimId),
      source: "epistemic",
    })
  }

  constraints.push({
    id: constraintIdOf("REQUIRE_HUMAN_APPROVAL"),
    kind: "REQUIRE_HUMAN_APPROVAL",
    severity: "critical",
    rule: "Human approval is required before the narrative is released downstream; rejection must not change epistemic state.",
    subjectIds: [],
    source: "governance",
  })

  return sortConstraints(constraints)
}

/** Deterministic order: taxonomy order, then subject, then id. */
export function sortConstraints(constraints: ProductionConstraint[]): ProductionConstraint[] {
  return [...constraints].sort((a, b) => {
    const byKind = rankOf(a.kind) - rankOf(b.kind)
    if (byKind !== 0) return byKind
    const bySubject = a.subjectIds.join(",").localeCompare(b.subjectIds.join(","))
    if (bySubject !== 0) return bySubject
    return a.id.localeCompare(b.id)
  })
}

/**
 * The constraint governing (kind, subject). A global constraint of the same
 * kind also governs every subject of that kind, so a caller never misses a rule
 * just because it was emitted once for the whole artifact.
 */
export function findConstraint(
  constraints: readonly ProductionConstraint[],
  kind: ProductionConstraintKind,
  subjectId?: string,
): ProductionConstraint | undefined {
  const global = constraints.find(
    (c) => c.kind === kind && (c.id === constraintIdOf(kind) || c.subjectIds.length === 0),
  )
  if (global) return global
  if (subjectId === undefined) return undefined
  return constraints.find((c) => c.kind === kind && c.subjectIds.includes(subjectId))
}

function rankOf(kind: ProductionConstraintKind): number {
  return PRODUCTION_CONSTRAINT_KINDS.indexOf(kind)
}
