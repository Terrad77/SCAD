import type { Narrative } from "../types.js"
import { assertedHypothesesFor, enforceKnowledgeCeiling } from "./integrity.js"
import type {
  ContextClaimTraceEdge,
  ProductionConstraint,
  ProductionViolation,
  ReasoningContext,
} from "./types.js"

/**
 * v0.7 — the coverage verifiers behind `TRACEABILITY` and
 * `UNCERTAINTY_PRESERVATION`.
 *
 * The review found both checks passing on artifacts that plainly did not
 * deserve it, because both counted ids instead of checking RELATIONSHIPS:
 *
 *   • a FACT sentence citing a known claim passed traceability even when the
 *     research bundle behind that claim had no evidence at all;
 *   • a single unrelated hedged sentence satisfied every recorded uncertainty.
 *
 * So coverage here is always asked as "is this subject actually addressed by
 * something that carries it?", never "does some id appear somewhere".
 */

export interface CoverageSentence {
  id: string
  text: string
  knowledge: Narrative["sections"][number]["sentences"][number]["knowledge"]
  claimIds: string[]
}

export function sentencesOf(narrative: Narrative): CoverageSentence[] {
  return narrative.sections.flatMap((section) => section.sentences)
}

// ---------------------------------------------------------------------------
// M2 — traceability over the real claim → evidence → source chain
// ---------------------------------------------------------------------------

export interface TraceabilityFinding {
  sentenceId: string
  claimIds: string[]
  /**
   * What is actually wrong. The distinction that matters is not cosmetic:
   * `dangling-evidence`, `dangling-source`, `empty-chain` and `unbacked-claim`
   * are DEMONSTRATED defects (something in the context points at something that
   * is not there, or at nothing at all) and are reported as FAIL. The chain being
   * absent altogether is not a defect we can demonstrate, and is reported as
   * UNKNOWN by the caller.
   */
  problem:
    | "no-claim-reference"
    | "unknown-claim"
    | "unbacked-claim"
    | "dangling-evidence"
    | "dangling-source"
    | "empty-chain"
  detail: string
}

/**
 * Whether the context carries the chain data needed to judge traceability.
 *
 * False for a v0.6 context (written before edges existed) and for one that was
 * truncated or hand-edited. Absence of evidence is not evidence of a defect, so
 * the caller must return UNKNOWN rather than PASS — but it must never invent a
 * FAIL it cannot demonstrate.
 */
export function chainDataAvailable(context: ReasoningContext): boolean {
  return claimTraceEdges(context).length > 0
}

/**
 * A FACT sentence must cite claims that (a) the context knows and (b) actually
 * resolve to evidence and sources. The second half is the fix for M2: before,
 * a claim id that existed but carried no evidence chain was enough to pass.
 *
 * Every id in an edge is checked to RESOLVE against the context's own evidence
 * and source ids, so an edge that names a non-existent evidence or source is a
 * demonstrated break, not a pass. A claim's epistemic status is deliberately
 * never consulted here: `FACT`/`SUPPORTED` is a judgement about what we believe,
 * and traceability is a separate question about whether the belief is reachable
 * to a source. Conflating the two would let a well-supported claim hide a broken
 * chain, or a broken chain be excused by a label.
 *
 * Returns one finding per problem so the diagnostic names the actual defect
 * instead of a generic "untraceable".
 */
export function traceabilityFindings(
  context: ReasoningContext,
  narrative: Narrative,
): TraceabilityFinding[] {
  const edgeList = claimTraceEdges(context)
  const edges = new Map(edgeList.map((edge) => [edge.claimId, edge]))
  const chainKnown = edgeList.length > 0
  const knownEvidence = new Set(context.traceRefs.evidenceIds)
  const knownSources = new Set(context.traceRefs.sourceIds)
  const findings: TraceabilityFinding[] = []
  for (const sentence of sentencesOf(narrative)) {
    if (sentence.knowledge !== "FACT") continue
    if (sentence.claimIds.length === 0) {
      findings.push({
        sentenceId: sentence.id,
        claimIds: [],
        problem: "no-claim-reference",
        detail: `Sentence ${sentence.id} is FACT but references no claim.`,
      })
      continue
    }
    const unknown = sentence.claimIds.filter((id) => !context.claims.some((c) => c.claimId === id))
    if (unknown.length > 0) {
      findings.push({
        sentenceId: sentence.id,
        claimIds: unknown,
        problem: "unknown-claim",
        detail: `Sentence ${sentence.id} references claims absent from the reasoning context: ${unknown.join(", ")}.`,
      })
      continue
    }
    if (!chainKnown) continue
    const unbacked = sentence.claimIds.filter((id) => {
      const edge = edges.get(id)
      // A claim with no recorded edge cannot be shown to reach a source.
      if (edge === undefined) return true
      if (!edge.supported) return true
      // An edge that claims support while naming no evidence, or no source,
      // does not reach a source either. Recorded ids must also RESOLVE: an
      // edge naming an evidence id the context does not carry is a dangling
      // reference, which is a demonstrated break rather than missing data.
      if (edge.evidenceIds.length === 0 || edge.sourceIds.length === 0) return true
      if (edge.evidenceIds.some((e) => !knownEvidence.has(e))) return true
      if (edge.sourceIds.some((s) => !knownSources.has(s))) return true
      return false
    })
    if (unbacked.length > 0) {
      const detail = unbacked
        .map((id) => {
          const edge = edges.get(id)
          if (edge === undefined) return `${id} (no evidence chain recorded in the context)`
          if (!edge.supported) return `${id} (recorded as unsupported)`
          if (edge.evidenceIds.length === 0) return `${id} (chain records no evidence)`
          if (edge.sourceIds.length === 0) return `${id} (chain records no source)`
          const danglingEvidence = edge.evidenceIds.filter((e) => !knownEvidence.has(e))
          if (danglingEvidence.length > 0) {
            return `${id} (evidence absent from the context: ${danglingEvidence.join(", ")})`
          }
          const danglingSources = edge.sourceIds.filter((s) => !knownSources.has(s))
          return `${id} (source absent from the context: ${danglingSources.join(", ")})`
        })
        .join("; ")
      findings.push({
        sentenceId: sentence.id,
        claimIds: unbacked,
        problem: "unbacked-claim",
        detail: `Sentence ${sentence.id} is FACT but its claims do not reach a source: ${detail}.`,
      })
    }
  }
  return findings
}

/** True when the edge genuinely connects a claim to at least one source. */
export function edgeIsBacked(edge: ContextClaimTraceEdge): boolean {
  return edge.supported && edge.evidenceIds.length > 0 && edge.sourceIds.length > 0
}

/**
 * The context's claim→evidence→source edges, tolerating a partial artifact.
 *
 * A persisted context may predate the edges (v0.7-rc), have been hand-edited, or
 * come from a resumed run mid-flight. Production degrades to "no edges" — which
 * makes FACT traceability UNKNOWN until the chain can be established —
 * rather than throwing and taking the whole stage down. An absent edge is a
 * missing fact, not a crash.
 */
export function claimTraceEdges(
  context: Pick<ReasoningContext, "traceRefs">,
): ContextClaimTraceEdge[] {
  const edges = (context.traceRefs as { claimTraceEdges?: unknown } | undefined)?.claimTraceEdges
  return Array.isArray(edges) ? (edges as ContextClaimTraceEdge[]) : []
}

// ---------------------------------------------------------------------------
// M1 — uncertainty coverage per subject, not in aggregate
// ---------------------------------------------------------------------------

export interface UncertaintyCoverage {
  /** Uncertainty ids acknowledged by a sentence that actually carries them. */
  covered: string[]
  /** Uncertainty ids no sentence genuinely addresses. */
  uncovered: string[]
  /** The narrative has no structured reference with which to prove coverage. */
  unverifiable: string[]
  /** True when a hedged sentence exists but bears no relationship to any subject. */
  unrelatedHedge: boolean
}

/**
 * Whether the narrative genuinely acknowledges each recorded uncertainty.
 *
 * An uncertainty names a SUBJECT (a claim, hypothesis, evidence item or the
 * research as a whole). A hedge acknowledges it only when the sentence
 * references that subject — directly for a claim, or by restating it for a
 * hypothesis. A hedged sentence that references nothing relevant is recorded
 * separately as `unrelatedHedge` so "somewhere in the film there is a hedge"
 * can never stand in for "this film's hedge is about the right thing".
 */
export function uncertaintyCoverage(
  context: ReasoningContext,
  narrative: Narrative,
): UncertaintyCoverage {
  const sentences = sentencesOf(narrative)
  const covered: string[] = []
  const uncovered: string[] = []
  const unverifiable: string[] = []
  let anyHedge = false
  let unrelatedHedge = false

  for (const uncertainty of context.uncertainties) {
    if (uncertainty.subjectType === "research") {
      unverifiable.push(uncertainty.uncertaintyId)
      continue
    }
    const relevant = sentences.filter((sentence) =>
      sentenceAddresses(sentence, uncertainty.subjectType, uncertainty.subjectId, context),
    )
    if (relevant.length === 0) {
      uncovered.push(uncertainty.uncertaintyId)
      continue
    }
    // The hedge must land on the subject, not merely exist somewhere.
    if (relevant.some((sentence) => isHedge(sentence.knowledge)))
      covered.push(uncertainty.uncertaintyId)
    else uncovered.push(uncertainty.uncertaintyId)
  }

  for (const sentence of sentences) {
    if (!isHedge(sentence.knowledge)) continue
    anyHedge = true
    const touchesAnySubject = context.uncertainties.some((uncertainty) =>
      sentenceAddresses(sentence, uncertainty.subjectType, uncertainty.subjectId, context),
    )
    if (!touchesAnySubject) unrelatedHedge = true
  }

  return { covered, uncovered, unverifiable, unrelatedHedge: anyHedge && unrelatedHedge }
}

function isHedge(knowledge: string): boolean {
  return (
    knowledge === "SCIENTIFIC_HYPOTHESIS" ||
    knowledge === "INTERPRETATION" ||
    knowledge === "SPECULATION"
  )
}

function sentenceAddresses(
  sentence: CoverageSentence,
  subjectType: "claim" | "hypothesis" | "evidence" | "research",
  subjectId: string,
  context: ReasoningContext,
): boolean {
  if (subjectType === "claim") {
    if (sentence.claimIds.includes(subjectId)) return true
    // A claim subject may also be addressed through the hypothesis that leans
    // on it, provided the sentence asserts that hypothesis and hedges it.
    const hypothesis = context.activeHypotheses.find((h) =>
      h.supportingClaimIds.includes(subjectId),
    )
    return (
      hypothesis !== undefined &&
      isHedge(sentence.knowledge) &&
      sentence.claimIds.includes(subjectId) === false &&
      assertedHypothesesFor(sentence.text, sentence.claimIds, context).includes(
        hypothesis.hypothesisId,
      )
    )
  }
  if (subjectType === "hypothesis") {
    if (!isHedge(sentence.knowledge)) return false
    const hypothesis = context.activeHypotheses.find((h) => h.hypothesisId === subjectId)
    if (hypothesis === undefined) return false
    return assertedHypothesesFor(sentence.text, sentence.claimIds, context).includes(subjectId)
  }
  if (subjectType === "evidence") {
    return (
      isHedge(sentence.knowledge) &&
      claimTraceEdges(context).some(
        (edge) => sentence.claimIds.includes(edge.claimId) && edge.evidenceIds.includes(subjectId),
      )
    )
  }
  // An arbitrary sentence without claim references proves no global coverage.
  return false
}

// ---------------------------------------------------------------------------
// H6 — violation postcondition verification
// ---------------------------------------------------------------------------

export interface PostconditionVerdict {
  /** v0.7 (H6) — the postcondition holds in the artifact as it stands. */
  holds: boolean
  detail: string
}

/**
 * v0.7 (H6) — independently re-derive a violation's postcondition.
 *
 * The guard's `resolved` flag is a claim, not evidence, and this function is
 * the independent check. It answers the only question that matters: does the
 * artifact AS PERSISTED now actually satisfy the constraint the violation was
 * recorded against?
 */
export function verifyViolationPostcondition(
  violation: ProductionViolation,
  context: ReasoningContext,
  narrative: Narrative,
): PostconditionVerdict {
  const sentences = sentencesOf(narrative).filter((sentence) =>
    violation.subjectIds.includes(sentence.id),
  )
  if (sentences.length === 0) {
    // The subject no longer exists in the artifact, so the constraint cannot
    // be broken here. Removal is not a resolution the guard performs, so the
    // violation is reported as unverified rather than quietly satisfied.
    return {
      holds: false,
      detail: `cannot verify: none of ${violation.subjectIds.join(", ")} are present in the persisted narrative.`,
    }
  }

  switch (violation.kind) {
    case "DO_NOT_PRESENT_AS_FACT":
    case "KEEP_TRACEABLE_TO_CLAIMS": {
      const stillOver = sentences.filter((sentence) => {
        if (violation.kind === "KEEP_TRACEABLE_TO_CLAIMS") {
          return traceabilityFindings(context, narrative).some((f) => f.sentenceId === sentence.id)
        }
        return enforceKnowledgeCeiling(
          sentence.knowledge,
          sentence.claimIds,
          context,
          sentence.text,
        ).changed
      })
      if (stillOver.length > 0) {
        return {
          holds: false,
          detail: `${stillOver.map((s) => s.id).join(", ")} still present the subject as FACT in the persisted artifact.`,
        }
      }
      return { holds: true, detail: "no sentence in the subject set still over-asserts." }
    }
    case "NO_DEFINITIVE_CONCLUSION": {
      // A violation the guard cannot fix without rewriting prose. The
      // postcondition is "no definitive-conclusion sentence remains".
      const offending = sentences.filter(
        (sentence) =>
          sentence.knowledge !== "FICTION" &&
          /^(conclusion|in conclusion|ultimately|definitively)\b/i.test(sentence.text),
      )
      return offending.length > 0
        ? {
            holds: false,
            detail: `${offending.map((s) => s.id).join(", ")} still read as a definitive conclusion.`,
          }
        : { holds: true, detail: "no definitive conclusion remains in the subject set." }
    }
    default: {
      // No machine-checkable postcondition is defined for this kind. UNKNOWN
      // rather than a hopeful PASS — an unverifiable critical constraint must
      // never be reported as satisfied.
      return {
        holds: false,
        detail: `no independent postcondition is defined for ${violation.kind}.`,
      }
    }
  }
}

/** Constraint kinds the audit is able to re-verify on its own. */
export const VERIFIABLE_VIOLATION_KINDS: ReadonlySet<ProductionConstraint["kind"]> = new Set([
  "DO_NOT_PRESENT_AS_FACT",
  "KEEP_TRACEABLE_TO_CLAIMS",
  "NO_DEFINITIVE_CONCLUSION",
])
