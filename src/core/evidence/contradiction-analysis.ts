import type {
  Claim,
  Contradiction,
  ContradictionAnalysis,
  ContradictionAnalysisKind,
  ContradictionContext,
  Evidence,
  EvidenceQuality,
} from "../schemas.js"
import { clamp } from "./confidence.js"
import { STRONG_EVIDENCE_QUALITY } from "./weights.js"

/**
 * Contradiction Analysis 2.0 (v0.4).
 *
 * A detected conflict is resolved into its *likely context* before it is ever
 * called a genuine contradiction. The legacy detector already separates
 * population/time/methodology/definition differences; this layer adds
 * measurement and scope contexts and, for plain "CONTRADICTION" records,
 * decides between a genuine conflict and insufficient context. Everything is
 * deterministic and explainable; UNKNOWN is always a legal answer.
 */

const SCOPE_QUANTIFIERS = /\b(all|every|entire|whole|global|worldwide|always)\b/i
const SCOPE_LIMITERS =
  /\b(some|most|many|local|regional|partially|rarely|sometimes|in some cases)\b/i

function measurementValues(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?\s*%?/g) ?? []
}

function evidenceMean(
  claim: Claim,
  evidence: Evidence[],
  quality: Map<string, EvidenceQuality>,
): number {
  const ids = claim.evidenceIds ?? []
  if (ids.length === 0) return 0
  const scores = ids
    .map((id) => {
      const ev = evidence.find((e) => e.id === id)
      return ev ? (quality.get(id)?.overall ?? ev.confidence) : undefined
    })
    .filter((s): s is number => s !== undefined)
  if (scores.length === 0) return 0
  return scores.reduce((sum, s) => sum + s, 0) / scores.length
}

function contextFor(legacy: Contradiction["classification"]): {
  analysis: ContradictionAnalysisKind
  context?: ContradictionContext
} {
  switch (legacy) {
    case "DIFFERENT_POPULATION":
      return { analysis: "POPULATION_CONTEXT", context: { type: "population" } }
    case "DIFFERENT_TIME_PERIOD":
      return { analysis: "TIME_CONTEXT", context: { type: "time_period" } }
    case "DIFFERENT_METHODOLOGY":
      return { analysis: "METHODOLOGY_CONTEXT", context: { type: "methodology" } }
    case "DIFFERENT_DEFINITION":
      return { analysis: "DEFINITION_CONTEXT", context: { type: "definition" } }
    default:
      return { analysis: "UNKNOWN" }
  }
}

/**
 * Resolves one contradiction into the v0.4 taxonomy. Provided maps make it
 * reusable standalone and inside the intelligence engine alike.
 */
export function analyzeContradiction(input: {
  contradiction: Contradiction
  claims: Claim[]
  evidence: Evidence[]
  qualityByEvidence: Map<string, EvidenceQuality>
  claimQuality?: Map<string, number>
}): ContradictionAnalysis {
  const { contradiction: c } = input
  const claimA = input.claims.find((x) => x.id === c.claimA)
  const claimB = input.claims.find((x) => x.id === c.claimB)
  const textA = claimA?.statement ?? ""
  const textB = claimB?.statement ?? ""

  const explicit = contextFor(c.classification)
  const scoresA = claimA
    ? (input.claimQuality?.get(claimA.id) ??
      evidenceMean(claimA, input.evidence, input.qualityByEvidence))
    : 0
  const scoresB = claimB
    ? (input.claimQuality?.get(claimB.id) ??
      evidenceMean(claimB, input.evidence, input.qualityByEvidence))
    : 0
  const qualityA = clamp(scoresA)
  const qualityB = clamp(scoresB)

  let analysis = explicit.analysis as ContradictionAnalysisKind
  let context: ContradictionContext | undefined = explicit.context
  const reasons: string[] = [
    `legacy classification ${c.classification}; resolving context before branding it genuine`,
  ]

  // Measurement context: the claims quote different numbers.
  const measuresA = measurementValues(textA)
  const measuresB = measurementValues(textB)
  if (analysis === "UNKNOWN" && measuresA.length > 0 && measuresB.length > 0) {
    analysis = "MEASUREMENT_CONTEXT"
    context = { type: "measurement", detail: `${measuresA.join(", ")} vs ${measuresB.join(", ")}` }
    reasons.push(
      `claims quote different measures (${measuresA.join(", ")} vs ${measuresB.join(", ")})`,
    )
  }

  // Scope context: one claim asserts a total, the other a subset.
  if (analysis === "UNKNOWN" && SCOPE_QUANTIFIERS.test(textA) !== SCOPE_LIMITERS.test(textA)) {
    analysis = "SCOPE_CONTEXT"
    context = { type: "scope" }
    reasons.push("claims apply different scope (universal vs subset) language")
  }

  if (analysis === "UNKNOWN") {
    const hedged = /(may|might|could|possibly|perhaps|suggest|uncertain|unclear|probably)\b/i.test(
      textA + " " + textB,
    )
    if (hedged) {
      analysis = "UNKNOWN"
      reasons.push("at least one claim is hedged; conflict stays unresolved uncertainty")
    } else if (
      qualityA >= STRONG_EVIDENCE_QUALITY &&
      qualityB >= STRONG_EVIDENCE_QUALITY &&
      (claimA?.confidence ?? 0) >= 0.6 &&
      (claimB?.confidence ?? 0) >= 0.6
    ) {
      analysis = "GENUINE_CONTRADICTION"
      reasons.push(
        `both sides are strongly supported (${qualityA.toFixed(2)}, ${qualityB.toFixed(2)}) with confident claims; treating as genuine`,
      )
    } else {
      analysis = "INSUFFICIENT_CONTEXT"
      reasons.push(
        `supporting evidence quality (${qualityA.toFixed(2)}, ${qualityB.toFixed(2)}) is too weak to confirm a genuine conflict`,
      )
    }
  }

  const confidence = clamp(
    analysis === "GENUINE_CONTRADICTION"
      ? (qualityA + qualityB) / 2
      : analysis === "INSUFFICIENT_CONTEXT"
        ? 1 - (qualityA + qualityB) / 2
        : 0.6,
  )

  reasons.push(
    `evidence quality ${qualityA.toFixed(2)} (${c.claimA}) vs ${qualityB.toFixed(2)} (${c.claimB})`,
    `resolved as ${analysis} (heuristic confidence ${confidence.toFixed(2)})`,
  )

  return {
    contradictionId: c.id,
    claimA: c.claimA,
    claimB: c.claimB,
    severity: c.severity,
    classification: c.classification,
    analysis,
    ...(context ? { context } : {}),
    evidenceQualityA: qualityA,
    evidenceQualityB: qualityB,
    confidence,
    reasons,
  }
}

/** Resolves every contradiction in a research bundle into analyses. */
export function analyzeContradictions(
  contradictions: Contradiction[],
  claims: Claim[],
  evidence: Evidence[],
  qualityByEvidence: Map<string, EvidenceQuality>,
  claimQuality?: Map<string, number>,
): ContradictionAnalysis[] {
  return contradictions.map((contradiction) =>
    analyzeContradiction({
      contradiction,
      claims,
      evidence,
      qualityByEvidence,
      claimQuality,
    }),
  )
}
