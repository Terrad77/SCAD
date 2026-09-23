import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { ReasoningEngine } from "../src/agents/reasoning/reasoning-engine.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import { MockSearchProvider } from "../src/providers/search/mock-search-provider.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/providers/llm/llm.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { importHypotheses, toActiveHypotheses } from "../src/core/reasoning/hypothesis-version.js"
import { verifyPureHypotheses } from "../src/core/reasoning/hypothesis-verification.js"
import { ResearchIntelligenceEngine } from "../src/agents/research/research-intelligence.js"
import { detectContradictions } from "../src/agents/research/contradiction-detector.js"
import { analyzeContradictions } from "../src/core/evidence/contradiction-analysis.js"
import type {
  Claim,
  Hypothesis,
  ResearchBundle,
  ResearchIntelligenceReport,
} from "../src/core/schemas.js"
import type { HypothesisVersion } from "../src/core/reasoning/types.js"
import { makeHypothesis, makeResearchBundle, makeClaim, makeEvidence } from "./fixtures.js"

const QUESTION = "Can humanity become a new species?"
const REFERENCE_DATE = "2024-01-01T00:00:00.000Z"
const REASONING_LIMITS = {
  maxSources: 40,
  maxSubQuestions: 40,
  maxFollowUpRounds: 5,
  maxIterations: 100,
}

const contradictedHypothesis = (): Hypothesis =>
  makeHypothesis({
    supportingClaims: [],
    contradictingClaims: ["CLM_001"],
    supportingEvidence: [],
    contradictingEvidence: [],
  })

const clmOne = (): Claim =>
  makeClaim({
    id: "CLM_001",
    statement: "Humans share a common ancestor with Neanderthals.",
    evidenceIds: ["EV_001", "EV_002"],
    sources: ["SRC_001", "SRC_002"],
    subquestionIds: ["SUB_Q_001"],
  })

const clmTwo = (): Claim =>
  makeClaim({
    id: "CLM_002",
    statement: "Modern Africans also carry Neanderthal admixture.",
    evidenceIds: ["EV_002"],
    sources: ["SRC_001", "SRC_002"],
    subquestionIds: ["SUB_Q_002"],
  })

const partialBundle = (): ResearchBundle =>
  makeResearchBundle({
    claims: [clmOne(), clmTwo()],
    evidence: [
      makeEvidence({
        id: "EV_001",
        sourceId: "SRC_001",
        supportsClaims: ["CLM_001"],
        contradictsClaims: [],
      }),
      makeEvidence({
        id: "EV_002",
        sourceId: "SRC_002",
        statement: "Neanderthal admixture is documented in modern genomes.",
        supportsClaims: ["CLM_002"],
        contradictsClaims: [],
      }),
    ],
  })

const partiallySupported = (): Hypothesis =>
  makeHypothesis({
    supportingClaims: ["CLM_001"],
    contradictingClaims: ["CLM_002"],
  })

type EngineOptions = Parameters<typeof ReasoningEngine>[0]

class ThrowingLLMProvider implements LLMProvider {
  readonly name = "throwing"
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    throw new Error("provider unavailable")
  }
}

let tempDirs: string[] = []

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scad-integrity-"))
  tempDirs.push(dir)
  return dir
}

async function makeOptions(dir: string, over: Partial<EngineOptions> = {}): Promise<EngineOptions> {
  const memory = over.memory ?? new JsonMemoryStore(dir)
  const research = over.research ?? makeResearchBundle()
  await memory.save("research", research)
  return {
    project: "humanity-2",
    question: QUESTION,
    memory,
    agent: new StructuredAgent(new MockLLMProvider(() => null), readPromptFile),
    search: new NoopSearchProvider(),
    research,
    hypotheses: [makeHypothesis()],
    referenceDate: REFERENCE_DATE,
    ...over,
  }
}

function expectedIntelligence(
  research: ResearchBundle,
  versions: HypothesisVersion[],
  limits = REASONING_LIMITS,
): ResearchIntelligenceReport {
  return new ResearchIntelligenceEngine({
    research,
    verifications: verifyPureHypotheses({
      hypotheses: toActiveHypotheses(versions),
      research,
    }),
    referenceDate: REFERENCE_DATE,
    limits,
  }).run()
}

async function drain(memory: JsonMemoryStore): Promise<string> {
  const out: Record<string, unknown> = {}
  for (const key of (await memory.keys()).sort()) {
    out[key] = await memory.get(key)
  }
  return JSON.stringify(out)
}

const budgetOf = (maxSteps: number) => ({
  maxSteps,
  maxSources: 40,
  maxQueries: 40,
  maxFollowUpRounds: 5,
})

/** Pre-seeds a deterministic epistemic base (research, versions, wrapper, intelligence). */
async function seedEpistemicBase(dir: string, research: ResearchBundle, hypotheses: Hypothesis[]) {
  const memory = new JsonMemoryStore(dir)
  const versions = importHypotheses(hypotheses, "STEP_000")
  const wrapper = {
    hypotheses,
    verifications: verifyPureHypotheses({ hypotheses, research }),
  }
  const intelligence = expectedIntelligence(research, versions)
  await memory.save("research", research)
  await memory.save("hypothesis-versions", versions)
  await memory.save("hypotheses", wrapper)
  await memory.save("intelligence", intelligence)
  return { memory, versions, wrapper, intelligence }
}

describe("v0.5 epistemic integrity audit", () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  it("STOP never mutates epistemic state and preserves intelligence at the cycle boundary", async () => {
    const dir = await tmpDir()
    const research = makeResearchBundle()
    const hypotheses = [makeHypothesis()] // SUPPORTED -> immediate STOP
    const { memory, versions, wrapper, intelligence } = await seedEpistemicBase(
      dir,
      research,
      hypotheses,
    )

    const engine = new ReasoningEngine(await makeOptions(dir, { memory, research, hypotheses }))
    const state = await engine.run()

    expect(state.status).toBe("STOPPED")
    expect(state.lastStopping?.stoppingKind).toBe("STOP_CONFIDENT_ENOUGH")
    expect(state.steps).toHaveLength(1)
    expect(state.steps[0]!.action.kind).toBe("STOP")
    expect(state.steps[0]!.status).toBe("COMPLETED")
    expect(state.steps[0]!.writes).toEqual(["reasoning"])
    expect(state.steps[0]!.performedAt).toBe(REFERENCE_DATE)

    // Epistemic keys must be byte-identical to the pre-seeded base: the seed is
    // a cycle-boundary no-op once versions exist, and STOP does not rebuild or
    // rewrite intelligence. (Comparisons are JSON-normalized because the store
    // roundtrip collapses -0 to 0.)
    const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    expect(await memory.get("research")).toEqual(normalize(research))
    expect(await memory.get("hypothesis-versions")).toEqual(normalize(versions))
    expect(await memory.get("hypotheses")).toEqual(normalize(wrapper))
    expect(await memory.get("intelligence")).toEqual(normalize(intelligence))
    expect(JSON.stringify(await memory.get("intelligence"))).toBe(JSON.stringify(intelligence))
    expect(JSON.stringify(await memory.get("hypotheses"))).toBe(JSON.stringify(wrapper))
  })

  it("budget.maxSteps lets the last allowed action complete before STOP_RESEARCH_LIMIT", async () => {
    const dir = await tmpDir()
    const memory = await makeOptions(dir, {
      budget: budgetOf(1),
      hypotheses: [contradictedHypothesis()],
    })

    const state = await new ReasoningEngine(memory).run()

    expect(state.steps.map((s) => s.action.kind)).toEqual(["REJECT_HYPOTHESIS", "STOP"])
    expect(state.steps[0]!.status).toBe("COMPLETED")
    expect(state.steps[0]!.writes).toEqual(["hypotheses", "hypothesis-versions", "intelligence"])
    expect(state.steps[1]!.action.stoppingKind).toBe("STOP_RESEARCH_LIMIT")
    expect(state.steps[0]!.performedAt).toBe(REFERENCE_DATE)

    const versions = (await memory.memory.get("hypothesis-versions")) as HypothesisVersion[]
    expect(versions).toHaveLength(2)
    expect(versions[0]!.status).toBe("ACTIVE")
    expect(versions[1]!.status).toBe("REJECTED")
    expect(versions[1]!.reason).toContain("rejected:")

    // Intelligence is rebuilt deterministically and reflects the post-action state.
    const research = await memory.memory.get<ResearchBundle>("research")
    const intelligence = await memory.memory.get<ResearchIntelligenceReport>("intelligence")
    expect(JSON.stringify(intelligence)).toBe(
      JSON.stringify(
        expectedIntelligence(research, versions, { ...REASONING_LIMITS, maxIterations: 1 }),
      ),
    )
  })

  it("a RESEARCH action writes only research+intelligence (engine-level write-scope enforcement)", async () => {
    const dir = await tmpDir()
    const gapBundle = makeResearchBundle({
      contradictions: [],
      gaps: [
        {
          id: "GAP_001",
          question: "What timescale is required for reproductive isolation?",
          importance: 0.9,
          relatedClaims: ["CLM_001"],
          suggestedResearchQueries: ["speciation timescales"],
          subquestionId: "SUB_Q_002",
        },
      ],
    })
    const options = await makeOptions(dir, {
      research: gapBundle,
      search: new MockSearchProvider(),
      budget: budgetOf(1),
    })
    const state = await new ReasoningEngine(options).run()

    expect(state.steps[0]!.action.kind).toBe("RESEARCH")
    const target = state.steps[0]!.action.kind === "RESEARCH" ? state.steps[0]!.action.target : null
    expect(target?.id).toBe("GAP_001")
    expect(state.steps[0]!.status).toBe("COMPLETED")
    expect([...state.steps[0]!.writes].sort()).toEqual(["intelligence", "research"])
    expect(state.steps[1]!.action.stoppingKind).toBe("STOP_RESEARCH_LIMIT")
    expect(state.steps[1]!.writes).toEqual(["reasoning"])
    expect(state.steps.every((s) => s.performedAt === REFERENCE_DATE)).toBe(true)

    const store = options.memory as JsonMemoryStore
    const research = await store.get<ResearchBundle>("research")
    const versions = (await store.get("hypothesis-versions")) as HypothesisVersion[]
    const wrapper = await store.get<{ hypotheses: Hypothesis[] }>("hypotheses")

    // Research grew deterministically (follow-up round) without touching epistemics.
    expect(research.queries.length).toBe(3)
    expect(research.sources.length).toBe(4)
    expect(versions).toHaveLength(1)
    expect(versions[0]!.hypothesisId).toBe("HYP_001")
    expect(wrapper.hypotheses.map((h) => h.id)).toEqual(["HYP_001"])

    // The `approved` governance key is untouched by an auto-approved RESEARCH step.
    expect(((await store.keys()) as string[]).includes("approved")).toBe(false)

    expect(JSON.stringify(await store.get("intelligence"))).toBe(
      JSON.stringify(
        expectedIntelligence(research, versions, { ...REASONING_LIMITS, maxIterations: 1 }),
      ),
    )
  })

  it("a rejected REVISE is blocked once and the active hypothesis is preserved (loop guard terminates)", async () => {
    const dir = await tmpDir()
    const calls: Array<{ stage: string }> = []
    const options = await makeOptions(dir, {
      research: partialBundle(),
      hypotheses: [partiallySupported()],
      approvals: {
        async review(stage: string) {
          calls.push({ stage })
          return { approved: false, message: "human rejects revision" }
        },
      },
    })
    const store = options.memory as JsonMemoryStore
    const state = await new ReasoningEngine(options).run()

    const reviseSteps = state.steps.filter((s) => s.action.kind === "REVISE_HYPOTHESIS")
    expect(reviseSteps).toHaveLength(1)
    expect(reviseSteps[0]!.status).toBe("BLOCKED")
    expect(reviseSteps[0]!.notes).toEqual(["human rejects revision"])
    expect(reviseSteps[0]!.stateSignatureBefore).toBe(reviseSteps[0]!.stateSignatureAfter)
    expect(state.steps[state.steps.length - 1]!.action.kind).toBe("STOP")
    expect(state.lastStopping?.stoppingKind).not.toBe("STOP_RESEARCH_LIMIT")
    expect(calls.length).toBe(1)

    const versions = (await store.get("hypothesis-versions")) as HypothesisVersion[]
    expect(versions).toHaveLength(1) // no v2 was ever created
    expect(versions[0]!.versionId).toBe("HYP_001_V1")
    expect(versions[0]!.status).toBe("ACTIVE")
    const wrapper = await store.get<{ hypotheses: Hypothesis[] }>("hypotheses")
    expect(wrapper.hypotheses.map((h) => h.status)).toEqual(["ACTIVE"])
  })

  it("hypothesis verification is pure (no mutation, idempotent)", async () => {
    const research = makeResearchBundle()
    const hypotheses = [makeHypothesis()]
    const snapshot = structuredClone(hypotheses)

    const verifications = verifyPureHypotheses({ hypotheses, research })
    expect(hypotheses).toEqual(snapshot)
    expect(verifications).toHaveLength(1)
    expect(verifications[0]!.hypothesisId).toBe("HYP_001")
    expect(verifications[0]!.status).toBe("SUPPORTED")
    expect(verifyPureHypotheses({ hypotheses, research })).toEqual(verifications)
  })

  it("intelligence is deterministic, pinned to referenceDate and stable after actions", async () => {
    const dirA = await tmpDir()
    const dirB = await tmpDir()
    const optsA = await makeOptions(dirA, { hypotheses: [contradictedHypothesis()] })
    const optsB = await makeOptions(dirB, { hypotheses: [contradictedHypothesis()] })
    const stateA = await new ReasoningEngine(optsA).run()
    await new ReasoningEngine(optsB).run()

    expect(stateA.steps.length).toBeGreaterThan(1)
    const a = (optsA.memory as JsonMemoryStore).get<ResearchIntelligenceReport>("intelligence")
    const b = (optsB.memory as JsonMemoryStore).get<ResearchIntelligenceReport>("intelligence")
    expect(JSON.stringify(await a)).toBe(JSON.stringify(await b))
    expect((await a)!.generatedAt).toBe(REFERENCE_DATE)

    const versions = (await (optsA.memory as JsonMemoryStore).get(
      "hypothesis-versions",
    )) as HypothesisVersion[]
    const research = await (optsA.memory as JsonMemoryStore).get<ResearchBundle>("research")
    expect(JSON.stringify(await a)).toBe(JSON.stringify(expectedIntelligence(research, versions)))
  })

  it("LLM provider failure degrades to deterministic fallbacks and never corrupts epistemic artifacts", async () => {
    const dirThrow = await tmpDir()
    const dirNull = await tmpDir()

    const runWith = async (dir: string, agent: StructuredAgent) => {
      const options = await makeOptions(dir, {
        research: partialBundle(),
        hypotheses: [partiallySupported()],
        agent,
        budget: budgetOf(1),
      })
      const state = await new ReasoningEngine(options).run()
      return { options, state }
    }

    const throwing = await runWith(
      dirThrow,
      new StructuredAgent(new ThrowingLLMProvider(), readPromptFile),
    )
    const nulled = await runWith(
      dirNull,
      new StructuredAgent(new MockLLMProvider(() => null), readPromptFile),
    )

    // Byte-identical persistent state regardless of how the LLM fails.
    expect(JSON.stringify(throwing.state)).toBe(JSON.stringify(nulled.state))
    expect(await drain(throwing.options.memory as JsonMemoryStore)).toBe(
      await drain(nulled.options.memory as JsonMemoryStore),
    )

    // Deterministic fallback revision, no fabrication into research.
    const store = throwing.options.memory as JsonMemoryStore
    const research = await store.get<ResearchBundle>("research")
    expect(research).toEqual(partialBundle())
    const versions = (await store.get("hypothesis-versions")) as HypothesisVersion[]
    expect(versions).toHaveLength(2)
    expect(versions[1]!.status).toBe("UNTESTED")
    expect(versions[1]!.statement).toContain("— revised:")
    expect(versions[1]!.statement).toContain("average supporting evidence confidence 0.85")
    expect(versions[1]!.supportingEvidence).toEqual(["EV_001", "EV_002"])
    expect(versions[1]!.contradictingEvidence).toEqual(["EV_002"])

    expect(JSON.stringify(await store.get("intelligence"))).toBe(
      JSON.stringify(
        expectedIntelligence(research, versions, { ...REASONING_LIMITS, maxIterations: 1 }),
      ),
    )
  })

  it("a human rejection of REJECT_HYPOTHESIS writes no epistemic state", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {
      hypotheses: [contradictedHypothesis()],
      approvals: {
        async review() {
          return { approved: false, message: "operator disagrees" }
        },
      },
    })
    const store = options.memory as JsonMemoryStore
    const state = await new ReasoningEngine(options).run()

    const rejects = state.steps.filter((s) => s.action.kind === "REJECT_HYPOTHESIS")
    expect(rejects).toHaveLength(1)
    expect(rejects[0]!.status).toBe("BLOCKED")
    expect(state.steps[state.steps.length - 1]!.action.kind).toBe("STOP")
    expect(state.lastStopping?.stoppingKind).toBe("STOP_CONFIDENT_ENOUGH")

    const versions = (await store.get("hypothesis-versions")) as HypothesisVersion[]
    expect(versions).toHaveLength(1)
    expect(versions[0]!.status).toBe("ACTIVE")
    expect(versions.every((v) => v.status !== "REJECTED")).toBe(true)
    const wrapper = await store.get<{ hypotheses: Hypothesis[] }>("hypotheses")
    expect(wrapper.hypotheses.map((h) => h.id)).toEqual(["HYP_001"])
    expect(wrapper.hypotheses[0]!.status).toBe("ACTIVE")
    const research = await store.get<ResearchBundle>("research")
    expect(research).toEqual(makeResearchBundle())
  })

  it("a resumed cycle is byte-identical to the uninterrupted run", async () => {
    const dirA = await tmpDir()
    const dirB = await tmpDir()

    const optsA = await makeOptions(dirA, { hypotheses: [contradictedHypothesis()] })
    await new ReasoningEngine(optsA).run()
    const storeA = optsA.memory as JsonMemoryStore
    const reasoningA = await storeA.get<{ state: unknown }>("reasoning")
    const stateA = reasoningA!.state as {
      steps: unknown[]
      lastStopping: unknown
      status: string
      cycleContext: unknown
    }

    // dirB: identical epistemic base, reasoning truncated to before the final STOP.
    const storeB = new JsonMemoryStore(dirB)
    for (const key of ["research", "hypotheses", "hypothesis-versions", "intelligence"]) {
      await storeB.save(key, await storeA.get(key))
    }
    const truncated = {
      ...stateA,
      steps: stateA.steps.slice(0, -1),
      lastStopping: null,
      status: "RUNNING",
    }
    await storeB.save("reasoning", { version: 1, state: truncated })

    const optsB = await makeOptions(dirB, { hypotheses: [contradictedHypothesis()] })
    const resumed = await new ReasoningEngine(optsB).run()

    expect(JSON.stringify(resumed)).toBe(JSON.stringify(stateA))
    expect(JSON.stringify(await storeB.get("reasoning"))).toBe(JSON.stringify(reasoningA))
    for (const key of ["hypotheses", "hypothesis-versions", "intelligence", "research"]) {
      expect(JSON.stringify(await storeB.get(key))).toBe(JSON.stringify(await storeA.get(key)))
    }
  })

  it("every recorded step resolves its targets against the evidence chain", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, { hypotheses: [contradictedHypothesis()] })
    const store = options.memory as JsonMemoryStore
    const state = await new ReasoningEngine(options).run()

    const research = await store.get<ResearchBundle>("research")
    const versions = (await store.get("hypothesis-versions")) as HypothesisVersion[]
    const hypIds = new Set(versions.map((v) => v.hypothesisId))
    const gapIds = new Set(research.gaps.map((g) => g.id))
    const subIds = new Set(research.plan.subQuestions.map((s) => s.id))
    const claimIds = new Set(research.claims.map((c) => c.id))
    const evidenceIds = new Set(research.evidence.map((e) => e.id))

    for (const step of state.steps) {
      if (step.action.kind === "RESEARCH") {
        const t = step.action.target
        if (t.subject === "gap") expect(gapIds.has(t.id)).toBe(true)
        if (t.subject === "subquestion") expect(subIds.has(t.id)).toBe(true)
        if (t.subject === "evidence") expect(evidenceIds.has(t.id)).toBe(true)
      }
      if (step.action.kind === "REVISE_HYPOTHESIS" || step.action.kind === "REJECT_HYPOTHESIS") {
        expect(hypIds.has(step.action.targetHypothesis)).toBe(true)
      }
      if (step.action.kind === "GENERATE_HYPOTHESIS" && step.action.targetHypothesis) {
        expect(hypIds.has(step.action.targetHypothesis)).toBe(true)
      }
      expect(step.performedAt).toBe(REFERENCE_DATE)
    }

    for (const version of versions) {
      for (const cid of [...version.supportingClaims, ...version.contradictingClaims]) {
        expect(claimIds.has(cid)).toBe(true)
      }
      for (const eid of [...version.supportingEvidence, ...version.contradictingEvidence]) {
        expect(evidenceIds.has(eid)).toBe(true)
      }
    }
  })

  it("multiple hypotheses evolve independently without forcing a single winner", async () => {
    const dir = await tmpDir()
    const emphasized = makeHypothesis({
      id: "HYP_001",
      statement: "Geographic isolation could drive reproductive divergence.",
    })
    const contradicted = makeHypothesis({
      id: "HYP_002",
      statement: "Interbreeding continues to homogenize human populations.",
      supportingClaims: [],
      contradictingClaims: ["CLM_001"],
      supportingEvidence: [],
      contradictingEvidence: [],
    })
    const options = await makeOptions(dir, { hypotheses: [emphasized, contradicted] })
    const store = options.memory as JsonMemoryStore
    const state = await new ReasoningEngine(options).run()

    // Nothing ever targeted HYP_001; only HYP_002 was rejected.
    for (const step of state.steps) {
      if (step.action.kind === "REVISE_HYPOTHESIS" || step.action.kind === "REJECT_HYPOTHESIS") {
        expect(step.action.targetHypothesis).toBe("HYP_002")
      }
    }
    const versions = (await store.get("hypothesis-versions")) as HypothesisVersion[]
    const h1 = versions.filter((v) => v.hypothesisId === "HYP_001")
    const h2 = versions.filter((v) => v.hypothesisId === "HYP_002")
    expect(h1).toHaveLength(1)
    expect(h1[0]!.status).toBe("ACTIVE")
    expect(h1[0]!.statement).toBe("Geographic isolation could drive reproductive divergence.")
    expect(h2).toHaveLength(2)
    expect(h2[1]!.status).toBe("REJECTED")

    // H1 stands on its own with an unchanged independent verdict.
    const wrapper = await store.get<{ hypotheses: Hypothesis[] }>("hypotheses")
    expect(wrapper.hypotheses.map((h) => h.id)).toEqual(["HYP_001"])
    const verdict = verifyPureHypotheses({
      hypotheses: wrapper.hypotheses,
      research: await store.get<ResearchBundle>("research"),
    })
    expect(verdict[0]!.hypothesisId).toBe("HYP_001")
    expect(verdict[0]!.status).toBe("SUPPORTED")
    expect(state.lastStopping?.stoppingKind).toBe("STOP_CONFIDENT_ENOUGH")
  })

  it("contextual differences are never treated as contradictions (no RESEARCH escalation)", async () => {
    const dir = await tmpDir()
    const europeans: Claim = makeClaim({
      id: "CLM_001",
      statement: "Europeans carry Neanderthal admixture.",
      evidenceIds: ["EV_001"],
      sources: ["SRC_001", "SRC_002"],
      subquestionIds: ["SUB_Q_001"],
      confidence: 0.7,
    })
    const africans: Claim = makeClaim({
      id: "CLM_002",
      statement: "Africans carry no Neanderthal admixture.",
      evidenceIds: ["EV_002"],
      sources: ["SRC_001", "SRC_002"],
      subquestionIds: ["SUB_Q_002"],
      confidence: 0.7,
    })
    const claims = [europeans, africans]

    const detected = detectContradictions(claims)
    expect(detected).toHaveLength(1)
    expect(detected[0]!.classification).toBe("DIFFERENT_POPULATION")
    expect(detected[0]!.severity).toBe("LOW")

    const analysis = analyzeContradictions(
      detected,
      claims,
      [
        makeEvidence({
          id: "EV_001",
          sourceId: "SRC_001",
          supportsClaims: ["CLM_001"],
          contradictsClaims: [],
        }),
        makeEvidence({
          id: "EV_002",
          sourceId: "SRC_002",
          supportsClaims: ["CLM_002"],
          contradictsClaims: [],
        }),
      ],
      new Map(),
    )
    expect(analysis[0]!.analysis).toBe("POPULATION_CONTEXT")

    const bundle = makeResearchBundle({
      claims,
      contradictions: detected,
      gaps: [],
      evidence: [
        makeEvidence({
          id: "EV_001",
          sourceId: "SRC_001",
          supportsClaims: ["CLM_001"],
          contradictsClaims: [],
        }),
        makeEvidence({
          id: "EV_002",
          sourceId: "SRC_002",
          supportsClaims: ["CLM_002"],
          contradictsClaims: [],
        }),
      ],
    })
    const options = await makeOptions(dir, {
      research: bundle,
      hypotheses: [
        makeHypothesis({
          id: "HYP_001",
          supportingClaims: ["CLM_001"],
          contradictingClaims: [],
        }),
      ],
    })
    const store = options.memory as JsonMemoryStore
    const state = await new ReasoningEngine(options).run()

    expect(state.steps.some((s) => s.action.kind === "RESEARCH")).toBe(false)
    expect(state.steps[0]!.action.kind).toBe("STOP")
    expect(state.lastStopping?.stoppingKind).not.toBe("STOP_RESEARCH_LIMIT")

    const intelligence = await store.get<ResearchIntelligenceReport>("intelligence")
    expect(intelligence!.unresolvedContradictions).toHaveLength(0)
    const contradictions = intelligence!.contradictions.filter(
      (c) => c.contradictionId === "CTR_001",
    )
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]!.analysis).toBe("POPULATION_CONTEXT")
    expect(contradictions[0]!.severity).toBe("LOW")
    expect(state.steps.every((s) => s.performedAt === REFERENCE_DATE)).toBe(true)
  })
})
