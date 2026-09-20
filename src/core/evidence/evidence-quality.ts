import type { Evidence, EvidenceQuality, Source } from "../schemas.js"
import { clamp } from "./confidence.js"
import {
  DEFAULT_EVIDENCE_DIRECTNESS,
  DEFAULT_SOURCE_RELIABILITY,
  EVIDENCE_QUALITY_WEIGHTS,
  FRESHNESS_BY_YEARS,
  FRESHNESS_UNKNOWN_SCORE,
  SOURCE_RELIABILITY_BY_TYPE,
} from "./weights.js"

/**
 * Deterministic Evidence Quality assessment (v0.4).
 *
 * Every evidence item gets an explainable quality score from five dimensions:
 * reliability (of its source), strength (of the statement), directness (how
 * directly it asserts), specificity (how precise it is) and freshness (how
 * recent the source is). The weighted overall score is a heuristic for review
 * purposes — never an objective measure of truth.
 */

export interface EvidenceQualityInput {
  evidence: Pick<Evidence, "id" | "sourceId" | "statement" | "excerpt">
  /** Source backing this evidence. Missing attributes degrade gracefully. */
  source?: Pick<Source, "id" | "type" | "reliability" | "publishedAt" | "title" | "publisher">
  /** ISO date used as the "now" for freshness (defaults to run time). */
  referenceDate?: string
}

const HEDGES =
  /\b(may|might|could|possibly|perhaps|uncertain|unclear|unknown|probably|maybe|potentially|suggest|appears?|seems?|reportedly)\b/i
const DEFINITIVE =
  /\b(always|never|proven?|demonstrated?|confirmed?|established|is|are|shows?|reveals?)\b/i

function reliabilityOf(input: EvidenceQualityInput): { score: number; note: string } {
  const source = input.source
  if (source?.reliability !== undefined) {
    return {
      score: clamp(source.reliability),
      note: `source reliability ${clamp(source.reliability).toFixed(2)}`,
    }
  }
  if (source?.type) {
    const base = SOURCE_RELIABILITY_BY_TYPE[source.type]
    return { score: base, note: `type-based reliability ${base.toFixed(2)} (${source.type})` }
  }
  return {
    score: DEFAULT_SOURCE_RELIABILITY,
    note: `reliability default ${DEFAULT_SOURCE_RELIABILITY.toFixed(2)} (no source data)`,
  }
}

function strengthOf(statement: string): { score: number; note: string } {
  if (HEDGES.test(statement) && !DEFINITIVE.test(statement)) {
    return { score: 0.4, note: `strength 0.40 (hedged: "${statement.match(HEDGES)?.[0]}")` }
  }
  if (DEFINITIVE.test(statement)) {
    return { score: 0.85, note: "strength 0.85 (definitive assertion language)" }
  }
  return { score: 0.6, note: "strength 0.60 (neutral assertion, no hedge)" }
}

function directnessOf(input: EvidenceQualityInput): { score: number; note: string } {
  // The deterministic fallback marks evidence derived from title+snippet.
  if (input.evidence.statement.startsWith('From "')) {
    return {
      score: clamp(DEFAULT_EVIDENCE_DIRECTNESS - 0.5),
      note: "directness 0.30 (evidence derived from title/snippet fallback)",
    }
  }
  let score = DEFAULT_EVIDENCE_DIRECTNESS
  const notes = [`directness ${score.toFixed(2)} (base)`]
  if (input.evidence.excerpt && input.evidence.excerpt.length > 0) {
    score += 0.1
    notes.push("+0.10 excerpt present")
  }
  if (input.evidence.statement.length < 30) {
    score -= 0.1
    notes.push("-0.10 very short statement")
  }
  return { score: clamp(score), note: notes.join("; ") }
}

function specificityOf(statement: string): { score: number; note: string } {
  const measures = (statement.match(/\d+(?:\.\d+)?\s*%?/g) ?? []).length
  const properNouns = (statement.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).length
  let score = 0.5
  if (measures >= 2) score = 1
  else if (measures === 1) score = 0.75
  if (properNouns >= 2) score = clamp(score + 0.15)
  return {
    score,
    note: `specificity ${score.toFixed(2)} (${measures} numeric measure${measures === 1 ? "" : "s"}, ${properNouns} named entities)`,
  }
}

function freshnessOf(input: EvidenceQualityInput): { score: number; note: string } {
  const publishedAt = input.source?.publishedAt
  if (!publishedAt) {
    return {
      score: FRESHNESS_UNKNOWN_SCORE,
      note: `freshness ${FRESHNESS_UNKNOWN_SCORE.toFixed(2)} (no publication date)`,
    }
  }
  const published = Date.parse(publishedAt)
  if (Number.isNaN(published)) {
    return {
      score: FRESHNESS_UNKNOWN_SCORE,
      note: "freshness 0.50 (unparseable publication date)",
    }
  }
  const reference = input.referenceDate ? Date.parse(input.referenceDate) : Date.now()
  const ageMs = Math.max(0, (Number.isNaN(reference) ? Date.now() : reference) - published)
  const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000)
  for (const window of FRESHNESS_BY_YEARS) {
    if (ageYears <= window.years) {
      return {
        score: window.score,
        note: `freshness ${window.score.toFixed(2)} (< ${window.years} year${window.years === 1 ? "" : "s"} old)`,
      }
    }
  }
  return { score: 0.2, note: "freshness 0.20 (older than 20 years)" }
}

/**
 * Computes the full dimension set and weighted overall quality for one
 * evidence item. Every dimension is clamped to 0..1 and every score carries a
 * human-readable reason so the result is explainable.
 */
export function computeEvidenceQuality(input: EvidenceQualityInput): EvidenceQuality {
  const reliability = reliabilityOf(input)
  const strength = strengthOf(input.evidence.statement)
  const directness = directnessOf(input)
  const specificity = specificityOf(input.evidence.statement)
  const freshness = freshnessOf(input)

  const overall = clamp(
    reliability.score * EVIDENCE_QUALITY_WEIGHTS.reliability +
      strength.score * EVIDENCE_QUALITY_WEIGHTS.strength +
      directness.score * EVIDENCE_QUALITY_WEIGHTS.directness +
      specificity.score * EVIDENCE_QUALITY_WEIGHTS.specificity +
      freshness.score * EVIDENCE_QUALITY_WEIGHTS.freshness,
  )

  return {
    evidenceId: input.evidence.id,
    sourceId: input.evidence.sourceId,
    dimensions: {
      reliability: reliability.score,
      strength: strength.score,
      directness: directness.score,
      specificity: specificity.score,
      freshness: freshness.score,
    },
    overall,
    reasons: [
      reliability.note,
      strength.note,
      directness.note,
      specificity.note,
      freshness.note,
      `overall ${overall.toFixed(2)} (weighted ${EVIDENCE_QUALITY_WEIGHTS.reliability}+${EVIDENCE_QUALITY_WEIGHTS.strength}+${EVIDENCE_QUALITY_WEIGHTS.directness}+${EVIDENCE_QUALITY_WEIGHTS.specificity}+${EVIDENCE_QUALITY_WEIGHTS.freshness})`,
    ],
  }
}
