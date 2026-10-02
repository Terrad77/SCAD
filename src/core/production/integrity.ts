import type { KnowledgeLevel, VisualType } from "../types.js"
import { VISUAL_TYPES } from "../types.js"
import { claimBlockingReason } from "./constraints.js"
import type { ContextClaimView, ProductionConstraint, ReasoningContext } from "./types.js"

/**
 * v0.7 — the deterministic epistemic integrity rules shared by the production
 * guards (`guards.ts`) and the SelfCheck production audit
 * (`self-check-rules.ts`).
 *
 * These are the machine-checkable form of the v0.7 invariants:
 *   I2  narrative cannot become evidence      → knowledge ceilings
 *   I3  visual cannot become evidence          → epistemic visual posture
 *   I6  hypothesis status cannot inflate       → hypothesis ceiling
 *   I12 uncertainty cannot disappear           → nothing here removes content
 *   I13 contradictions cannot disappear        → nothing here resolves a side
 *
 * The guards only ever DOWNGRADE a label or detach an unbacked provenance
 * reference. They never add, delete or rewrite narrative text, so uncertainty
 * and contradiction can not be silently dropped by production.
 */

/**
 * Assertiveness order: a lower rank is a stronger claim. A label may be
 * weakened to a higher rank, never the other way round.
 */
export const ASSERTIVENESS_RANK: Record<KnowledgeLevel, number> = {
  FACT: 0,
  SCIENTIFIC_HYPOTHESIS: 1,
  INTERPRETATION: 2,
  SPECULATION: 3,
  FICTION: 4,
}

export const KNOWLEDGE_BY_RANK: KnowledgeLevel[] = [
  "FACT",
  "SCIENTIFIC_HYPOTHESIS",
  "INTERPRETATION",
  "SPECULATION",
  "FICTION",
]

export function rankOfKnowledge(level: KnowledgeLevel): number {
  return ASSERTIVENESS_RANK[level]
}

export function knowledgeAtLeastAsAssertive(a: KnowledgeLevel, b: KnowledgeLevel): boolean {
  return ASSERTIVENESS_RANK[a] <= ASSERTIVENESS_RANK[b]
}

/** The level an unsupported/qualified claim may be narrated at. */
const QUALIFIED_CLAIM_CEILING: KnowledgeLevel = "SCIENTIFIC_HYPOTHESIS"
const UNSUPPORTED_CLAIM_CEILING: KnowledgeLevel = "SPECULATION"
/** A sentence with no resolvable claim reference is narration, not fact. */
const UNTRACEABLE_CEILING: KnowledgeLevel = "INTERPRETATION"

export interface KnowledgeCeiling {
  level: KnowledgeLevel
  reason: string
  /** Claim ids that forced the ceiling (empty for the untraceable case). */
  subjectIds: string[]
}

/**
 * v0.7 (H4) — the ceiling a SINGLE non-usable claim permits.
 *
 * The previous implementation mapped every qualified claim to a flat
 * `SCIENTIFIC_HYPOTHESIS`, which meant a claim the epistemic side had labelled
 * `SPECULATION` could be narrated *more assertively* than it was recorded —
 * an inflation performed by the very guard meant to prevent inflation. The
 * ceiling is now the claim's own `knowledge` level, which is by construction
 * never more assertive than what the epistemic state already asserts.
 */
function ceilingForClaim(claim: ContextClaimView): KnowledgeLevel {
  if (claim.status === "UNSUPPORTED") {
    return ASSERTIVENESS_RANK[claim.knowledge] > ASSERTIVENESS_RANK[UNSUPPORTED_CLAIM_CEILING]
      ? claim.knowledge
      : UNSUPPORTED_CLAIM_CEILING
  }
  if (claim.knowledge === "FACT") return QUALIFIED_CLAIM_CEILING
  // SPECULATION / INTERPRETATION / FICTION claims keep their own level.
  return claim.knowledge
}

/**
 * The most assertive knowledge level a sentence may legitimately carry, given
 * the reasoning context it was produced from.
 *
 *   • no resolvable claim reference        → INTERPRETATION
 *   • claim explicitly unsupported         → SPECULATION
 *   • qualified FACT claim                 → SCIENTIFIC_HYPOTHESIS
 *   • non-FACT claim                       → that claim's own level
 *   • the sentence paraphrases an active hypothesis → SCIENTIFIC_HYPOTHESIS
 *   • otherwise (clean, traceable facts)   → FACT
 *
 * Note what is deliberately NOT a rule: a claim that merely *backs* an active
 * hypothesis stays `FACT`. A well-established finding that some hypothesis
 * leans on is still established — demoting it would destroy the very
 * distinction between fact and speculation that the taxonomy exists to draw.
 * Hypothesis integrity is enforced where it belongs: on the sentences that
 * actually assert the hypothesis (see `assertsHypothesis`).
 */
export function knowledgeCeilingFor(
  claimIds: readonly string[],
  context: Pick<ReasoningContext, "claims" | "activeHypotheses">,
  text?: string,
): KnowledgeCeiling {
  const views = claimIds
    .map((id) => context.claims.find((claim) => claim.claimId === id))
    .filter((claim): claim is ContextClaimView => claim !== undefined)

  if (views.length === 0) {
    return {
      level: UNTRACEABLE_CEILING,
      reason: "no resolvable claim reference in the reasoning context",
      subjectIds: [],
    }
  }

  const asserted = assertedHypothesesFor(text, claimIds, context)

  let ceiling: KnowledgeLevel = "FACT"
  const forced = new Map<string, string>()
  for (const claim of views) {
    if (claim.status === "UNSUPPORTED") {
      forced.set(claim.claimId, `claim ${claim.claimId} is UNSUPPORTED`)
    } else if (claim.knowledge !== "FACT" || !claim.usable) {
      const why = claimBlockingReason(claim) ?? `claim ${claim.claimId} is not usable as fact`
      forced.set(claim.claimId, `claim ${claim.claimId}: ${why}`)
    }
    if (!forced.has(claim.claimId)) continue
    const next = ceilingForClaim(claim)
    if (ASSERTIVENESS_RANK[next] > ASSERTIVENESS_RANK[ceiling]) ceiling = next
  }

  if (
    asserted.length > 0 &&
    ASSERTIVENESS_RANK[QUALIFIED_CLAIM_CEILING] > ASSERTIVENESS_RANK[ceiling]
  ) {
    ceiling = QUALIFIED_CLAIM_CEILING
  }

  if (ceiling === "FACT") {
    return {
      level: "FACT",
      reason: "all referenced claims are traceable and established",
      subjectIds: [],
    }
  }
  const detail = [...forced.values()]
  if (asserted.length > 0) detail.push(`asserts unverified hypothesis ${asserted.join(", ")}`)
  return { level: ceiling, reason: detail.join("; "), subjectIds: [...forced.keys()] }
}

/**
 * The unverified hypotheses this sentence asserts, by id.
 *
 * v0.7 (H5) — the match is now made against the hypothesis STATEMENT alone, and
 * regardless of whether the sentence correctly cites the supporting claim. The
 * verification rationale is deliberately excluded: it is reasoning about the
 * hypothesis, not the hypothesis, and folding it in used to make a restatement
 * unmatchable (and a long echo of it matchable for the wrong reason). Omitting
 * or changing claim references must not bypass hypothesis integrity.
 */
export function assertedHypothesesFor(
  text: string | undefined,
  claimIds: readonly string[],
  context: Pick<ReasoningContext, "claims" | "activeHypotheses">,
): string[] {
  return assertedHypotheses(text, claimIds, context).asserted
}

export interface HypothesisAssertionResult {
  /** Unverified hypotheses this sentence asserts. */
  asserted: string[]
  /**
   * v0.7 (H5) — hypotheses this sentence merely *resembles*, below the
   * assertion threshold. The caller surfaces these as a diagnostic instead of
   * silently treating the label as verified.
   */
  ambiguous: string[]
}

export function assertedHypotheses(
  text: string | undefined,
  _claimIds: readonly string[],
  context: Pick<ReasoningContext, "claims" | "activeHypotheses">,
): HypothesisAssertionResult {
  if (text === undefined) return { asserted: [], ambiguous: [] }
  const candidates = context.activeHypotheses.filter(
    (hypothesis) => hypothesis.verificationStatus !== "SUPPORTED",
  )
  const asserted: string[] = []
  const ambiguous: string[] = []
  for (const hypothesis of candidates) {
    const match = matchHypothesis(text, hypothesis.statement)
    if (match === "asserted") asserted.push(hypothesis.hypothesisId)
    else if (match === "ambiguous") ambiguous.push(hypothesis.hypothesisId)
  }
  return { asserted: asserted.sort(), ambiguous: ambiguous.sort() }
}

// --- hypothesis assertion detection ---------------------------------------

/** Token overlap above which a sentence is treated as restating a hypothesis. */
export const HYPOTHESIS_ASSERTION_OVERLAP = 0.5

/**
 * v0.7 (H5) — the minimum length a quoted fragment must reach before it is
 * treated as an assertion.
 *
 * The test is CHARACTER length, not token count, and deliberately so. A quoted
 * fragment is verbatim by construction: every word came from the hypothesis, so
 * there is no fuzzy-similarity risk left to defend against. The only question is
 * whether the quotation is long enough to be about something specific. Common
 * short phrases ("is documented", "in the period") fall below it; a real
 * assertion does not. Token count was the wrong measure — "Neanderthal admixture
 * is documented" is three content words but plainly a specific claim, and a
 * token threshold silently let exactly the H5 case through.
 */
export const HYPOTHESIS_FRAGMENT_MIN_CHARS = 24

/**
 * The ambiguous band just below the assertion threshold.
 *
 * A lexical detector cannot prove the ABSENCE of semantic inflation, so this
 * band is deliberately not reported as a clean pass: the audit turns it into an
 * `UNKNOWN` check plus a diagnostic rather than asserting the artifact is fine.
 */
export const HYPOTHESIS_AMBIGUOUS_OVERLAP = 0.34

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "and",
  "or",
  "but",
  "that",
  "this",
  "it",
  "its",
  "as",
  "by",
  "from",
  "may",
  "might",
  "could",
  "would",
  "will",
  "can",
  "there",
  "their",
  "they",
  "we",
  "our",
  "which",
  "than",
  "then",
  "so",
  "if",
  "not",
  "no",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
])

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  )
}

/**
 * Deterministic lexical test: does this sentence restate the hypothesis?
 *
 * Four tiers, in decreasing confidence, because a single symmetric similarity
 * score got both extremes wrong:
 *
 *   1. VERBATIM — the sentence contains the hypothesis statement itself. A
 *      restatement is a restatement no matter how much extra prose surrounds
 *      it, so this is checked first and is deliberately not threshold-based.
 *   2. QUOTED FRAGMENT (v0.7, H5) — the reverse containment: the sentence IS a
 *      contiguous run of words from the hypothesis. This is the case the
 *      original detector missed, and it is the one that actually occurred: a
 *      hypothesis stated as `Claim. — Long caveat…` and narrated as `Claim.`
 *      is the very same assertion wearing a shorter hat. Only the
 *      containment direction was tested, so pulling the assertion out of a
 *      longer sentence evaded the check entirely.
 *   3. CONTAINMENT — every content word of the hypothesis appears in the
 *      sentence. Immune to verbosity: a long, carefully narrated version of the
 *      same assertion is still the same assertion, which a symmetric Jaccard
 *      score actively punished.
 *   4. OVERLAP — the original content-word Jaccard heuristic, kept as the fuzzy
 *      fallback so genuinely reworded assertions are still caught. Scores in the
 *      ambiguous band are reported as `ambiguous`, not as a clean negative: a
 *      lexical test cannot certify the absence of semantic inflation.
 *
 * No LLM, no heuristics beyond the thresholds, so the same artifact always
 * yields the same verdict.
 */
export function matchHypothesis(
  sentence: string,
  hypothesis: string,
): "asserted" | "ambiguous" | "distinct" {
  if (normalizeText(sentence) === "") return "distinct"
  const normalizedSentence = normalizeText(sentence)
  const normalizedHypothesis = normalizeText(hypothesis)
  if (normalizedHypothesis === "") return "distinct"

  if (normalizedSentence.includes(normalizedHypothesis)) return "asserted"

  const sentenceTokens = contentTokens(sentence)
  const hypothesisTokens = contentTokens(hypothesis)
  if (sentenceTokens.size === 0 || hypothesisTokens.size === 0) return "distinct"

  // Tier 2: a quoted fragment of the hypothesis, in either direction.
  if (
    normalizedSentence.length >= HYPOTHESIS_FRAGMENT_MIN_CHARS &&
    normalizedHypothesis.includes(normalizedSentence)
  ) {
    return "asserted"
  }

  // Tier 3: the hypothesis's every content word is present in the sentence.
  if ([...hypothesisTokens].every((token) => sentenceTokens.has(token))) return "asserted"

  let shared = 0
  for (const token of sentenceTokens) if (hypothesisTokens.has(token)) shared += 1
  const union = sentenceTokens.size + hypothesisTokens.size - shared
  const overlap = union > 0 ? shared / union : 0
  if (overlap >= HYPOTHESIS_ASSERTION_OVERLAP) return "asserted"
  return overlap >= HYPOTHESIS_AMBIGUOUS_OVERLAP ? "ambiguous" : "distinct"
}

export function assertsHypothesis(sentence: string, hypothesis: string): boolean {
  return matchHypothesis(sentence, hypothesis) === "asserted"
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** The label a sentence must carry after the guard has run. */
export function enforceKnowledgeCeiling(
  current: KnowledgeLevel,
  claimIds: readonly string[],
  context: Pick<ReasoningContext, "claims" | "activeHypotheses">,
  text?: string,
): { level: KnowledgeLevel; ceiling: KnowledgeCeiling; changed: boolean } {
  const ceiling = knowledgeCeilingFor(claimIds, context, text)
  // FICTION is an explicit authorial marker, never a factual assertion, and is
  // never re-labelled.
  if (current === "FICTION") {
    return { level: current, ceiling, changed: false }
  }
  const changed = ASSERTIVENESS_RANK[current] < ASSERTIVENESS_RANK[ceiling.level]
  return { level: changed ? ceiling.level : current, ceiling, changed }
}

// ---------------------------------------------------------------------------
// Visual posture (§9)
// ---------------------------------------------------------------------------

/**
 * Which `VISUAL_TYPES` may carry which epistemic posture. The taxonomy is the
 * existing visual domain vocabulary — no second classification is introduced.
 *
 * ARCHIVE / PUBLIC_DOMAIN / CREATIVE_COMMONS / STOCK / SCREEN_CAPTURE all read
 * as *documented footage*; presenting a hypothesis or speculation in that
 * register is exactly the failure mode v0.7 forbids. AI_RECONSTRUCTION marks a
 * deliberate depiction, ABSTRACT an explicitly non-literal one.
 */
export const PERMITTED_VISUAL_TYPES: Record<KnowledgeLevel, readonly VisualType[]> = {
  FACT: VISUAL_TYPES,
  SCIENTIFIC_HYPOTHESIS: ["AI_RECONSTRUCTION", "INFOGRAPHIC", "MAP", "ABSTRACT", "AI_GENERATED"],
  INTERPRETATION: ["ABSTRACT", "AI_GENERATED", "AI_RECONSTRUCTION"],
  SPECULATION: ["ABSTRACT", "AI_GENERATED"],
  FICTION: ["ABSTRACT", "AI_GENERATED", "AI_RECONSTRUCTION"],
}

export function isVisualTypePermitted(knowledge: KnowledgeLevel, visualType: VisualType): boolean {
  return PERMITTED_VISUAL_TYPES[knowledge].includes(visualType)
}

/** Deterministic fallback: the first permitted type in taxonomy order. */
export function visualTypeFallback(knowledge: KnowledgeLevel): VisualType {
  return PERMITTED_VISUAL_TYPES[knowledge][0]!
}

/** The weakest epistemic posture among a shot's narrative sentences. */
export function weakestPosture(levels: readonly KnowledgeLevel[]): KnowledgeLevel {
  let weakest: KnowledgeLevel = "FACT"
  for (const level of levels) {
    if (ASSERTIVENESS_RANK[level] > ASSERTIVENESS_RANK[weakest]) weakest = level
  }
  return weakest
}

/** The most assertive posture among a shot's narrative sentences. */
export function strongestPosture(levels: readonly KnowledgeLevel[]): KnowledgeLevel {
  let strongest: KnowledgeLevel = levels[0] ?? "FACT"
  for (const level of levels) {
    if (ASSERTIVENESS_RANK[level] < ASSERTIVENESS_RANK[strongest]) strongest = level
  }
  return strongest
}

export function constraintsOfKind(
  constraints: readonly ProductionConstraint[],
  kind: ProductionConstraint["kind"],
): ProductionConstraint[] {
  return constraints.filter((constraint) => constraint.kind === kind)
}
