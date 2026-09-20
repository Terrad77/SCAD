import { describe, it, expect } from "vitest"
import { computeEvidenceQuality } from "../src/core/evidence/evidence-quality.js"
import { makeEvidence, makeSource } from "./fixtures.js"

describe("evidence quality (v0.4)", () => {
  it("computes weighted overall from the five dimensions", () => {
    const quality = computeEvidenceQuality({
      evidence: makeEvidence({ statement: "Genomic data shows interbreeding between hominins." }),
      source: makeSource({ reliability: 0.9 }),
      referenceDate: "2026-01-01",
    })

    expect(quality.dimensions.reliability).toBeCloseTo(0.9, 10)
    expect(quality.dimensions.strength).toBeCloseTo(0.85, 10) // "shows" is definitive
    expect(quality.dimensions.directness).toBeCloseTo(0.9, 10) // excerpt present
    expect(quality.dimensions.specificity).toBeCloseTo(0.5, 10)
    expect(quality.dimensions.freshness).toBeCloseTo(0.5, 10) // no publication date
    expect(quality.overall).toBeCloseTo(0.77, 10)
    expect(quality.reasons.length).toBeGreaterThanOrEqual(5)
  })

  it("penalizes hedged statements", () => {
    const quality = computeEvidenceQuality({
      evidence: makeEvidence({ statement: "The surge may reflect sampling noise." }),
      source: makeSource({ reliability: 0.9 }),
    })
    expect(quality.dimensions.strength).toBeCloseTo(0.4, 10)
    expect(quality.overall).toBeLessThan(0.77)
  })

  it("marks fallback-derived evidence as less direct", () => {
    const quality = computeEvidenceQuality({
      evidence: makeEvidence({ statement: 'From "A Reliable Work": a key finding.' }),
      source: makeSource(),
    })
    expect(quality.dimensions.directness).toBeCloseTo(0.3, 10)
  })

  it("scores freshness from the publication date window against referenceDate", () => {
    const fresh = computeEvidenceQuality({
      evidence: makeEvidence(),
      source: makeSource({ reliability: 0.7, publishedAt: "2025-06-01" }),
      referenceDate: "2026-01-01",
    })
    expect(fresh.dimensions.freshness).toBe(1)

    const aged = computeEvidenceQuality({
      evidence: makeEvidence(),
      source: makeSource({ reliability: 0.7, publishedAt: "2022-06-01" }),
      referenceDate: "2026-01-01",
    })
    expect(aged.dimensions.freshness).toBeCloseTo(0.7, 10) // ~3.6 years old → <5y window
  })

  it("degrades gracefully to type-based reliability when no number is set", () => {
    const quality = computeEvidenceQuality({
      evidence: makeEvidence(),
      source: makeSource({ reliability: undefined, type: "NEWS" }),
    })
    expect(quality.dimensions.reliability).toBeCloseTo(0.55, 10) // NEWS base
  })

  it("uses the default reliability when no source is provided", () => {
    const quality = computeEvidenceQuality({ evidence: makeEvidence() })
    expect(quality.dimensions.reliability).toBeCloseTo(0.5, 10)
    expect(quality.reasons.some((r) => r.includes("default"))).toBe(true)
  })
})
