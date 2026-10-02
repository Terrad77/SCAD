import { describe, it, expect } from "vitest"
import { FactCheckEngine } from "../src/agents/fact-check/fact-check.js"
import type { Claim, ClaimAssessment, ResearchOutput } from "../src/core/schemas.js"
import { makeResearch, makeClaim, makeSource } from "./fixtures.js"

/** Runs the engine over a single claim and returns the one assessment it must produce. */
function assessClaim(research: ResearchOutput, claim: Claim): ClaimAssessment {
  const [result] = new FactCheckEngine(research).run([claim])
  if (!result) throw new Error("expected exactly one claim assessment")
  return result
}

describe("FactCheckEngine", () => {
  it("marks a fully supported claim as SUPPORTED", () => {
    const research = makeResearch()
    const claim = makeClaim()
    const result = assessClaim(research, claim)
    expect(result.verdict).toBe("SUPPORTED")
  })

  it("marks a claim with no source as UNSUPPORTED", () => {
    const research = makeResearch()
    const claim = makeClaim({ sources: [] })
    const result = assessClaim(research, claim)
    expect(result.verdict).toBe("UNSUPPORTED")
  })

  it("marks a claim referencing an unknown source as PARTIAL", () => {
    const research = makeResearch()
    const claim = makeClaim({ sources: ["SRC_UNKNOWN"] })
    const result = assessClaim(research, claim)
    expect(result.verdict).toBe("PARTIAL")
  })

  it("downgrades confidence when sources are unreliable", () => {
    const lowReliability = makeResearch({
      sources: [makeSource({ reliability: 0.05 })],
    })
    const claim = makeClaim({ confidence: 1 })
    const result = assessClaim(lowReliability, claim)
    expect(result.confidence).toBeLessThan(1)
  })

  it("keeps confidence high for a high-reliability source", () => {
    const research = makeResearch()
    const claim = makeClaim({ confidence: 0.9 })
    const result = assessClaim(research, claim)
    expect(result.confidence).toBeCloseTo(0.9 * (0.4 + 0.6 * 0.9), 5)
  })
})
