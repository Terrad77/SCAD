import type { Narrative, NarrativeSentence } from "../types.js"
import type { ProductionConstraintKind, ReasoningContext } from "./types.js"
import type { ConstraintTreatment, NarrativeLinkageReport } from "./linkage-schema.js"

const TREATMENTS: Partial<Record<ProductionConstraintKind, ConstraintTreatment["treatment"]>> = {
  QUALIFY_AS_HYPOTHESIS: "qualify-hypothesis",
  ACKNOWLEDGE_UNCERTAINTY: "acknowledge-uncertainty",
  DO_NOT_RESOLVE_CONTRADICTION: "preserve-contradiction",
  PRESERVE_RESEARCH_GAPS: "keep-gap-open",
  NO_DEFINITIVE_CONCLUSION: "avoid-definitive-conclusion",
  KEEP_TRACEABLE_TO_CLAIMS: "maintain-traceability",
  DO_NOT_PRESENT_AS_FACT: "limit-factual-assertion",
  DO_NOT_USE_UNSUPPORTED_CAUSAL_LANGUAGE: "avoid-unsupported-causality",
}

export function hasExplicitReferences(sentence: NarrativeSentence): boolean {
  return [
    sentence.hypothesisIds,
    sentence.uncertaintyIds,
    sentence.contradictionIds,
    sentence.constraintTreatments,
  ].some((value) => value !== undefined)
}

/** Declared subject relationship only. Never certifies what the prose actually says. */
export function referencesUncertaintySubject(
  sentence: NarrativeSentence,
  uncertainty: ReasoningContext["uncertainties"][number],
  context: ReasoningContext,
): boolean {
  if (uncertainty.subjectType === "research") return true // Global scope is explicit; semantics remains UNKNOWN.
  if (uncertainty.subjectType === "claim")
    return (
      context.claims.some((c) => c.claimId === uncertainty.subjectId) &&
      sentence.claimIds.includes(uncertainty.subjectId)
    )
  if (uncertainty.subjectType === "hypothesis")
    return (
      context.activeHypotheses.some((h) => h.hypothesisId === uncertainty.subjectId) &&
      (sentence.hypothesisIds ?? []).includes(uncertainty.subjectId)
    )
  return (
    context.traceRefs.evidenceIds.includes(uncertainty.subjectId) &&
    (context.traceRefs.claimTraceEdges ?? []).some(
      (edge) =>
        context.claims.some((c) => c.claimId === edge.claimId) &&
        sentence.claimIds.includes(edge.claimId) &&
        edge.evidenceIds.includes(uncertainty.subjectId),
    )
  )
}

/** Pure structural validation; model-authored treatment text is never evidence. */
export function auditNarrativeReferences(
  narrative: Narrative,
  context: ReasoningContext,
): NarrativeLinkageReport {
  const sentences = narrative.sections.flatMap((section) => section.sentences)
  const explicit = sentences.some(hasExplicitReferences)
  const report: NarrativeLinkageReport = {
    version: 1,
    mode: explicit ? "explicit" : "legacy",
    structuralStatus: explicit ? "PASS" : "UNKNOWN",
    semanticStatus: "not-applicable",
    references: [],
    constraints: [],
    issues: [],
  }
  const hypotheses = new Set(context.activeHypotheses.map((h) => h.hypothesisId))
  const uncertainties = new Map(context.uncertainties.map((u) => [u.uncertaintyId, u]))
  const contradictions = new Set(context.traceRefs.contradictionIds)
  const constraints = new Map(context.constraints.map((c) => [c.id, c]))
  const sentenceIds = new Set<string>()
  const add = (
    sentence: NarrativeSentence,
    kind: NarrativeLinkageReport["references"][number]["kind"],
    targetId: string,
    valid: boolean,
    detail: string,
  ) => {
    report.references.push({
      sentenceId: sentence.id,
      kind,
      targetId,
      status: valid ? "VALID" : "INVALID",
      detail,
    })
    if (!valid) report.issues.push({ sentenceId: sentence.id, targetId, detail })
  }
  for (const sentence of sentences) {
    if (sentenceIds.has(sentence.id) && explicit)
      report.issues.push({
        sentenceId: sentence.id,
        targetId: sentence.id,
        detail: "Duplicate sentence ID makes reference ownership ambiguous",
      })
    sentenceIds.add(sentence.id)
    for (const id of sentence.hypothesisIds ?? [])
      add(
        sentence,
        "hypothesis",
        id,
        hypotheses.has(id),
        hypotheses.has(id)
          ? "Hypothesis resolves in the signed context"
          : "Hypothesis is absent from the signed context",
      )
    for (const id of sentence.uncertaintyIds ?? []) {
      const uncertainty = uncertainties.get(id)
      const valid =
        uncertainty !== undefined && referencesUncertaintySubject(sentence, uncertainty, context)
      add(
        sentence,
        "uncertainty",
        id,
        valid,
        valid
          ? "Uncertainty and its declared subject resolve"
          : "Uncertainty is missing or the sentence references an unrelated subject",
      )
    }
    for (const id of sentence.contradictionIds ?? []) {
      const constraint = context.constraints.find(
        (c) => c.kind === "DO_NOT_RESOLVE_CONTRADICTION" && c.subjectIds[0] === id,
      )
      const related =
        constraint !== undefined &&
        constraint.subjectIds
          .slice(1)
          .some(
            (claim) =>
              context.claims.some((c) => c.claimId === claim) && sentence.claimIds.includes(claim),
          )
      add(
        sentence,
        "contradiction",
        id,
        contradictions.has(id) && related,
        related && contradictions.has(id)
          ? "Contradiction and a declared side resolve"
          : "Contradiction is missing or neither side is referenced",
      )
    }
    for (const treatment of sentence.constraintTreatments ?? []) {
      const constraint = constraints.get(treatment.constraintId)
      const declared = JSON.stringify([...treatment.subjectIds].sort())
      const expected = JSON.stringify([...(constraint?.subjectIds ?? [])].sort())
      const referencesValid = report.references
        .filter((r) => r.sentenceId === sentence.id && r.kind !== "constraint")
        .every((r) => r.status === "VALID")
      const valid =
        referencesValid &&
        constraint !== undefined &&
        TREATMENTS[constraint.kind] === treatment.treatment &&
        declared === expected &&
        treatmentSubjectsResolve(sentence, constraint.kind, constraint.subjectIds)
      add(
        sentence,
        "constraint",
        treatment.constraintId,
        valid,
        valid
          ? "Treatment kind and subject relationships resolve; explanation is unverified"
          : "Constraint, treatment kind or subject relationships do not match",
      )
    }
  }
  for (const constraint of context.constraints) {
    const governance = constraint.kind === "REQUIRE_HUMAN_APPROVAL"
    const owners = report.references
      .filter(
        (r) => r.kind === "constraint" && r.targetId === constraint.id && r.status === "VALID",
      )
      .map((r) => r.sentenceId)
    const bothSides =
      constraint.kind !== "DO_NOT_RESOLVE_CONTRADICTION" ||
      constraint.subjectIds
        .slice(1)
        .every((id) =>
          sentences.some(
            (s) => owners.includes(s.id) && s.knowledge !== "FICTION" && s.claimIds.includes(id),
          ),
        )
    report.constraints.push({
      constraintId: constraint.id,
      sentenceIds: [...new Set(owners)].sort(),
      status: governance ? "GOVERNANCE" : owners.length > 0 && bothSides ? "COVERED" : "MISSING",
      semanticStatus: governance ? "not-applicable" : "UNKNOWN",
    })
  }
  if (report.issues.length > 0) report.structuralStatus = "FAIL"
  else if (explicit && report.constraints.some((c) => c.status === "MISSING"))
    report.structuralStatus = "WARN"
  if (report.references.length > 0 || report.constraints.some((c) => c.status !== "GOVERNANCE"))
    report.semanticStatus = "UNKNOWN"
  return report
}

function treatmentSubjectsResolve(
  sentence: NarrativeSentence,
  kind: ProductionConstraintKind,
  subjects: string[],
): boolean {
  switch (kind) {
    case "QUALIFY_AS_HYPOTHESIS":
      return subjects.every((id) => sentence.hypothesisIds?.includes(id))
    case "ACKNOWLEDGE_UNCERTAINTY":
      return sentence.uncertaintyIds?.includes(subjects[0] ?? "") ?? false
    case "DO_NOT_RESOLVE_CONTRADICTION":
      return sentence.contradictionIds?.includes(subjects[0] ?? "") ?? false
    case "DO_NOT_PRESENT_AS_FACT":
      return subjects.every((id) => sentence.claimIds.includes(id))
    case "KEEP_TRACEABLE_TO_CLAIMS":
      return sentence.claimIds.length > 0 && sentence.claimIds.every((id) => subjects.includes(id))
    // Gaps and global prose constraints are explicit declarations, not semantic proof.
    case "PRESERVE_RESEARCH_GAPS":
    case "NO_DEFINITIVE_CONCLUSION":
    case "DO_NOT_USE_UNSUPPORTED_CAUSAL_LANGUAGE":
      return true
    case "REQUIRE_HUMAN_APPROVAL":
      return false
  }
}
