import { describe, it, expect } from "vitest"
import { analyzeContradiction } from "../src/core/evidence/contradiction-analysis.js"
import type { Claim, Contradiction, Evidence } from "../src/core/schemas.js"
import { makeClaim } from "./fixtures.js"

interface Setup {
  claims: Claim[]
  contradiction: Contradiction
  qualityByEvidence?: Map<string, never>
  claimQuality?: Map<string, number>
}

function run(over: Partial<Setup> = {}) {
  const claims = over.claims ?? [makeClaim(), makeClaim({ id: "CLM_OTHER" })]
  return analyzeContradiction({
    contradiction:
      over.contradiction ??
      ({
        id: "CTR_001",
        claimA: "CLM_001",
        claimB: "CLM_OTHER",
        severity: "HIGH",
        classification: "CONTRADICTION",
        explanation: "test",
      } satisfies Contradiction),
    claims,
    evidence: [] as Evidence[],
    qualityByEvidence: over.qualityByEvidence ?? new Map(),
    ...(over.claimQuality ? { claimQuality: over.claimQuality } : {}),
  })
}

describe("contradiction analysis 2.0 (v0.4)", () => {
  it("resolves legacy population classification into POPULATION_CONTEXT", () => {
    const result = run({
      contradiction: {
        id: "CTR_001",
        claimA: "CLM_001",
        claimB: "CLM_OTHER",
        severity: "LOW",
        classification: "DIFFERENT_POPULATION",
        explanation: "groups differ",
      },
    })
    expect(result.analysis).toBe("POPULATION_CONTEXT")
    expect(result.context?.type).toBe("population")
    expect(result.confidence).toBeCloseTo(0.6, 10)
  })

  it("resolves different quoted measures into MEASUREMENT_CONTEXT", () => {
    const result = run({
      claims: [
        makeClaim({ id: "CLM_001", statement: "The population is 5 million." }),
        makeClaim({ id: "CLM_OTHER", statement: "The population is 8 million." }),
      ],
    })
    expect(result.analysis).toBe("MEASUREMENT_CONTEXT")
    expect(result.context?.type).toBe("measurement")
    expect(result.reasons.join(" ")).toContain("different measures")
  })

  it("calls a strong two-sided conflict a GENUINE_CONTRADICTION", () => {
    const result = run({
      claims: [
        makeClaim({
          id: "CLM_001",
          statement: "The intervention reduces mortality.",
          confidence: 0.8,
        }),
        makeClaim({
          id: "CLM_OTHER",
          statement: "The intervention does not reduce mortality.",
          confidence: 0.8,
        }),
      ],
      claimQuality: new Map([
        ["CLM_001", 0.9],
        ["CLM_OTHER", 0.9],
      ]),
    })
    expect(result.analysis).toBe("GENUINE_CONTRADICTION")
    expect(result.confidence).toBeCloseTo(0.9, 10)
  })

  it("leaves hedged conflicts as UNKNOWN uncertainty", () => {
    const result = run({
      claims: [
        makeClaim({ id: "CLM_001", statement: "The treatment may work." }),
        makeClaim({ id: "CLM_OTHER", statement: "The treatment does not work." }),
      ],
      claimQuality: new Map([
        ["CLM_001", 0.2],
        ["CLM_OTHER", 0.2],
      ]),
    })
    expect(result.analysis).toBe("UNKNOWN")
    expect(result.reasons.join(" ")).toContain("hedged")
  })

  it("falls back to INSUFFICIENT_CONTEXT when evidence is weak", () => {
    const result = run({
      claims: [
        makeClaim({ id: "CLM_001", statement: "The market is growing." }),
        makeClaim({ id: "CLM_OTHER", statement: "The market is shrinking." }),
      ],
      claimQuality: new Map([
        ["CLM_001", 0.3],
        ["CLM_OTHER", 0.3],
      ]),
    })
    expect(result.analysis).toBe("INSUFFICIENT_CONTEXT")
  })
})
