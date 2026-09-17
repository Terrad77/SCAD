import { describe, it, expect } from "vitest"
import { SelfCheckEngine } from "../src/agents/self-check/self-check.js"
import { makeResearch, makeClaim, makeNarrative, makeShots } from "./fixtures.js"
import type { Claim } from "../src/core/schemas.js"

describe("SelfCheckEngine", () => {
  it("flags a claim with no source as critical", () => {
    const claims = [makeClaim({ sources: [] })]
    const report = new SelfCheckEngine().run({
      claims,
      narrative: makeNarrative({ sections: [] }),
      shots: [],
    })
    expect(report.critical.some((i) => i.type === "unsupported-claim")).toBe(true)
  })

  it("warns on missing evidence for a claim with sources", () => {
    const claims = [makeClaim({ evidence: [] })]
    const report = new SelfCheckEngine().run({
      claims,
      narrative: makeNarrative({ sections: [] }),
      shots: [],
    })
    expect(report.warnings.some((i) => i.type === "missing-evidence")).toBe(true)
  })

  it("warns when a FAILED claim verdict arrives without source", () => {
    const claims = [makeClaim({ sources: [] })]
    const report = new SelfCheckEngine().run({
      claims,
      narrative: makeNarrative({ sections: [] }),
      shots: [],
      assessments: [{ claimId: "CLM_001", verdict: "UNSUPPORTED" }],
    })
    expect(report.critical.some((i) => i.type === "unsupported-claim")).toBe(true)
  })

  it("flags dangling claim references in narrative as critical", () => {
    const narrative = makeNarrative({
      sections: [
        {
          id: "SEC_002",
          heading: "Ghost",
          sentences: [
            {
              id: "SNT_099",
              text: "A sentence referencing a missing claim.",
              knowledge: "FACT",
              claimIds: ["CLM_999"],
            },
          ],
        },
      ],
    })
    const report = new SelfCheckEngine().run({ claims: [makeClaim()], narrative, shots: [] })
    expect(report.critical.some((i) => i.type === "dangling-claim-reference")).toBe(true)
  })

  it("flags low confidence claims as info", () => {
    const claims = [makeClaim({ confidence: 0.3 })]
    const report = new SelfCheckEngine().run({
      claims,
      narrative: makeNarrative({ sections: [] }),
      shots: [],
    })
    expect(report.info.some((i) => i.type === "low-confidence")).toBe(true)
  })

  it("warns on repeated section headings", () => {
    const claims: Claim[] = []
    const narrative = makeNarrative({
      sections: [
        {
          id: "SEC_1",
          heading: "Same",
          sentences: [{ id: "SNT_1", text: "one", knowledge: "FACT", claimIds: [] }],
        },
        {
          id: "SEC_2",
          heading: "Same",
          sentences: [{ id: "SNT_2", text: "two", knowledge: "FACT", claimIds: [] }],
        },
      ],
    })
    const report = new SelfCheckEngine().run({ claims, narrative, shots: [] })
    expect(report.warnings.some((i) => i.type === "repetition")).toBe(true)
  })

  it("reports an empty (clean) plan without critical items", () => {
    const report = new SelfCheckEngine().run({
      claims: [makeClaim({ confidence: 0.8 })],
      narrative: makeNarrative(),
      shots: makeShots().shots,
      assessments: [{ claimId: "CLM_001", verdict: "SUPPORTED" }],
    })
    expect(report.critical.length).toBe(0)
    void makeResearch
  })
})
