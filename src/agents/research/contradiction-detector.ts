import type {
  Claim,
  Contradiction,
  ContradictionKind,
  ContradictionSeverity,
} from "../../core/schemas.js"
import { CONTRADICTION_PREFIX, makeId } from "./ids.js"

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "with",
  "for",
  "from",
  "that",
  "this",
  "these",
  "those",
  "are",
  "was",
  "were",
  "is",
  "be",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "of",
  "in",
  "on",
  "at",
  "to",
  "by",
  "as",
  "it",
  "its",
  "which",
  "who",
  "whom",
  "not",
  "no",
  "never",
  "may",
  "might",
  "could",
  "would",
  "can",
  "will",
  "should",
  "into",
  "between",
  "than",
  "more",
  "most",
  "also",
  "however",
  "although",
  "because",
  "due",
])

const NEGATION =
  /\b(no|not|never|isn'?t|doesn'?t|don'?t|without|excluding|no measurable|lack of|none)\b/i
const UNCERTAINTY =
  /\b(may|might|could|possibly|perhaps|uncertain|unclear|unknown|probably|maybe|potentially|suggest)\w*\b/i
const TIME_PERIOD =
  /\b((?:19|20)\d{2}s?|recent decades|ancient era|hundreds of thousands of years)\b/i
const POPULATION =
  /\b(non-africans?|africans?|europeans?|asians?|modern humans?|neanderthals?|denisovans?|women|men|mice|humans)\b/i
const METHODOLOGY =
  /\b(genome sequencing|meta-analysis|survey|model|datasets?|measurement|observed|experiments?|statistical)\b/i
const DEFINITION =
  /\b(definition|define|concept|classified|characterized|criterion|criteria|as a species)\b/i

interface AnalyzedClaim {
  claim: Claim
  tokens: Set<string>
  negated: boolean
  uncertain: boolean
  population?: string
  period?: string
  methodology?: string
  definition?: string
}

export function analyzeClaim(claim: Claim): AnalyzedClaim {
  const text = claim.statement
  const tokens = tokenize(text)
  const population = matchText(POPULATION, text)
  const period = matchText(TIME_PERIOD, text)
  return {
    claim,
    tokens,
    negated: NEGATION.test(text),
    uncertain: UNCERTAINTY.test(text),
    population,
    period,
    methodology: METHODOLOGY.test(text) ? "methodology-present" : undefined,
    definition: DEFINITION.test(text) ? "definition-present" : undefined,
  }
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOPWORDS.has(word)) continue
    tokens.add(word)
  }
  return tokens
}

function matchText(pattern: RegExp, text: string): string | undefined {
  const m = text.match(pattern)
  return m ? (m[1] ?? m[0]) : undefined
}

function severityFor(confidence: number): ContradictionSeverity {
  if (confidence >= 0.65) return "HIGH"
  if (confidence >= 0.4) return "MEDIUM"
  return "LOW"
}

/**
 * Deterministic contradiction detector. It must NOT treat every disagreement as
 * a logical contradiction: it distinguishes contradiction, uncertainty and
 * differences in population, time period, methodology or definition.
 */
export function detectContradictions(claims: Claim[]): Contradiction[] {
  const analyzed = claims.map(analyzeClaim)
  const contradictions: Contradiction[] = []
  let counter = 0
  for (let i = 0; i < analyzed.length; i += 1) {
    for (let j = i + 1; j < analyzed.length; j += 1) {
      const a = analyzed[i]!
      const b = analyzed[j]!
      const overlap = [...a.tokens].filter((t) => b.tokens.has(t))
      if (overlap.length === 0) continue

      const result = classify(a, b)
      if (!result) continue

      counter += 1
      contradictions.push({
        id: makeId(CONTRADICTION_PREFIX, counter),
        claimA: a.claim.id,
        claimB: b.claim.id,
        severity: result.severity,
        classification: result.kind,
        explanation: result.explanation,
      })
    }
  }
  return contradictions
}

function classify(
  a: AnalyzedClaim,
  b: AnalyzedClaim,
): { kind: ContradictionKind; severity: ContradictionSeverity; explanation: string } | null {
  const avg = (a.claim.confidence + b.claim.confidence) / 2

  if (a.population && b.population && a.population !== b.population) {
    return {
      kind: "DIFFERENT_POPULATION",
      severity: "LOW",
      explanation: `Claims concern different populations ("${a.population}" vs "${b.population}").`,
    }
  }
  if (a.period && b.period && a.period !== b.period) {
    return {
      kind: "DIFFERENT_TIME_PERIOD",
      severity: "LOW",
      explanation: `Claims refer to different time periods ("${a.period}" vs "${b.period}").`,
    }
  }
  if (a.definition && b.definition) {
    return {
      kind: "DIFFERENT_DEFINITION",
      severity: "LOW",
      explanation: "Claims rely on different definitions or conceptual criteria.",
    }
  }
  if (a.methodology && b.methodology) {
    return {
      kind: "DIFFERENT_METHODOLOGY",
      severity: "LOW",
      explanation: "Claims were established with different methodologies.",
    }
  }

  const polarityMismatch = a.negated !== b.negated
  if (!polarityMismatch) return null

  if (a.uncertain || b.uncertain) {
    return {
      kind: "UNCERTAINTY",
      severity: "LOW",
      explanation: "At least one claim is hedged; the apparent conflict is unresolved uncertainty.",
    }
  }

  return {
    kind: "CONTRADICTION",
    severity: severityFor(avg),
    explanation: `Claims ${a.claim.id} and ${b.claim.id} assert incompatible conclusions.`,
  }
}
