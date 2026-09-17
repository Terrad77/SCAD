import { describe, it, expect } from "vitest"
import {
  SourceSchema,
  ClaimSchema,
  HypothesisSchema,
  NarrativeSchema,
  ShotSchema,
  ResearchOutputSchema,
} from "../src/core/schemas.js"
import { parseJsonObject } from "../src/core/json.js"
import { makeResearch, makeClaim, makeHypothesis, makeNarrative, makeShot } from "./fixtures.js"

describe("schemas", () => {
  it("accepts a valid source", () => {
    expect(SourceSchema.safeParse(makeResearch().sources[0]!).success).toBe(true)
  })

  it("accepts a valid claim", () => {
    expect(ClaimSchema.safeParse(makeClaim()).success).toBe(true)
  })

  it("rejects a claim with confidence out of range", () => {
    const bad = makeClaim({ confidence: 1.5 })
    expect(ClaimSchema.safeParse(bad).success).toBe(false)
  })

  it("rejects a claim with unknown knowledge level", () => {
    const bad = { ...makeClaim(), knowledge: "TRUTH" as never }
    expect(ClaimSchema.safeParse(bad).success).toBe(false)
  })

  it("rejects a claim without sources", () => {
    const bad = makeClaim({ sources: [] })
    expect(ClaimSchema.safeParse(bad).success).toBe(false)
  })

  it("accepts a valid hypothesis", () => {
    expect(HypothesisSchema.safeParse(makeHypothesis()).success).toBe(true)
  })

  it("rejects a hypothesis with confidence out of range", () => {
    expect(HypothesisSchema.safeParse(makeHypothesis({ confidence: -0.1 })).success).toBe(false)
  })

  it("accepts a valid narrative", () => {
    expect(NarrativeSchema.safeParse(makeNarrative()).success).toBe(true)
  })

  it("rejects a narrative without sections", () => {
    const bad = makeNarrative({ sections: [] })
    expect(NarrativeSchema.safeParse(bad).success).toBe(false)
  })

  it("accepts a valid shot", () => {
    expect(ShotSchema.safeParse(makeShot()).success).toBe(true)
  })

  it("rejects a shot with zero duration", () => {
    const bad = makeShot({ duration: 0 })
    expect(ShotSchema.safeParse(bad).success).toBe(false)
  })

  it("accepts a valid research output", () => {
    expect(ResearchOutputSchema.safeParse(makeResearch()).success).toBe(true)
  })

  it("rejects research with an empty summary", () => {
    const bad = makeResearch({ summary: "" })
    expect(ResearchOutputSchema.safeParse(bad).success).toBe(false)
  })
})

describe("parseJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it("strips a Markdown code fence", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it("strips a fence without a language tag", () => {
    expect(parseJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it("throws on invalid JSON", () => {
    expect(() => parseJsonObject("{not json")).toThrow()
  })
})
