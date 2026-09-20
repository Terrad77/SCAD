import type {
  Claim,
  Contradiction,
  Evidence,
  ResearchGap,
  ResearchPlan,
} from "../../core/schemas.js"
import { clamp } from "../../core/evidence/confidence.js"
import { GAP_PREFIX, makeId } from "./ids.js"

export interface ResearchGapInput {
  plan: ResearchPlan
  claims: Claim[]
  evidence: Evidence[]
  contradictions: Contradiction[]
}

/**
 * Deterministic research-gap detector. Gaps feed back into the research
 * planner as follow-up queries (Section 17-18 of the spec).
 */
export function detectResearchGaps(input: ResearchGapInput): ResearchGap[] {
  const gaps: ResearchGap[] = []
  const seen = new Set<string>()
  let counter = 0

  const push = (gap: Omit<ResearchGap, "id">) => {
    const key = gap.question.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    counter += 1
    gaps.push({ ...gap, id: makeId(GAP_PREFIX, counter) })
  }

  // Unresolved high-severity contradictions.
  for (const contradiction of input.contradictions) {
    if (contradiction.severity !== "HIGH") continue
    push({
      question: `Conflicting evidence between claims ${contradiction.claimA} and ${contradiction.claimB}.`,
      importance: 0.9,
      relatedClaims: [contradiction.claimA, contradiction.claimB],
      suggestedResearchQueries: [
        `Find evidence that adjudicates the conflict between "${contradiction.claimA}" and "${contradiction.claimB}"`,
        `Independent study that resolves: ${contradiction.explanation}`,
      ],
    })
  }

  // Low-confidence hypotheses and speculation need verification.
  for (const claim of input.claims) {
    if (claim.confidence >= 0.5) continue
    if (claim.knowledge === "FACT") continue
    push({
      question: `Verification needed for: ${claim.statement}`,
      importance: clamp(1 - claim.confidence),
      relatedClaims: [claim.id],
      suggestedResearchQueries: [
        `Search for direct evidence about: ${claim.statement}`,
        `Peer-reviewed verification of: ${claim.statement}`,
      ],
    })
  }

  // Single-source claims need corroboration.
  for (const claim of input.claims) {
    if (claim.sources.length > 1) continue
    push({
      question: `Single-source claim needs corroboration: ${claim.statement}`,
      importance: 0.6,
      relatedClaims: [claim.id],
      suggestedResearchQueries: [
        `Corroborating sources for: ${claim.statement}`,
        `Independent confirmation of: ${claim.statement}`,
      ],
    })
  }

  // Sub-questions with no gathered evidence.
  const covered = new Set<string>()
  for (const evidence of input.evidence) {
    for (const claimId of evidence.supportsClaims) {
      const claim = input.claims.find((c) => c.id === claimId)
      if (!claim) continue
      for (const subId of claim.subquestionIds ?? []) covered.add(subId)
    }
    for (const subId of evidenceForSubquestions(evidence, input.claims)) covered.add(subId)
  }
  for (const sub of input.plan.subQuestions) {
    if (covered.has(sub.id)) continue
    push({
      question: `No evidence gathered for sub-question: ${sub.text}`,
      importance: 0.7,
      relatedClaims: [],
      suggestedResearchQueries: [sub.text, `${sub.text} direct evidence`],
      subquestionId: sub.id,
    })
  }

  return gaps
}

function evidenceForSubquestions(evidence: Evidence, claims: Claim[]): string[] {
  const subIds = new Set<string>()
  for (const claimId of evidence.supportsClaims) {
    const claim = claims.find((c) => c.id === claimId)
    if (!claim) continue
    for (const subId of claim.subquestionIds ?? []) subIds.add(subId)
  }
  return [...subIds]
}
