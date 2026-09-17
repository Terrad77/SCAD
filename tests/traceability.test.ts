import { describe, it, expect } from "vitest"
import { buildTraceabilityReport } from "../src/core/traceability.js"
import { makeResearch, makeClaim, makeNarrative, makeShot } from "./fixtures.js"

describe("traceability", () => {
  it("builds a full shot → sentence → claim → source chain", () => {
    const research = makeResearch()
    const claims = [makeClaim()]
    const narrative = makeNarrative()
    const shots = [makeShot()]

    const report = buildTraceabilityReport(shots, narrative, claims, research)
    const entry = report.entries[0]!

    expect(entry.shotId).toBe("SHOT_001")
    expect(entry.narrativeSentenceId).toBe("SNT_001")
    expect(entry.claimIds).toEqual(["CLM_001"])
    expect(entry.sourceIds).toEqual(["SRC_001"])
    expect(entry.sourceTitles[0]).toBe("A Reliable Work")
    expect(report.summary.fullyTraced).toBe(1)
  })

  it("counts untraced shots without claims", () => {
    const research = makeResearch()
    const claims = [makeClaim()]
    const narrative = makeNarrative({ sections: [] })
    const shots = [makeShot({ narrativeSentenceIds: ["SNT_GHOST"] })]

    const report = buildTraceabilityReport(shots, narrative, claims, research)
    expect(report.summary.untraced).toBe(1)
  })
})
