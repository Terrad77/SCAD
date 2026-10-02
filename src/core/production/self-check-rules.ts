import type { Narrative, Shot, VisualOutput } from "../types.js"
import { findConstraint } from "./constraints.js"
import {
  VERIFIABLE_VIOLATION_KINDS,
  chainDataAvailable,
  traceabilityFindings,
  uncertaintyCoverage,
  verifyViolationPostcondition,
} from "./coverage.js"
import {
  assertedHypotheses,
  assertsHypothesis,
  enforceKnowledgeCeiling,
  isVisualTypePermitted,
  weakestPosture,
} from "./integrity.js"
import { artifactContentSignature } from "./signature.js"
import {
  PRODUCTION_CHECK_IDS,
  type ProductionCheckId,
  type ProductionCheckResult,
  type ProductionCheckStatus,
  type ProductionProvenance,
  type ReasoningContext,
  type SelfCheckDiagnostic,
  type SelfCheckProductionReport,
} from "./types.js"
import { protectedKeys } from "./write-scope.js"

/**
 * v0.7 — the independent production audit run by SelfCheck (§10, §11).
 *
 * This is a SECOND, independent check of the same invariants the guards
 * enforce, deliberately re-derived from the persisted artifacts rather than
 * reading the guards' own verdict. Guards make an artifact compliant; the audit
 * verifies that it stayed compliant and that the LLM did not *try* to break the
 * rules (recorded as WARN, so overreach stays visible).
 *
 * Consequences of a finding (I4, I5, I9):
 *   • a diagnostic is a DIAGNOSTIC — never evidence, never a claim
 *     verification, never a hypothesis verification;
 *   • `epistemicMutation` is the literal `false`;
 *   • nothing here writes to the epistemic or reasoning stores.
 */

export interface ProductionAuditInput {
  context: ReasoningContext
  narrative: Narrative
  visual: VisualOutput
  /**
   * Provenance the guards recorded, if the artifacts went through them.
   * Optional: it defaults to the provenance carried by the artifacts
   * themselves, so a caller cannot accidentally audit a guarded artifact as if
   * it had never been guarded.
   */
  narrativeProvenance?: ProductionProvenance | null
  visualProvenance?: ProductionProvenance | null
  /** Memory keys each production stage actually wrote (for scope compliance). */
  writes?: Array<{ artifact: string; keys: string[] }>
}

interface Findings {
  checks: ProductionCheckResult[]
  diagnostics: SelfCheckDiagnostic[]
}

function worst(statuses: ProductionCheckStatus[]): ProductionCheckStatus {
  if (statuses.includes("FAIL")) return "FAIL"
  if (statuses.includes("WARN")) return "WARN"
  if (statuses.includes("PASS")) return "PASS"
  return "UNKNOWN"
}

/**
 * Whether a report may be certified, given the UNKNOWNs it contains.
 *
 * An UNKNOWN is only blocking when the check itself declared
 * `unknownReason: "unverifiable"` — the constraint is relevant and the audit
 * could not establish it. A `not-applicable` UNKNOWN means the constraint is
 * vacuous here (no recorded uncertainties, no contradictions to preserve), and
 * blocking on it would make the audit cry wolf on every ordinary project.
 *
 * The reason is read from the check rather than from an id allowlist, because
 * whether a given id is blocking depends on WHY it was undecidable in that run:
 * HYPOTHESIS_INTEGRITY is not-applicable (nothing resembles a hypothesis) on an
 * ordinary film and unverifiable (a near-miss cannot be settled lexically) on a
 * different one. A static id list would have to pick one and be wrong in the
 * other case — which is exactly how the H5 band previously slipped through to a
 * clean PASS.
 */
function verdictOf(checks: ProductionCheckResult[]): ProductionCheckStatus {
  const base = worst(checks.map((check) => check.status))
  if (base !== "PASS") return base
  const unverifiable = checks.filter(
    (check) => check.status === "UNKNOWN" && check.unknownReason === "unverifiable",
  )
  return unverifiable.length > 0 ? "UNKNOWN" : base
}

export function auditProduction(input: ProductionAuditInput): SelfCheckProductionReport {
  const { context, narrative, visual } = input
  const narrativeProvenance = input.narrativeProvenance ?? narrative.production ?? null
  const visualProvenance = input.visualProvenance ?? visual.production ?? null
  const sentences = narrative.sections.flatMap((section) => section.sentences)
  const sentenceById = new Map(sentences.map((s) => [s.id, s]))
  const claimById = new Map(context.claims.map((claim) => [claim.claimId, claim]))
  const hypothesisById = new Map(
    context.activeHypotheses.map((hypothesis) => [hypothesis.hypothesisId, hypothesis]),
  )
  const findings: Findings = { checks: [], diagnostics: [] }

  // -- v0.7 (H6): violation postconditions, verified independently ------------
  //
  // The guards' `resolved` flag is NOT proof, so every recorded violation is
  // re-checked against the artifact as it stands right now, before any verdict
  // is computed. An UNRESOLVED critical violation forces FAIL regardless of
  // what the other checks concluded — including when they concluded UNKNOWN.
  const unresolvedCritical: string[] = []
  const unverifiable: string[] = []
  if (findConstraint(context.constraints, "NO_DEFINITIVE_CONCLUSION")) {
    for (const sentence of sentences) {
      if (
        sentence.knowledge !== "FICTION" &&
        /^(conclusion|in conclusion|ultimately|definitively)\b/i.test(sentence.text)
      ) {
        unresolvedCritical.push(`NO_DEFINITIVE_CONCLUSION [${sentence.id}]`)
      }
    }
  }
  for (const provenance of [narrativeProvenance, visualProvenance]) {
    for (const violation of provenance?.violations ?? []) {
      const verdict = verifyViolationPostcondition(violation, context, narrative)
      if (verdict.holds) continue
      if (!VERIFIABLE_VIOLATION_KINDS.has(violation.kind)) {
        unverifiable.push(`${violation.kind}@${violation.subjectIds.join("+")}`)
      }
      if (violation.severity === "critical") {
        unresolvedCritical.push(
          `${violation.kind} [${violation.subjectIds.join(", ")}] — ${verdict.detail}`,
        )
      }
    }
  }

  let diagnosticSeq = 0
  const diagnose = (
    kind: SelfCheckDiagnostic["kind"],
    severity: SelfCheckDiagnostic["severity"],
    detail: string,
    subjectIds: string[],
  ): void => {
    diagnosticSeq += 1
    findings.diagnostics.push({
      id: `PDIAG_${String(diagnosticSeq).padStart(3, "0")}`,
      kind,
      severity,
      detail,
      subjectIds,
      // Epistemic shortfalls are actionable by more research in a future cycle;
      // release-gate breaches need a person.
      route: kind === "traceability" || kind === "scope-violation" ? "human" : "reasoning",
    })
  }

  // -- 1. EPISTEMIC_INTEGRITY -------------------------------------------------
  {
    const uncheckedConstraints = context.constraints.filter(
      (constraint) =>
        constraint.kind === "DO_NOT_USE_UNSUPPORTED_CAUSAL_LANGUAGE" ||
        constraint.kind === "PRESERVE_RESEARCH_GAPS",
    )
    const statuses: ProductionCheckStatus[] = []
    const overstated: string[] = []
    for (const sentence of sentences) {
      const { changed } = enforceKnowledgeCeiling(
        sentence.knowledge,
        sentence.claimIds,
        context,
        sentence.text,
      )
      if (changed) {
        overstated.push(sentence.id)
      }
    }
    for (const shot of visual.shots) {
      const postures = shot.narrativeSentenceIds
        .map((id) => sentenceById.get(id))
        .filter((s): s is NonNullable<typeof s> => s !== undefined)
        .map((s) => s.knowledge)
      const posture = postures.length ? weakestPosture(postures) : "FICTION"
      if (!isVisualTypePermitted(posture, shot.visualType)) overstated.push(shot.id)
    }
    const guardCorrections =
      (narrativeProvenance?.normalizations.length ?? 0) +
      (visualProvenance?.normalizations.length ?? 0)

    if (overstated.length > 0) {
      statuses.push("FAIL")
      diagnose(
        "epistemic-integrity",
        "critical",
        `Production still asserts more than the reasoning context supports: ${overstated.join(", ")}.`,
        overstated,
      )
    } else if (guardCorrections > 0) {
      statuses.push("WARN")
      diagnose(
        "epistemic-integrity",
        "warning",
        `The guard had to correct ${guardCorrections} over-assertive label(s)/type(s) before persistence.`,
        [],
      )
    } else {
      statuses.push("PASS")
    }
    if (unverifiable.length > 0) {
      statuses.push("WARN")
      diagnose(
        "epistemic-integrity",
        "warning",
        `Violations with no independent postcondition to re-verify: ${unverifiable.join("; ")}.`,
        [],
      )
    }
    if (unresolvedCritical.length > 0) {
      statuses.push("FAIL")
      diagnose(
        "epistemic-integrity",
        "critical",
        `Critical violations still present after the guard ran: ${unresolvedCritical.join("; ")}.`,
        [],
      )
    }
    const status = worst(statuses)
    findings.checks.push({
      id: "EPISTEMIC_INTEGRITY",
      status: status === "PASS" && uncheckedConstraints.length > 0 ? "UNKNOWN" : status,
      ...(status === "PASS" && uncheckedConstraints.length > 0
        ? { unknownReason: "unverifiable" as const }
        : {}),
      detail:
        unresolvedCritical.length > 0
          ? `${unresolvedCritical.length} critical violation(s) remain unresolved in the persisted artifact.`
          : uncheckedConstraints.length > 0 && status === "PASS"
            ? `Labels comply, but prose constraints have no independent verifier: ${uncheckedConstraints.map((c) => c.id).join(", ")}.`
            : statuses.includes("PASS")
              ? "No sentence or shot exceeds the epistemic ceiling of the reasoning context."
              : `${overstated.length} subject(s) exceed the epistemic ceiling; ${guardCorrections} guard correction(s) recorded.`,
      subjectIds: [...new Set([...overstated, ...unresolvedCritical])],
    })
  }

  // -- 2. TRACEABILITY --------------------------------------------------------
  {
    // v0.7 (M2) — traceability is checked against the claim → evidence → source
    // EDGE, not against id presence. A FACT sentence citing a claim the context
    // knows but that nothing backs is a finding, which is the case the review
    // showed passing before.
    //
    // Three outcomes, and the middle one used to be missing:
    //   FAIL    a demonstrated break — an edge that names evidence or a source
    //           the context does not carry, an edge that reaches nothing, or a
    //           claim with no edge at all while other edges are present.
    //   UNKNOWN the context carries no chain data at all (a v0.6 context, or a
    //           truncated one). Traceability cannot be established OR refuted,
    //           and reporting PASS there would be a claim we cannot make.
    //   PASS    every cited claim resolves to evidence and to a source.
    const chainKnown = chainDataAvailable(context)
    const chain = traceabilityFindings(context, narrative)
    const broken: string[] = []
    for (const sentence of sentences) {
      if (sentence.claimIds.some((id) => !claimById.has(id))) broken.push(sentence.id)
    }
    for (const shot of visual.shots) {
      if (shot.narrativeSentenceIds.some((id) => !sentenceById.has(id))) broken.push(shot.id)
      // A shot's `source` may be a research source id or an evidence id, and
      // both are legitimate handles — only a reference to neither is dangling.
      if (
        shot.source !== undefined &&
        !context.traceRefs.sourceIds.includes(shot.source) &&
        !context.traceRefs.evidenceIds.includes(shot.source)
      ) {
        broken.push(shot.id)
      }
    }
    const hasFactSentence = sentences.some((s) => s.knowledge === "FACT")
    const subjects = [...new Set([...chain.map((f) => f.sentenceId), ...broken])]
    if (subjects.length > 0) {
      findings.checks.push({
        id: "TRACEABILITY",
        status: "FAIL",
        detail:
          chain.length > 0
            ? chain.map((f) => f.detail).join(" ")
            : `Dangling provenance references: ${subjects.join(", ")}.`,
        subjectIds: subjects,
      })
      diagnose(
        "traceability",
        "critical",
        chain.length > 0
          ? `FACT sentences without a complete claim→evidence→source chain: ${subjects.join(", ")}.`
          : `Production references subjects absent from the reasoning context: ${subjects.join(", ")}.`,
        subjects,
      )
    } else if (!chainKnown && hasFactSentence) {
      findings.checks.push({
        id: "TRACEABILITY",
        status: "UNKNOWN",
        unknownReason: "unverifiable",
        detail:
          "The reasoning context carries no claim→evidence→source data, so whether FACT sentences reach a source cannot be established. Reported as UNKNOWN rather than PASS: the chain is unproven, not verified.",
        subjectIds: [],
      })
      diagnose(
        "traceability",
        "warning",
        "No claim trace edges in the context: traceability is unverified, not confirmed. Re-run the reasoning context to record the chain.",
        [],
      )
    } else {
      findings.checks.push({
        id: "TRACEABILITY",
        status: "PASS",
        detail: chainKnown
          ? "All provenance references resolve; every FACT claim has a complete evidence-to-source chain."
          : "No FACT statement is made, so there is no claim→evidence→source chain to verify.",
        subjectIds: [],
      })
    }
  }

  // -- 3. UNSUPPORTED_STATEMENTS ---------------------------------------------
  {
    const offenders: string[] = []
    for (const sentence of sentences) {
      if (sentence.knowledge === "FICTION") continue
      const referenced = sentence.claimIds
        .map((id) => claimById.get(id))
        .filter((claim): claim is NonNullable<typeof claim> => claim !== undefined)
      if (referenced.length === 0) continue
      if (referenced.every((claim) => claim.status === "UNSUPPORTED")) offenders.push(sentence.id)
    }
    if (offenders.length > 0) {
      findings.checks.push({
        id: "UNSUPPORTED_STATEMENTS",
        status: "FAIL",
        detail: `${offenders.length} sentence(s) rest only on UNSUPPORTED claims: ${offenders.join(", ")}.`,
        subjectIds: offenders,
      })
      diagnose(
        "unsupported-statement",
        "critical",
        `Sentences based exclusively on unsupported claims: ${offenders.join(", ")}.`,
        offenders,
      )
    } else {
      findings.checks.push({
        id: "UNSUPPORTED_STATEMENTS",
        status: "PASS",
        detail: "No narrative sentence rests exclusively on unsupported claims.",
        subjectIds: [],
      })
    }
  }

  // -- 4. UNCERTAINTY_PRESERVATION -------------------------------------------
  {
    // v0.7 (M1) — coverage is per SUBJECT. The previous check asked only
    // "does any sentence carry a hedged label?", so one unrelated hedge
    // satisfied every recorded uncertainty. Each uncertainty is now checked
    // against the sentences that actually reference its subject.
    const inflated: string[] = []
    for (const sentence of sentences) {
      if (sentence.knowledge === "FICTION" || sentence.knowledge !== "FACT") continue
      const touchesQualified = sentence.claimIds.some(
        (id) => claimById.get(id)?.requiresQualification,
      )
      if (touchesQualified) inflated.push(sentence.id)
    }
    const coverage = uncertaintyCoverage(context, narrative)

    if (inflated.length > 0) {
      findings.checks.push({
        id: "UNCERTAINTY_PRESERVATION",
        status: "FAIL",
        detail: `${inflated.length} sentence(s) present qualified claims as FACT: ${inflated.join(", ")}.`,
        subjectIds: inflated,
      })
      diagnose(
        "uncertainty-loss",
        "critical",
        `Qualified claims were narrated as established fact: ${inflated.join(", ")}.`,
        inflated,
      )
    } else if (context.uncertainties.length === 0) {
      findings.checks.push({
        id: "UNCERTAINTY_PRESERVATION",
        status: "UNKNOWN",
        unknownReason: "not-applicable",
        detail: "The context records no uncertainties, so nothing could be lost.",
        subjectIds: [],
      })
    } else if (coverage.uncovered.length > 0) {
      const detail =
        `The narrative does not acknowledge ${coverage.uncovered.length} of ` +
        `${context.uncertainties.length} recorded uncertainty/uncertainties: ${coverage.uncovered.join(", ")}.`
      findings.checks.push({
        id: "UNCERTAINTY_PRESERVATION",
        status: coverage.covered.length > 0 || !coverage.unrelatedHedge ? "WARN" : "FAIL",
        detail: coverage.unrelatedHedge
          ? `${detail} The only hedge(s) present do not reference any recorded subject.`
          : detail,
        subjectIds: coverage.uncovered,
      })
      diagnose(
        "uncertainty-loss",
        coverage.covered.length > 0 || !coverage.unrelatedHedge ? "warning" : "critical",
        coverage.unrelatedHedge
          ? `Hedges exist but none acknowledges the recorded uncertainty subject(s): ${coverage.uncovered.join(", ")}.`
          : `Unrecorded uncertainty subject(s) are not acknowledged: ${coverage.uncovered.join(", ")}.`,
        coverage.uncovered,
      )
    } else if (coverage.unverifiable.length > 0) {
      findings.checks.push({
        id: "UNCERTAINTY_PRESERVATION",
        status: "UNKNOWN",
        unknownReason: "unverifiable",
        detail:
          "Global research uncertainties cannot be verified from claim references or an unrelated hedge.",
        subjectIds: coverage.unverifiable,
      })
    } else {
      findings.checks.push({
        id: "UNCERTAINTY_PRESERVATION",
        status: "PASS",
        detail: `All ${coverage.covered.length} recorded uncertainty/uncertainties are acknowledged by a hedge on the same subject.`,
        subjectIds: [],
      })
    }
  }

  // -- 5. CONTRADICTION_PRESERVATION -----------------------------------------
  {
    const suppressed: string[] = []
    const detail: string[] = []
    for (const constraint of context.constraints) {
      if (constraint.kind !== "DO_NOT_RESOLVE_CONTRADICTION") continue
      // A contradiction constraint carries [contradictionId, claimA, claimB];
      // the pair to check is the two claims, not the id and the first claim.
      const [contradictionId, claimA, claimB] = constraint.subjectIds
      if (!contradictionId || !claimA || !claimB) continue
      const mentions = (id: string) =>
        sentences.some(
          (sentence) => sentence.claimIds.includes(id) && sentence.knowledge !== "FICTION",
        )
      if (!mentions(claimA) || !mentions(claimB)) {
        suppressed.push(contradictionId)
        detail.push(`${contradictionId} (${claimA} vs ${claimB})`)
      }
    }
    if (suppressed.length > 0) {
      findings.checks.push({
        id: "CONTRADICTION_PRESERVATION",
        status: "FAIL",
        detail: `Contradiction(s) with only one side in the narrative: ${detail.join("; ")}.`,
        subjectIds: suppressed,
      })
      diagnose(
        "contradiction-suppression",
        "critical",
        `Unresolved contradictions are not presented on both sides: ${detail.join("; ")}.`,
        suppressed,
      )
    } else {
      const count = context.constraints.filter(
        (c) => c.kind === "DO_NOT_RESOLVE_CONTRADICTION",
      ).length
      findings.checks.push({
        id: "CONTRADICTION_PRESERVATION",
        status: "UNKNOWN",
        unknownReason: count === 0 ? "not-applicable" : "unverifiable",
        detail:
          count === 0
            ? "The context records no unresolved contradictions."
            : `Both sides of ${count} contradiction(s) are referenced, but this does not prove the prose preserves their unresolved status.`,
        subjectIds: [],
      })
    }
  }

  // -- 6. HYPOTHESIS_INTEGRITY ----------------------------------------------
  {
    // A hypothesis may not be narrated AS a hypothesis. Merely citing a claim
    // that a hypothesis leans on is NOT inflation — the established finding
    // stays established — so the test is whether the sentence restates the
    // hypothesis itself (v0.7: matched against `statement` only).
    const inflated: string[] = []
    const ambiguous: { sentenceId: string; hypothesisIds: string[] }[] = []
    for (const sentence of sentences) {
      if (sentence.knowledge !== "FACT") continue
      const { asserted, ambiguous: resembles } = assertedHypotheses(
        sentence.text,
        sentence.claimIds,
        context,
      )
      if (asserted.length > 0) inflated.push(sentence.id)
      if (resembles.length > 0)
        ambiguous.push({ sentenceId: sentence.id, hypothesisIds: resembles })
    }
    void hypothesisById
    const dropped = context.activeHypotheses
      .filter(
        (h) =>
          (h.status === "REJECTED" || h.status === "SUPERSEDED") &&
          sentences.some(
            (sentence) =>
              sentence.knowledge === "FACT" && assertsHypothesis(sentence.text, h.statement),
          ),
      )
      .map((h) => h.hypothesisId)

    if (inflated.length > 0 || dropped.length > 0) {
      const subjects = [...new Set([...inflated, ...dropped])]
      findings.checks.push({
        id: "HYPOTHESIS_INTEGRITY",
        status: "FAIL",
        detail: `Hypotheses presented as established fact: ${subjects.join(", ")}.`,
        subjectIds: subjects,
      })
      diagnose(
        "hypothesis-inflation",
        "critical",
        `Hypothesis statements were narrated as fact: ${subjects.join(", ")}.`,
        subjects,
      )
    } else if (ambiguous.length > 0) {
      // A lexical detector cannot prove the ABSENCE of semantic inflation, so a
      // sentence that merely RESEMBLES an unverified hypothesis is not a clean
      // pass. It is reported as UNKNOWN — neither proven inflated nor proven
      // safe — and routed as a diagnostic for review. This is deliberately not
      // a FAIL: the band is exactly the uncertainty the threshold cannot settle.
      const subjects = [...new Set(ambiguous.flatMap((a) => a.hypothesisIds))]
      const sentencesInBand = ambiguous.map((a) => a.sentenceId)
      findings.checks.push({
        id: "HYPOTHESIS_INTEGRITY",
        status: "UNKNOWN",
        unknownReason: "unverifiable",
        detail:
          `Hypothesis resemblance is near the assertion threshold and cannot be ` +
          `settled lexically (sentences: ${sentencesInBand.join(", ")}; ` +
          `hypotheses: ${subjects.join(", ")}).`,
        subjectIds: subjects,
      })
      diagnose(
        "hypothesis-inflation-ambiguous",
        "warning",
        `Sentences resemble an unverified hypothesis without clearing the assertion ` +
          `threshold: ${sentencesInBand.join(", ")}.`,
        subjects,
      )
    } else {
      findings.checks.push({
        id: "HYPOTHESIS_INTEGRITY",
        status: "PASS",
        detail: "No active hypothesis is restated as an established fact.",
        subjectIds: [],
      })
    }
  }

  // -- 7. SCOPE_COMPLIANCE ----------------------------------------------------
  {
    const forbidden = new Set(protectedKeys())
    const offenders: string[] = []
    for (const write of input.writes ?? []) {
      for (const key of write.keys) {
        if (forbidden.has(key)) offenders.push(`${write.artifact}:${key}`)
      }
    }
    if (offenders.length > 0) {
      findings.checks.push({
        id: "SCOPE_COMPLIANCE",
        status: "FAIL",
        detail: `Production wrote outside its scope: ${offenders.join(", ")}.`,
        subjectIds: offenders,
      })
      diagnose(
        "scope-violation",
        "critical",
        `Production attempted to write protected keys: ${offenders.join(", ")}.`,
        offenders,
      )
    } else {
      const recorded = (input.writes ?? []).flatMap((w) => w.keys)
      findings.checks.push({
        id: "SCOPE_COMPLIANCE",
        status: recorded.length === 0 ? "UNKNOWN" : "PASS",
        // The write-scope boundary is the whole point of the one-way handoff, so
        // "nobody recorded any writes" is absence of proof about a relevant
        // constraint — not a vacuous one.
        ...(recorded.length === 0 ? { unknownReason: "unverifiable" as const } : {}),
        detail:
          recorded.length === 0
            ? "No production writes were recorded, so scope compliance could not be observed."
            : `All production writes stayed inside the production scope: ${[...new Set(recorded)].join(", ")}.`,
        subjectIds: [],
      })
    }
  }

  const order = new Map<ProductionCheckId, number>(
    PRODUCTION_CHECK_IDS.map((id, index) => [id, index]),
  )
  findings.checks.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

  return {
    inputSignature: context.inputSignature,
    contextSignature: context.contextSignature,
    reasoningCycleId: context.reasoningCycleId,
    verdict: verdictOf(findings.checks),
    checks: findings.checks,
    diagnostics: findings.diagnostics,
    epistemicMutation: false,
    // v0.7 (H3) — the audit records what it actually read, so a later
    // inspection can tell whether the audited inputs are still the current ones.
    dependencies: [
      { artifact: "reasoningContext", contentSignature: artifactContentSignature(context) },
      { artifact: "narrative", contentSignature: artifactContentSignature(narrative) },
      { artifact: "visual", contentSignature: artifactContentSignature(visual) },
    ],
  }
}

/** Constraint ids a production artifact may advertise as satisfied. */
export function satisfiedConstraintIds(
  context: ReasoningContext,
  artifact: "narrative" | "visual",
  provenance: ProductionProvenance | null | undefined,
): string[] {
  if (!provenance) return []
  const violated = new Set(provenance.violations.map((v) => v.kind))
  return context.constraints
    .filter((c) => (artifact === "narrative" ? true : c.kind !== "NO_DEFINITIVE_CONCLUSION"))
    .filter((c) => provenance.satisfiedConstraints.includes(c.id))
    .filter((c) => !violated.has(c.kind))
    .map((c) => c.id)
}

export function shotsOf(visual: VisualOutput): Shot[] {
  return visual.shots
}

export function findProductionConstraint(
  context: ReasoningContext,
  kind: Parameters<typeof findConstraint>[1],
  subjectId?: string,
) {
  return findConstraint(context.constraints, kind, subjectId)
}
