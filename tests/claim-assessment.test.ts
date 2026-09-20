import { describe, it, expect } from "vitest"
import { assessClaim } from "../src/core/evidence/claim-assessment.js"
import type { Claim, Evidence, Source } from "../src/core/schemas.js"
import { makeResearchBundle } from "./fixtures.js"

function sourceOf(id: string, reliability: number, publisher: string, url: string): Source {
  return { id, title: `Title ${id}`, publisher, url, type: "NEWS", reliability }
}

function ev(
  id: string,
  supportsClaims: string[],
  contradictsClaims: string[],
  confidence: number,
): Evidence {
  return {
    id,
    sourceId: id === "EV_001" ? "SRC_001" : "SRC_002",
    statement: `Statement ${id}`,
    supportsClaims,
    contradictsClaims,
    confidence,
  }
}

function quality(id: string, overall: number) {
  return {
    evidenceId: id,
    sourceId: id === "EV_001" ? "SRC_001" : "SRC_002",
    dimensions: {
      reliability: 0.8,
      strength: 0.8,
      directness: 0.8,
      specificity: 0.8,
      freshness: 0.8,
    },
    overall,
    reasons: ["test"],
  }
}

describe("claim assessment 2.0 (v0.4)", () => {
  it("rates a claim SUPPORTED from strong independent evidence", () => {
    const claim: Claim = {
      ...makeResearchBundle().claims[0]!,
      evidenceIds: ["EV_001", "EV_002"],
      sources: ["SRC_001", "SRC_002"],
    }
    const assessment = assessClaim({
      claim,
      evidenceById: new Map([
        ["EV_001", ev("EV_001", ["CLM_001"], [], 0.8)],
        ["EV_002", ev("EV_002", ["CLM_001"], [], 0.7)],
      ]),
      sourceById: new Map([
        ["SRC_001", sourceOf("SRC_001", 0.7, "Reuters", "https://reuters.com/a")],
        ["SRC_002", sourceOf("SRC_002", 0.9, "Nature Portfolio", "https://nature.com/b")],
      ]),
      qualityByEvidence: new Map([
        ["EV_001", quality("EV_001", 0.7)],
        ["EV_002", quality("EV_002", 0.6)],
      ]),
      sources: [
        sourceOf("SRC_001", 0.7, "Reuters", "https://reuters.com/a"),
        sourceOf("SRC_002", 0.9, "Nature Portfolio", "https://nature.com/b"),
      ],
      contradictions: [],
      gaps: [],
    })

    expect(assessment.status).toBe("SUPPORTED")
    expect(assessment.supportStrength).toBeCloseTo(0.65, 10)
    expect(assessment.independentSourceCount).toBe(2)
    expect(assessment.confidence).toBeGreaterThanOrEqual(0.6)
    expect(assessment.confidence).toBeLessThan(0.8)
    expect(assessment.unresolvedGapCount).toBe(0)
  })

  it("penalizes weak evidence, missing independence and an open gap down to INCONCLUSIVE", () => {
    const claim: Claim = {
      ...makeResearchBundle().claims[0]!,
      evidenceIds: ["EV_001"],
      sources: ["SRC_001"],
    }
    const assessment = assessClaim({
      claim,
      evidenceById: new Map([["EV_001", ev("EV_001", ["CLM_001"], [], 0.5)]]),
      sourceById: new Map([
        ["SRC_001", sourceOf("SRC_001", 0.7, "Reuters", "https://reuters.com/a")],
      ]),
      qualityByEvidence: new Map([["EV_001", quality("EV_001", 0.5)]]),
      sources: [sourceOf("SRC_001", 0.7, "Reuters", "https://reuters.com/a")],
      contradictions: [],
      gaps: [
        {
          id: "GAP_001",
          question: "What is the timescale?",
          importance: 0.9,
          relatedClaims: ["CLM_001"],
          suggestedResearchQueries: [],
        },
      ],
    })

    expect(assessment.status).toBe("INCONCLUSIVE")
    expect(assessment.unresolvedGapCount).toBe(1)
    // A single source can never count as independent (regression).
    expect(assessment.independentSourceCount).toBe(0)
    expect(assessment.completenessImpact).toBeCloseTo(-0.09, 10)
  })

  it("reports INSUFFICIENT_EVIDENCE when a claim has no linked evidence", () => {
    const claim: Claim = {
      ...makeResearchBundle().claims[0]!,
      evidenceIds: [],
      sources: ["SRC_001"],
    }
    const assessment = assessClaim({
      claim,
      evidenceById: new Map(),
      sourceById: new Map(),
      qualityByEvidence: new Map(),
      sources: [],
      contradictions: [],
      gaps: [],
    })
    expect(assessment.status).toBe("INSUFFICIENT_EVIDENCE")
    expect(assessment.evidenceCount).toBe(0)
  })

  it("flags a claim as CONTRADICTED when only contradicting evidence exists", () => {
    const claim: Claim = { ...makeResearchBundle().claims[0]!, evidenceIds: ["EV_GHOST"] }
    const assessment = assessClaim({
      claim,
      evidenceById: new Map([["EV_002", ev("EV_002", [], ["CLM_001"], 0.9)]]),
      sourceById: new Map(),
      qualityByEvidence: new Map([["EV_002", quality("EV_002", 0.9)]]),
      sources: [],
      contradictions: [],
      gaps: [],
    })
    expect(assessment.status).toBe("CONTRADICTED")
    expect(assessment.contradictionStrength).toBeCloseTo(0.9, 10)
  })

  it("marks a contested claim when a contradiction record exists alongside support", () => {
    const claim: Claim = {
      ...makeResearchBundle().claims[0]!,
      evidenceIds: ["EV_001"],
      sources: ["SRC_001"],
    }
    const assessment = assessClaim({
      claim,
      evidenceById: new Map([["EV_001", ev("EV_001", ["CLM_001"], [], 0.8)]]),
      sourceById: new Map([
        ["SRC_001", sourceOf("SRC_001", 0.7, "Reuters", "https://reuters.com/a")],
      ]),
      qualityByEvidence: new Map([["EV_001", quality("EV_001", 0.7)]]),
      sources: [sourceOf("SRC_001", 0.7, "Reuters", "https://reuters.com/a")],
      contradictions: [
        {
          id: "CTR_001",
          claimA: "CLM_001",
          claimB: "CLM_OTHER",
          severity: "MEDIUM",
          classification: "CONTRADICTION",
          explanation: "disagreement",
        },
      ],
      gaps: [],
    })
    expect(assessment.status).toBe("CONTESTED")
  })
})
