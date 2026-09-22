import { describe, it, expect } from "vitest"
import {
  appendVersion,
  buildVersion,
  importHypotheses,
  latestVersion,
  toActiveHypotheses,
  versionCount,
} from "../src/core/reasoning/hypothesis-version.js"
import {
  ALTERNATIVE_REASON_PREFIX,
  alternativeReasonFor,
  buildRejection,
  buildRevision,
  generateAlternative,
} from "../src/agents/reasoning/hypothesis-lifecycle.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import type { HypothesisVerification } from "../src/core/schemas.js"
import { makeHypothesis, makeResearchBundle, makeClaim } from "./fixtures.js"

const RESEARCH = makeResearchBundle({
  claims: [
    makeClaim(),
    makeClaim({ id: "CLM_002", statement: "Technology drives cultural divergence." }),
  ],
})

function makeVerification(over: Partial<HypothesisVerification> = {}): HypothesisVerification {
  return {
    hypothesisId: "HYP_001",
    status: "PARTIALLY_SUPPORTED",
    confidence: 0.45,
    supportingEvidence: ["EV_001"],
    contradictingEvidence: ["EV_002"],
    researchGaps: [],
    rationale: "Support and contradiction coexist.",
    ...over,
  }
}

/** An LLM agent that always throws → forces the deterministic fallbacks. */
const throwingAgent = () => new StructuredAgent(new MockLLMProvider(() => null), readPromptFile)

describe("v0.5 hypothesis version log", () => {
  it("versions carry deterministic bookkeeping", () => {
    const version = buildVersion(makeHypothesis(), 1, "STEP_001", "generated")
    expect(version.versionId).toBe("HYP_001_V1")
    expect(version.hypothesisId).toBe("HYP_001")
    expect(version.version).toBe(1)
    expect(version.createdAfterStep).toBe("STEP_001")
    expect(version.reason).toBe("generated")
  })

  it("importHypotheses seeds v0.4 hypotheses as their first immutable version", () => {
    const versions = importHypotheses([makeHypothesis()], "STEP_000")
    expect(versions).toHaveLength(1)
    expect(versions[0]!.versionId).toBe("HYP_001_V1")
    expect(versions[0]!.status).toBe("ACTIVE")
    expect(versions[0]!.reason).toBe("imported from the hypotheses stage")
    expect(toActiveHypotheses(versions)).toHaveLength(1)
  })

  it("appendVersion marks the prior version superseded and refuses out-of-order versions", () => {
    const versions = importHypotheses([makeHypothesis()], "STEP_000")
    const next = buildVersion(
      { ...makeHypothesis(), statement: "Refined statement." },
      2,
      "STEP_002",
      "revised",
      { parentVersionId: "HYP_001_V1" },
    )
    const log = appendVersion(versions, next)
    expect(log).toHaveLength(2)
    expect(latestVersion(log, "HYP_001")?.versionId).toBe("HYP_001_V2")
    expect(log[0]!.supersededByVersionId).toBe("HYP_001_V2")
    expect(() =>
      appendVersion(versions, buildVersion(makeHypothesis(), 1, "STEP_002", "duplicate")),
    ).toThrow(/would not follow/)
  })

  it("generateAlternative with a target creates a NEW hypothesis id, not a version", async () => {
    const versions = importHypotheses(
      [makeHypothesis({ contradictingClaims: ["CLM_001"] })],
      "STEP_000",
    )
    const alternative = await generateAlternative({
      research: RESEARCH,
      versions,
      stepId: "STEP_002",
      targetHypothesisId: "HYP_001",
    })
    expect(alternative.hypothesisId).not.toBe("HYP_001")
    expect(alternative.version).toBe(1)
    expect(alternative.reason).toBe(alternativeReasonFor("HYP_001"))
    expect(alternative.reason.startsWith(ALTERNATIVE_REASON_PREFIX)).toBe(true)
    expect(alternative.parentVersionId).toBe("HYP_001_V1")
    expect(alternative.createdAfterStep).toBe("STEP_002")
    expect(alternative.statement).toContain("Rather than")
  })

  it("generateAlternative without a target derives the first hypothesis from the strongest claim", async () => {
    const alternative = await generateAlternative({
      research: RESEARCH,
      versions: [],
      stepId: "STEP_001",
      targetHypothesisId: null,
    })
    expect(alternative.hypothesisId).toBe("HYP_001")
    expect(alternative.version).toBe(1)
    expect(alternative.statement).toBe(RESEARCH.claims[0]!.statement)
    expect(alternative.supportingClaims).toEqual([makeClaim().id])
    expect(alternative.status).toBe("UNTESTED")
  })

  it("generateAlternative degrades to the deterministic opposing stance when the LLM throws", async () => {
    const versions = importHypotheses(
      [makeHypothesis({ contradictingClaims: ["CLM_001"] })],
      "STEP_000",
    )
    const alternative = await generateAlternative({
      research: RESEARCH,
      versions,
      stepId: "STEP_002",
      targetHypothesisId: "HYP_001",
      agent: throwingAgent(),
    })
    expect(alternative.statement).toContain("Rather than")
    expect(alternative.contradictingClaims).toEqual(["CLM_001"])
  })

  it("buildRevision produces a fresh UNTESTED version with a fallback statement", async () => {
    const versions = importHypotheses([makeHypothesis()], "STEP_000")
    const revised = await buildRevision({
      research: RESEARCH,
      versions,
      stepId: "STEP_002",
      targetHypothesisId: "HYP_001",
      verification: makeVerification(),
      agent: throwingAgent(),
    })
    expect(revised.versionId).toBe("HYP_001_V2")
    expect(revised.version).toBe(2)
    expect(revised.parentVersionId).toBe("HYP_001_V1")
    expect(revised.status).toBe("UNTESTED")
    expect(revised.statement).toContain("— revised:")
    expect(revised.statement).toContain("Support and contradiction coexist.")
    expect(versionCount(versions, "HYP_001")).toBe(1)
  })

  it("buildRejection marks the hypothesis REJECTED and removes it from the active set", () => {
    const versions = importHypotheses([makeHypothesis()], "STEP_000")
    const rejected = buildRejection({
      research: RESEARCH,
      versions,
      stepId: "STEP_002",
      targetHypothesisId: "HYP_001",
      verification: makeVerification({ status: "CONTRADICTED" }),
    })
    expect(rejected.status).toBe("REJECTED")
    expect(rejected.reason).toContain("rejected:")
    const log = appendVersion(versions, rejected)
    expect(toActiveHypotheses(log)).toHaveLength(0)
    expect(latestVersion(log, "HYP_001")?.versionId).toBe("HYP_001_V2")
  })
})
