import { describe, it, expect } from "vitest"
import {
  computeResearchCompleteness,
  evaluateStoppingCriteria,
} from "../src/core/evidence/completeness.js"
import { computeEvidenceQuality } from "../src/core/evidence/evidence-quality.js"
import { analyzeSourceIndependence } from "../src/core/evidence/source-independence.js"
import { analyzeContradictions } from "../src/core/evidence/contradiction-analysis.js"
import type { ClaimConfidenceAssessment, ResearchIntelligenceReport } from "../src/core/schemas.js"
import { makeClaim, makeResearchBundle } from "./fixtures.js"

const THRESHOLDS = {
  COMPLETE: 0.85,
  MOSTLY_COMPLETE: 0.7,
  PARTIALLY_COMPLETE: 0.5,
  INSUFFICIENT: 0.3,
}

function completenessFor(bundle = makeResearchBundle()) {
  const qualityByEvidence = new Map(
    bundle.evidence.map((e) => {
      const src = bundle.sources.find((s) => s.id === e.sourceId)
      const q = computeEvidenceQuality({
        evidence: e,
        source: src ? { id: src.id, type: src.type, reliability: src.reliability } : undefined,
        referenceDate: "2026-01-01",
      })
      return [e.id, q]
    }),
  )
  const claimAssessments: ClaimConfidenceAssessment[] = bundle.claims.map((claim) => ({
    claimId: claim.id,
    status: "SUPPORTED",
    confidence: 0.7,
    supportStrength: 0.7,
    contradictionStrength: 0,
    independentSourceCount: 1,
    evidenceCount: (claim.evidenceIds ?? []).length,
    sourceCount: claim.sources.length,
    unresolvedGapCount: 0,
    completenessImpact: 0,
    reasons: ["test"],
  }))
  const contradictionsAnalysis = analyzeContradictions(
    bundle.contradictions,
    bundle.claims,
    bundle.evidence,
    qualityByEvidence,
  )
  return computeResearchCompleteness({
    plan: bundle.plan,
    claims: bundle.claims,
    evidence: bundle.evidence,
    sources: bundle.sources,
    gaps: bundle.gaps,
    contradictions: bundle.contradictions,
    contradictionsAnalysis,
    claimAssessments,
    independence: analyzeSourceIndependence(bundle.sources),
    qualityByEvidence,
  })
}

describe("research completeness (v0.4)", () => {
  it("scores a healthy independent bundle as MOSTLY_COMPLETE with full dimensions", () => {
    const completeness = completenessFor()
    expect(completeness.status).toBe("MOSTLY_COMPLETE")
    expect(completeness.score).toBeGreaterThanOrEqual(THRESHOLDS.MOSTLY_COMPLETE)
    expect(completeness.score).toBeLessThan(THRESHOLDS.COMPLETE)

    const byId = new Map(completeness.dimensions.map((d) => [d.id, d]))
    expect(byId.get("researchGaps")!.score).toBe(1) // no gaps is perfect coverage
    expect(byId.get("evidenceCoverage")!.score).toBe(1)
    expect(byId.get("claimCoverage")!.score).toBe(1)
    expect(completeness.unresolvedGaps).toHaveLength(0)
    expect(completeness.unresolvedContradictions).toHaveLength(0)
  })

  it("reports BLOCKED for an empty research output", () => {
    const bundle = makeResearchBundle({ sources: [], evidence: [], claims: [], queries: [] })
    const completeness = completenessFor(bundle)
    expect(completeness.status).toBe("BLOCKED")
    expect(completeness.score).toBeLessThan(0.5)
  })

  it("flags critical gaps and HIGH unresolved contradictions", () => {
    const bundle = makeResearchBundle({
      gaps: [
        {
          id: "GAP_001",
          question: "What timescale is needed?",
          importance: 0.9,
          relatedClaims: ["CLM_001"],
          suggestedResearchQueries: [],
        },
      ],
      contradictions: [
        {
          id: "CTR_001",
          claimA: "CLM_001",
          claimB: "CLM_OTHER",
          severity: "HIGH",
          classification: "CONTRADICTION",
          explanation: "two sides",
        },
      ],
      claims: [
        makeClaim({ id: "CLM_001", evidenceIds: ["EV_001"], sources: ["SRC_001"] }),
        makeClaim({ id: "CLM_OTHER", evidenceIds: ["EV_002"], sources: ["SRC_002"] }),
      ],
    })
    const completeness = completenessFor(bundle)
    expect(completeness.unresolvedGaps).toHaveLength(1)
    expect(completeness.unresolvedContradictions).toHaveLength(1)
    expect(
      completeness.recommendations.some((r) => r.includes("Close critical research gap")),
    ).toBe(true)
  })
})

describe("stopping criteria (v0.4)", () => {
  const claims: ClaimConfidenceAssessment[] = [
    {
      claimId: "CLM_001",
      status: "PARTIALLY_SUPPORTED",
      confidence: 0.5,
      supportStrength: 0.5,
      contradictionStrength: 0,
      independentSourceCount: 0,
      evidenceCount: 2,
      sourceCount: 2,
      unresolvedGapCount: 1,
      completenessImpact: 0,
      reasons: ["test"],
    },
  ]

  it("recommends continueResearch while a claim lacks independent corroboration", () => {
    const completeness = { ...completenessFor() }
    const result = evaluateStoppingCriteria({
      completeness,
      claims,
      resources: { sourcesUsed: 2, queriesUsed: 2, followUpRoundsUsed: 0 },
    })
    expect(result.continueResearch).toBe(true)
    expect(result.reasons.some((r) => r.includes("lacks independent corroboration"))).toBe(true)
    expect(result.limitsRespected).toBe(true)
  })

  it("stops and says so when a hard resource limit is hit", () => {
    const completeness = { ...completenessFor() }
    const result = evaluateStoppingCriteria({
      completeness,
      claims,
      resources: { sourcesUsed: 40, queriesUsed: 10, followUpRoundsUsed: 2 },
      limits: { maxSources: 40, maxSubQuestions: 10, maxFollowUpRounds: 2 },
    })
    expect(result.continueResearch).toBe(false)
    expect(result.limitsRespected).toBe(false)
    expect(result.reasons.some((r) => r.startsWith("research stopped:"))).toBe(true)
  })

  it("stops cleanly when everything is resolved", () => {
    const result = evaluateStoppingCriteria({
      completeness: {
        score: 0.9,
        status: "COMPLETE",
        dimensions: [] as ResearchIntelligenceReport["completeness"]["dimensions"],
        unresolvedGaps: [],
        unresolvedContradictions: [],
        recommendations: [],
      },
      claims: [
        {
          ...claims[0]!,
          status: "STRONGLY_SUPPORTED",
          confidence: 0.85,
          independentSourceCount: 2,
        },
      ],
      resources: { sourcesUsed: 3, queriesUsed: 2 },
    })
    expect(result.continueResearch).toBe(false)
    expect(result.reasons).toHaveLength(0)
    expect(result.limitsRespected).toBe(true)
  })

  it("continues when substantive uncertainty exists even if nothing else is open", () => {
    const result = evaluateStoppingCriteria({
      completeness: {
        score: 0.9,
        status: "COMPLETE",
        dimensions: [] as ResearchIntelligenceReport["completeness"]["dimensions"],
        unresolvedGaps: [],
        unresolvedContradictions: [],
        recommendations: [],
      },
      claims: [
        {
          ...claims[0]!,
          status: "STRONGLY_SUPPORTED",
          confidence: 0.85,
          independentSourceCount: 2,
        },
      ],
      uncertainties: [
        {
          id: "UNC_001",
          kind: "LOW_QUALITY_EVIDENCE",
          subjectType: "claim",
          subjectId: "CLM_001",
          detail: "Claims' evidence averages low quality (0.42): admixture claim.",
        },
      ],
      resources: { sourcesUsed: 3, queriesUsed: 2 },
    })
    expect(result.continueResearch).toBe(true)
    expect(result.reasons).toContain(
      "Claims' evidence averages low quality (0.42): admixture claim.",
    )
  })
})
