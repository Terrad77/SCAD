import { describe, it, expect } from "vitest"
import {
  classifyClaimUncertainty,
  collectUncertainties,
  hypothesisUncertainty,
  makeUncertaintyId,
} from "../src/core/evidence/uncertainty.js"
import type { Evidence } from "../src/core/schemas.js"
import { makeClaim } from "./fixtures.js"

function supportiveEvidence(): Evidence {
  return {
    id: "EV_001",
    sourceId: "SRC_001",
    statement: "Evidence",
    supportsClaims: ["CLM_001"],
    contradictsClaims: [],
    confidence: 0.8,
  }
}

describe("explicit uncertainty (v0.4)", () => {
  it("builds zero-padded deterministic ids", () => {
    expect(makeUncertaintyId("UNC", 1)).toBe("UNC_001")
    expect(makeUncertaintyId("UNC", 42)).toBe("UNC_042")
    expect(hypothesisUncertainty("UNCERTAIN", "HYP_001", "why", 1).id).toBe("UNC_HYP_001")
  })

  it("classifies absent evidence as INSUFFICIENT_EVIDENCE", () => {
    const result = classifyClaimUncertainty({
      claim: makeClaim({ id: "CLM_001" }),
      supporting: [],
      contradicting: [],
      supportQuality: 0,
    })
    expect(result?.kind).toBe("INSUFFICIENT_EVIDENCE")
    expect(result?.subjectType).toBe("claim")
  })

  it("classifies mixed support and contradiction as CONFLICTING_EVIDENCE", () => {
    const result = classifyClaimUncertainty({
      claim: makeClaim({ id: "CLM_001" }),
      supporting: [supportiveEvidence()],
      contradicting: [{ ...supportiveEvidence(), id: "EV_002", contradictsClaims: ["CLM_001"] }],
      supportQuality: 0.8,
    })
    expect(result?.kind).toBe("CONFLICTING_EVIDENCE")
  })

  it("classifies speculation as UNCERTAIN", () => {
    const result = classifyClaimUncertainty({
      claim: makeClaim({ id: "CLM_001", knowledge: "SPECULATION" }),
      supporting: [supportiveEvidence()],
      contradicting: [],
      supportQuality: 0.8,
    })
    expect(result?.kind).toBe("UNCERTAIN")
  })

  it("classifies low-quality support as LOW_QUALITY_EVIDENCE", () => {
    const result = classifyClaimUncertainty({
      claim: makeClaim({ id: "CLM_001" }),
      supporting: [supportiveEvidence()],
      contradicting: [],
      supportQuality: 0.3,
    })
    expect(result?.kind).toBe("LOW_QUALITY_EVIDENCE")
  })

  it("collects claim, contradiction and critical-gap uncertainties in one list", () => {
    const claimA = makeClaim({ id: "CLM_001", statement: "No evidence yet." })
    const uncertainties = collectUncertainties({
      claims: [claimA],
      evidence: [],
      claimAssessments: [],
      contradictionAnalyses: [
        {
          contradictionId: "CTR_001",
          claimA: "CLM_100",
          claimB: "CLM_200",
          severity: "HIGH",
          classification: "CONTRADICTION",
          analysis: "GENUINE_CONTRADICTION",
          evidenceQualityA: 0.9,
          evidenceQualityB: 0.9,
          confidence: 0.9,
          reasons: ["strong"],
        },
      ],
      researchGaps: [
        {
          id: "GAP_001",
          question: "Open question?",
          importance: 0.9,
          relatedClaims: [],
          suggestedResearchQueries: [],
        },
      ],
      qualityByEvidence: new Map(),
      researchId: "PLAN_001",
    })

    expect(uncertainties.map((u) => u.kind)).toEqual([
      "INSUFFICIENT_EVIDENCE", // claim CLM_001
      "CONFLICTING_EVIDENCE", // research-level genuine contradiction
      "INSUFFICIENT_EVIDENCE", // critical gap
    ])
    expect(uncertainties[0]!.id).toBe("UNC_001")
    expect(uncertainties[1]!.id).toBe("UNC_002")
    expect(uncertainties[2]!.id).toBe("UNC_003")
  })
})
