import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { ReasoningEngine } from "../src/agents/reasoning/reasoning-engine.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { toActiveHypotheses } from "../src/core/reasoning/hypothesis-version.js"
import { verifyPureHypotheses } from "../src/core/reasoning/hypothesis-verification.js"
import { ResearchIntelligenceEngine } from "../src/agents/research/research-intelligence.js"
import { ResearchIntelligenceReportSchema } from "../src/core/schemas.js"
import { makeHypothesis, makeResearchBundle } from "./fixtures.js"
import type { ResearchBundle } from "../src/core/schemas.js"

const QUESTION = "Can humanity become a new species?"
const REFERENCE_DATE = "2024-01-01T00:00:00.000Z"

async function makeEngineOptions(
  baseDir: string,
  budget?: Parameters<typeof ReasoningEngine>[0]["budget"],
) {
  const memory = new JsonMemoryStore(baseDir)
  await memory.save("research", makeResearchBundle())
  return {
    project: "humanity-2",
    question: QUESTION,
    memory,
    agent: new StructuredAgent(new MockLLMProvider(() => null), readPromptFile),
    search: new NoopSearchProvider(),
    research: makeResearchBundle(),
    hypotheses: [makeHypothesis()],
    referenceDate: REFERENCE_DATE,
    budget,
  }
}

async function runHappyPath(baseDir: string) {
  const engine = new ReasoningEngine(await makeEngineOptions(baseDir))
  return engine.run()
}

describe("v0.5 reasoning engine (Scenario F determinism)", () => {
  let dirA: string
  let dirB: string
  let dirC: string

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "scad-reason-a-"))
    dirB = await mkdtemp(join(tmpdir(), "scad-reason-b-"))
    dirC = await mkdtemp(join(tmpdir(), "scad-reason-c-"))
  })

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
    await rm(dirC, { recursive: true, force: true })
  })

  it("stops with a deterministic verdict and writes the expected artifacts", async () => {
    const state = await runHappyPath(dirA)
    expect(state.status).toBe("STOPPED")
    expect(state.lastStopping).not.toBeNull()
    expect(state.steps.length).toBeGreaterThanOrEqual(1)
    expect(state.steps[0]!.action.kind).toBe("STOP")
    expect(state.cycleContext?.referenceDate).toBe(REFERENCE_DATE)
    expect(state.cycleContext?.cycleId).toBe("CYC_001")

    const memory = new JsonMemoryStore(dirA)
    const savedState = (await memory.get<{ state: { status: string } }>("reasoning"))!.state
    expect(savedState.status).toBe("STOPPED")
    const versions = await memory.get("hypothesis-versions")
    expect(versions).toHaveLength(1)
    expect(versions[0]!.versionId).toBe("HYP_001_V1")
    expect(versions[0]!.reason).toBe("imported from the hypotheses stage")
    const active = await memory.get("hypotheses")
    expect(active.hypotheses).toHaveLength(1)
    expect(active.hypotheses[0]!.id).toBe("HYP_001")
    expect(active.verifications).toHaveLength(1)
    expect(active.verifications[0]!.hypothesisId).toBe("HYP_001")
  })

  it("never mutates the baseline research bundle (research is read-only for reasoning)", async () => {
    const baseline: ResearchBundle = makeResearchBundle()
    await runHappyPath(dirA)
    const memory = new JsonMemoryStore(dirA)
    expect(await memory.get<ResearchBundle>("research")).toEqual(baseline)
  })

  it("persists intelligence that equals a deterministic rebuild from the same inputs", async () => {
    const engine = new ReasoningEngine(await makeEngineOptions(dirA))
    await engine.run()
    const memory = new JsonMemoryStore(dirA)

    const research = (await memory.get<ResearchBundle>("research"))!
    const versions = await memory.get("hypothesis-versions")
    const hypothesis = toActiveHypotheses(versions)
    const verifications = verifyPureHypotheses({ hypotheses: hypothesis, research })
    const expected = new ResearchIntelligenceEngine({
      research,
      verifications,
      referenceDate: REFERENCE_DATE,
      limits: { maxSources: 40, maxSubQuestions: 40, maxFollowUpRounds: 5, maxIterations: 100 },
    }).run()

    const saved = await memory.get("intelligence")
    expect(JSON.stringify(saved)).toBe(JSON.stringify(expected))
    const parsed = ResearchIntelligenceReportSchema.safeParse(saved)
    expect(parsed.success).toBe(true)
  })

  it("is byte-identical across independent runs on identical inputs", async () => {
    const stateA = await runHappyPath(dirA)
    const stateB = await runHappyPath(dirB)
    expect(JSON.stringify(stateA)).toBe(JSON.stringify(stateB))

    const a = new JsonMemoryStore(dirA)
    const b = new JsonMemoryStore(dirB)
    const drain = async (s: JsonMemoryStore) => {
      const out: Record<string, unknown> = {}
      for (const key of (await s.keys()).sort()) {
        out[key] = await s.get(key)
      }
      return out
    }
    expect(JSON.stringify(await drain(a))).toBe(JSON.stringify(await drain(b)))
  })

  it("respects budget.maxSteps and terminates with STOP_RESEARCH_LIMIT", async () => {
    const engine = new ReasoningEngine({
      ...(await makeEngineOptions(dirC)),
      budget: { maxSteps: 1, maxSources: 40, maxQueries: 40, maxFollowUpRounds: 5 },
      hypotheses: [
        makeHypothesis({
          supportingClaims: [],
          contradictingClaims: ["CLM_001"],
          supportingEvidence: [],
          contradictingEvidence: [],
        }),
      ],
    })
    const state = await engine.run()
    expect(state.lastStopping?.stoppingKind).toBe("STOP_RESEARCH_LIMIT")
    expect(state.status).toBe("STOPPED")
  })

  it("evolves hypotheses through generation/rejection and only touches scoped keys", async () => {
    const engine = new ReasoningEngine({
      ...(await makeEngineOptions(dirC)),
      hypotheses: [
        makeHypothesis({
          supportingClaims: [],
          contradictingClaims: ["CLM_001"],
          supportingEvidence: [],
          contradictingEvidence: [],
        }),
      ],
    })
    const state = await engine.run()
    expect(state.steps.filter((s) => s.action.kind !== "STOP").length).toBeGreaterThan(0)

    const memory = new JsonMemoryStore(dirC)
    const keys = (await memory.keys()).sort()
    expect(keys).toEqual(
      ["hypotheses", "hypothesis-versions", "intelligence", "reasoning", "research"].sort(),
    )

    const versions = await memory.get("hypothesis-versions")
    const rejected = versions.filter((v) => v.status === "REJECTED")
    expect(rejected).toHaveLength(1)
    expect(versions).toHaveLength(3)
    expect((await memory.get("hypotheses")).hypotheses).toHaveLength(1)
    expect(await memory.get("research")).toEqual(makeResearchBundle())
  })

  it("is resumable: no-op resume returns the stored state unchanged", async () => {
    await runHappyPath(dirA)
    const first = new JsonMemoryStore(dirA)
    const before = JSON.stringify(await first.get("reasoning"))
    const again = await new ReasoningEngine(await makeEngineOptions(dirA)).run()
    const stored = (await first.get<{ state: unknown }>("reasoning"))!.state
    expect(JSON.stringify(again)).toBe(JSON.stringify(stored))
    expect(JSON.stringify(await first.get("reasoning"))).toBe(before)
  })

  it("gates hypothesis-touching actions when the approval gate rejects them", async () => {
    const memory = new JsonMemoryStore(dirC)
    const calls: Array<{ stage: string; artifact: unknown }> = []
    const engine = new ReasoningEngine({
      project: "humanity-2",
      question: QUESTION,
      memory,
      agent: new StructuredAgent(new MockLLMProvider(() => null), readPromptFile),
      search: new NoopSearchProvider(),
      research: makeResearchBundle(),
      hypotheses: [
        makeHypothesis({
          supportingClaims: [],
          contradictingClaims: ["CLM_001"],
          supportingEvidence: [],
          contradictingEvidence: [],
        }),
      ],
      referenceDate: REFERENCE_DATE,
      approvals: {
        async review(stage: string, artifact: unknown) {
          calls.push({ stage, artifact })
          return { approved: false, message: "researchable later" }
        },
      },
    })
    const state = await engine.run()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.stage).toBe("reasoning")
    expect(state.steps.some((s) => s.status === "BLOCKED")).toBe(true)
    const versions = await memory.get("hypothesis-versions")
    expect(versions).toHaveLength(1)
  })
})
