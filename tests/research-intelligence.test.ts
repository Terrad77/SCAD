import { describe, it, expect } from "vitest"
import { ResearchIntelligenceEngine } from "../src/agents/research/research-intelligence.js"
import type { HypothesisVerification } from "../src/core/schemas.js"
import { ResearchIntelligenceReportSchema } from "../src/core/schemas.js"
import { makeClaim, makeEvidence, makeResearchBundle } from "./fixtures.js"

function makeVerification(): HypothesisVerification {
  return {
    hypothesisId: "HYP_001",
    status: "PARTIALLY_SUPPORTED",
    confidence: 0.55,
    supportingEvidence: ["EV_001"],
    contradictingEvidence: ["EV_002"],
    researchGaps: [],
    rationale: "One source supports, another contradicts.",
  }
}

describe("research intelligence engine (v0.4)", () => {
  it("produces a fully valid report schema", () => {
    const report = new ResearchIntelligenceEngine({
      research: makeResearchBundle(),
      referenceDate: "2026-01-01",
    }).run()
    const parsed = ResearchIntelligenceReportSchema.safeParse(report)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.errors))
  })

  it("is deterministic: identical inputs give identical outputs", () => {
    const options = {
      research: makeResearchBundle(),
      verifications: [makeVerification()],
      referenceDate: "2026-01-01",
    } as const
    const a = new ResearchIntelligenceEngine(options).run()
    const b = new ResearchIntelligenceEngine(options).run()
    expect(a).toEqual(b)
  })

  it("computes evidence qualities, claim assessments and independence for the bundle", () => {
    const report = new ResearchIntelligenceEngine({
      research: makeResearchBundle(),
      referenceDate: "2026-01-01",
    }).run()
    expect(report.evidenceQuality).toHaveLength(2)
    expect(report.evidenceQuality[0]!.overall).toBeGreaterThan(0)
    expect(report.claims).toHaveLength(1)
    expect(report.claims[0]!.status).toBe("STRONGLY_SUPPORTED")
    expect(report.sourceIndependence.independentSources).toBe(2)
    expect(report.sourceIndependence.independenceRatio).toBe(1)
    expect(report.continueResearch).toBe(false)
  })

  it("enriches verifications with quality, independence and context", () => {
    const report = new ResearchIntelligenceEngine({
      research: makeResearchBundle(),
      verifications: [makeVerification()],
      referenceDate: "2026-01-01",
    }).run()
    const enriched = report.hypotheses[0]!
    expect(enriched.evidenceQuality).toHaveLength(2)
    expect(enriched.contradictions).toEqual([])
    expect(enriched.uncertainties).toHaveLength(1)
    expect(enriched.uncertainties[0]!.kind).toBe("CONFLICTING_EVIDENCE")
    expect(enriched.alternativeExplanations.length).toBeGreaterThanOrEqual(1)
  })

  it("exposes a contradiction when a verification's evidence touches both sides", () => {
    const bundle = makeResearchBundle({
      claims: [
        makeClaim({
          id: "CLM_001",
          evidenceIds: ["EV_001"],
          sources: ["SRC_001"],
          confidence: 0.8,
        }),
        makeClaim({
          id: "CLM_002",
          statement: "Neanderthal admixture is documented in modern genomes.",
          evidenceIds: ["EV_002"],
          sources: ["SRC_002"],
          confidence: 0.8,
        }),
      ],
      evidence: [
        makeEvidence({ id: "EV_001", sourceId: "SRC_001", supportsClaims: ["CLM_001"] }),
        makeEvidence({
          id: "EV_002",
          sourceId: "SRC_002",
          statement: "Neanderthal admixture is documented in modern genomes.",
          supportsClaims: ["CLM_002"],
        }),
      ],
      contradictions: [
        {
          id: "CTR_001",
          claimA: "CLM_001",
          claimB: "CLM_002",
          severity: "HIGH",
          classification: "CONTRADICTION",
          explanation: "The two claims conflict.",
        },
      ],
    })
    const report = new ResearchIntelligenceEngine({
      research: bundle,
      verifications: [makeVerification()],
      referenceDate: "2026-01-01",
    }).run()
    const enriched = report.hypotheses[0]!
    const ids = enriched.contradictions.map((a) => a.contradictionId)
    expect(ids).toContain("CTR_001")
    expect(enriched.contradictions[0]!.analysis).toBe("GENUINE_CONTRADICTION")
  })

  it("collects explicit uncertainty for unsupported and speculative claims", () => {
    const bundle = makeResearchBundle({
      claims: [
        makeClaim({
          id: "CLM_001",
          evidenceIds: ["EV_001", "EV_002"],
          sources: ["SRC_001", "SRC_002"],
        }),
        makeClaim({
          id: "CLM_SPEC",
          statement: "Humans will merge with machines.",
          sources: ["SRC_001"],
          evidenceIds: ["EV_001"],
          knowledge: "SPECULATION",
        }),
      ],
    })
    const report = new ResearchIntelligenceEngine({
      research: bundle,
      verifications: [],
      referenceDate: "2026-01-01",
    }).run()
    const kinds = report.uncertainties.map((u) => u.kind)
    expect(kinds).toContain("UNCERTAIN")
    expect(report.uncertainties[0]!.id).toBe("UNC_001")
  })

  it("stops recommending research once resource caps are hit", () => {
    const report = new ResearchIntelligenceEngine({
      research: makeResearchBundle(),
      referenceDate: "2026-01-01",
      limits: { maxSources: 2, maxSubQuestions: 2, maxFollowUpRounds: 0 },
    }).run()
    expect(report.stopping.limitsRespected).toBe(false)
    expect(report.stopping.continueResearch).toBe(false)
    expect(report.recommendations.some((r) => r.startsWith("research stopped:"))).toBe(false)
  })

  it("applies source relationship overrides from structured LLM input", () => {
    const report = new ResearchIntelligenceEngine({
      research: makeResearchBundle(),
      referenceDate: "2026-01-01",
      relationshipOverrides: [
        { sourceA: "SRC_001", sourceB: "SRC_002", relationship: "REFERENCES", basis: "test" },
      ],
    }).run()
    expect(report.sourceIndependence.independentSources).toBe(0)
    expect(report.sourceIndependence.dependentSources).toBe(1)
  })

  it("produces recommendations for open problems", () => {
    const report = new ResearchIntelligenceEngine({
      research: makeResearchBundle({
        gaps: [
          {
            id: "GAP_001",
            question: "What timescale?",
            importance: 0.9,
            relatedClaims: ["CLM_001"],
            suggestedResearchQueries: [],
          },
        ],
      }),
      referenceDate: "2026-01-01",
    }).run()
    expect(report.unresolvedGaps).toHaveLength(1)
    expect(report.recommendations.some((r) => r.includes("Close critical research gap"))).toBe(true)
    expect(report.continueResearch).toBe(true)
  })

  it("does not blindly stop when collected evidence is of low quality", () => {
    const bundle = makeResearchBundle({
      plan: {
        id: "PLAN_001",
        question: "Can humanity become a new species?",
        subQuestions: [{ id: "SUB_Q_001", text: "Did admixture happen?" }],
      },
      queries: [{ id: "QRY_001", subquestionId: "SUB_Q_001", query: "admixture" }],
      sources: [
        {
          id: "SRC_001",
          title: "Blog post A",
          url: "https://blog-a.example/post/a",
          publisher: "Blogger A",
          type: "BLOG",
        },
        {
          id: "SRC_002",
          title: "Blog post B",
          url: "https://blog-b.example/post/b",
          publisher: "Blogger B",
          type: "BLOG",
        },
      ],
      evidence: [
        makeEvidence({
          id: "EV_001",
          sourceId: "SRC_001",
          statement: "It might be that admixture happened.",
          supportsClaims: ["CLM_001"],
        }),
        makeEvidence({
          id: "EV_002",
          sourceId: "SRC_002",
          statement: "It might be that admixture happened.",
          supportsClaims: ["CLM_001"],
        }),
      ],
      claims: [
        makeClaim({
          evidenceIds: ["EV_001", "EV_002"],
          sources: ["SRC_001", "SRC_002"],
          subquestionIds: ["SUB_Q_001"],
        }),
      ],
    })
    const report = new ResearchIntelligenceEngine({
      research: bundle,
      verifications: [],
      referenceDate: "2026-01-01",
    }).run()
    expect(report.claims[0]!.independentSourceCount).toBe(2)
    expect(report.uncertainties.map((u) => u.kind)).toContain("LOW_QUALITY_EVIDENCE")
    expect(report.continueResearch).toBe(true)
    expect(report.stopping.reasons.some((r) => r.includes("averages low quality"))).toBe(true)
  })

  it("reports the follow-up cap from the bundle's actual follow-up rounds", () => {
    const report = new ResearchIntelligenceEngine({
      research: makeResearchBundle({ followUpRoundsUsed: 2 }),
      referenceDate: "2026-01-01",
      limits: { maxFollowUpRounds: 1 },
    }).run()
    expect(report.stopping.limitsRespected).toBe(false)
    expect(report.stopping.reasons.some((r) => r.startsWith("research stopped:"))).toBe(true)
  })
})
