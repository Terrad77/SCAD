import { describe, it, expect } from "vitest"
import { FactCheckEngine } from "../src/agents/fact-check/fact-check.js"
import { makeResearch, makeClaim, makeSource } from "./fixtures.js"

describe("FactCheckEngine", () => {
  it("marks a fully supported claim as SUPPORTED", () => {
    const research = makeResearch()
    const claim = makeClaim()
    const [result] = new FactCheckEngine(research).run([claim])
    expect(result.verdict).toBe("SUPPORTED")
  })

  it("marks a claim with no source as UNSUPPORTED", () => {
    const research = makeResearch()
    const claim = makeClaim({ sources: [] })
    const [result] = new FactCheckEngine(research).run([claim])
    expect(result.verdict).toBe("UNSUPPORTED")
  })

  it("marks a claim referencing an unknown source as PARTIAL", () => {
    const research = makeResearch()
    const claim = makeClaim({ sources: ["SRC_UNKNOWN"] })
    const [result] = new FactCheckEngine(research).run([claim])
    expect(result.verdict).toBe("PARTIAL")
  })

  it("downgrades confidence when sources are unreliable", () => {
    const lowReliability = makeResearch({
      sources: [makeSource({ reliability: 0.05 })],
    })
    const claim = makeClaim({ confidence: 1 })
    const [result] = new FactCheckEngine(lowReliability).run([claim])
    expect(result.confidence).toBeLessThan(1)
  })

  it("keeps confidence high for a high-reliability source", () => {
    const research = makeResearch()
    const claim = makeClaim({ confidence: 0.9 })
    const [result] = new FactCheckEngine(research).run([claim])
    expect(result.confidence).toBeCloseTo(0.9 * (0.4 + 0.6 * 0.9), 5)
  })
})
