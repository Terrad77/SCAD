import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { ReasoningEngine, toReasoningState } from "../src/agents/reasoning/reasoning-engine.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import { MockSearchProvider } from "../src/providers/search/mock-search-provider.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import {
  appendDecision,
  readDecisions,
  readReasoningCycles,
  sealCycle,
} from "../src/agents/reasoning/reasoning-repository.js"
import { importHypotheses, toActiveHypotheses } from "../src/core/reasoning/hypothesis-version.js"
import { verifyPureHypotheses } from "../src/core/reasoning/hypothesis-verification.js"
import { ResearchIntelligenceEngine } from "../src/agents/research/research-intelligence.js"
import { ScopedMemory, readScopeFor, ACTION_WRITE_SCOPE } from "../src/core/memory/scoped-memory.js"
import type { ResearchBundle, ResearchIntelligenceReport } from "../src/core/schemas.js"
import type {
  ReasoningCursor,
  ReasoningCycle,
  ReasoningState,
} from "../src/core/reasoning/types.js"
import { makeHypothesis, makeResearchBundle, makeClaim, makeEvidence } from "./fixtures.js"

const QUESTION = "Can humanity become a new species?"
const REFERENCE_DATE = "2024-01-01T00:00:00.000Z"
const DATE2 = "2024-06-01T00:00:00.000Z"
const REASONING_LIMITS = {
  maxSources: 40,
  maxSubQuestions: 40,
  maxFollowUpRounds: 5,
  maxIterations: 100,
}

const budgetOf = (maxSteps: number) => ({
  maxSteps,
  maxSources: 40,
  maxQueries: 40,
  maxFollowUpRounds: 5,
})

const contradictedHypothesis = () =>
  makeHypothesis({
    supportingClaims: [],
    contradictingClaims: ["CLM_001"],
    supportingEvidence: [],
    contradictingEvidence: [],
  })

const clmTwo = () =>
  makeClaim({
    id: "CLM_002",
    statement: "Modern Africans also carry Neanderthal admixture.",
    evidenceIds: ["EV_001", "EV_002"],
    sources: ["SRC_001", "SRC_002"],
    subquestionIds: ["SUB_Q_002"],
  })

const partialBundle = (): ResearchBundle =>
  makeResearchBundle({
    claims: [
      makeClaim({
        id: "CLM_001",
        statement: "Humans share a common ancestor with Neanderthals.",
        evidenceIds: ["EV_001", "EV_002"],
        sources: ["SRC_001", "SRC_002"],
        subquestionIds: ["SUB_Q_001"],
      }),
      clmTwo(),
    ],
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
        supportsClaims: ["CLM_001", "CLM_002"],
        contradictsClaims: [],
      }),
    ],
  })

const partiallySupported = () =>
  makeHypothesis({
    supportingClaims: ["CLM_001"],
    contradictingClaims: ["CLM_002"],
  })

const gapBundle = (): ResearchBundle =>
  makeResearchBundle({
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

type EngineOptions = Parameters<typeof ReasoningEngine>[0]

let tempDirs: string[] = []

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scad-v06-"))
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
  versions: Parameters<typeof toActiveHypotheses>[0],
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

async function readCursor(memory: JsonMemoryStore): Promise<ReasoningCursor> {
  const raw = await memory.get<{ version: number; state: ReasoningCursor }>("reasoning")
  if (raw === null) throw new Error("missing reasoning cursor")
  return raw.state
}

async function readCycles(memory: JsonMemoryStore): Promise<ReasoningCycle[]> {
  return readReasoningCycles(memory)
}

async function getReport(memory: JsonMemoryStore): Promise<ResearchIntelligenceReport> {
  const raw = await memory.get<unknown>("intelligence")
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "report" in (raw as Record<string, unknown>)
  ) {
    return (raw as { report: ResearchIntelligenceReport }).report
  }
  throw new Error("intelligence envelope missing")
}

async function drain(memory: JsonMemoryStore): Promise<string> {
  const out: Record<string, unknown> = {}
  for (const key of (await memory.keys()).sort()) {
    out[key] = await memory.get(key)
  }
  return JSON.stringify(out)
}

async function drainEpistemic(memory: JsonMemoryStore): Promise<string> {
  const out: Record<string, unknown> = {}
  for (const key of ["research", "hypothesis-versions", "hypotheses", "intelligence"]) {
    out[key] = await memory.get(key)
  }
  return JSON.stringify(out)
}

function legacyReasoningState(): ReasoningState {
  return {
    project: "humanity-2",
    question: QUESTION,
    cycleContext: {
      cycleId: "CYC_001",
      referenceDate: REFERENCE_DATE,
      budget: budgetOf(100),
      stateSignature: "legacy-state-signature",
    },
    steps: [
      {
        id: "STEP_001",
        cycleContext: { cycleId: "CYC_001", referenceDate: REFERENCE_DATE },
        action: { kind: "STOP", stoppingKind: "STOP_CONFIDENT_ENOUGH", reason: "legacy terminal" },
        status: "COMPLETED",
        stateSignatureBefore: "legacy-state-signature",
        stateSignatureAfter: "legacy-state-signature",
        performedAt: REFERENCE_DATE,
        writes: ["reasoning"],
        notes: [],
      },
    ],
    lastStopping: {
      stoppingKind: "STOP_CONFIDENT_ENOUGH",
      reason: "legacy terminal",
      at: REFERENCE_DATE,
    },
    status: "STOPPED",
  }
}

async function seedEpistemic(
  memory: JsonMemoryStore,
  research: ResearchBundle,
  hypotheses: Parameters<typeof importHypotheses>[0],
) {
  const versions = importHypotheses(hypotheses, "STEP_000")
  await memory.save("hypothesis-versions", versions)
  await memory.save("hypotheses", {
    hypotheses,
    verifications: verifyPureHypotheses({ hypotheses, research }),
  })
  return versions
}

describe("v0.6 persistent reasoning regression scenarios (§18)", () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  it("1: same persisted state yields the same next action", async () => {
    const dirA = await tmpDir()
    const dirB = await tmpDir()
    const optsA = await makeOptions(dirA, {
      research: partialBundle(),
      hypotheses: [partiallySupported()],
      budget: budgetOf(4),
    })
    const optsB = await makeOptions(dirB, {
      research: partialBundle(),
      hypotheses: [partiallySupported()],
      budget: budgetOf(4),
    })
    const stateA = await new ReasoningEngine(optsA).run()
    const stateB = await new ReasoningEngine(optsB).run()

    expect(JSON.stringify(stateA)).toBe(JSON.stringify(stateB))
    expect(stateA.steps.length).toBeGreaterThan(1)
    expect(JSON.stringify(await drain(optsA.memory as JsonMemoryStore))).toBe(
      JSON.stringify(await drain(optsB.memory as JsonMemoryStore)),
    )
    expect(JSON.stringify(await readCycles(optsA.memory as JsonMemoryStore))).toBe(
      JSON.stringify(await readCycles(optsB.memory as JsonMemoryStore)),
    )
  })

  it("2: a new cycle does not alter the epistemic state", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const memory = options.memory as JsonMemoryStore
    await new ReasoningEngine(options).run()
    const before = {
      research: await memory.get("research"),
      versions: await memory.get("hypothesis-versions"),
      hypotheses: await memory.get("hypotheses"),
      intelligence: await memory.get("intelligence"),
    }

    await new ReasoningEngine(options).run({ force: true })

    expect(await memory.get("research")).toEqual(before.research)
    expect(await memory.get("hypothesis-versions")).toEqual(before.versions)
    expect(await memory.get("hypotheses")).toEqual(before.hypotheses)
    expect(JSON.stringify(await memory.get("intelligence"))).toBe(
      JSON.stringify(before.intelligence),
    )
    const rows = await readCycles(memory)
    expect(rows.map((r) => r.cycleId)).toEqual(["CYC_001", "CYC_002"])
    expect(rows[1]!.trigger).toBe("explicit-request")
    expect(await memory.get("hypothesis-versions")).toHaveLength(1)
  })

  it("3: previous reasoning history never increases hypothesis confidence", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const research = options.research!
    const baseline = verifyPureHypotheses({
      hypotheses: [makeHypothesis()],
      research,
    })[0]!

    await new ReasoningEngine(options).run()
    await new ReasoningEngine(options).run({ force: true })
    await new ReasoningEngine(options).run({ force: true })

    const memory = options.memory as JsonMemoryStore
    const rows = await readCycles(memory)
    expect(rows).toHaveLength(3)
    const versions = await memory.get("hypothesis-versions")
    expect(versions).toHaveLength(1)
    const after = verifyPureHypotheses({
      hypotheses: toActiveHypotheses(versions ?? []),
      research,
    })[0]!
    expect(after).toEqual(baseline)
    expect(after.confidence).toBe(baseline.confidence)
  })

  it("4: previous LLM output never becomes evidence", async () => {
    const dir = await tmpDir()
    const bare = makeHypothesis({
      supportingClaims: [],
      contradictingClaims: [],
      supportingEvidence: [],
      contradictingEvidence: [],
      researchGaps: [],
    })
    const fabricatingAgent = new StructuredAgent(
      new MockLLMProvider(() => ({
        text: JSON.stringify({ hypothesis: { statement: "MACHINE FABRICATED HYPOTHESIS" } }),
      })),
      readPromptFile,
    )
    const options = await makeOptions(dir, {
      hypotheses: [bare],
      agent: fabricatingAgent,
      budget: budgetOf(2),
    })
    const memory = options.memory as JsonMemoryStore
    const evidenceBaseline = JSON.stringify(options.research!.evidence)
    const claimsBaseline = JSON.stringify(options.research!.claims)

    await new ReasoningEngine(options).run()

    const research = await memory.get<ResearchBundle>("research")
    expect(JSON.stringify(research!.evidence)).toBe(evidenceBaseline)
    expect(JSON.stringify(research!.claims)).toBe(claimsBaseline)

    const versions = (await memory.get("hypothesis-versions")) as Array<{
      hypothesisId: string
      statement: string
      status: string
      reason: string
    }>
    const fabricated = versions.find((v) => v.statement === "MACHINE FABRICATED HYPOTHESIS")
    expect(fabricated).toBeDefined()
    expect(fabricated!.reason).toBe("alternative explanation of HYP_001")

    const verdicts = verifyPureHypotheses({
      hypotheses: toActiveHypotheses(versions as Parameters<typeof toActiveHypotheses>[0]),
      research,
    })
    expect(verdicts.every((v) => v.status === "UNTESTED")).toBe(true)
    expect(verdicts.every((v) => v.rationale.includes("untested"))).toBe(true)
  })

  it("5: sealed cycle history is immutable and outside every action scope", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const memory = options.memory as JsonMemoryStore
    await new ReasoningEngine(options).run()
    const ledgerBefore = JSON.stringify(await memory.get("reasoning-history"))

    await new ReasoningEngine(options).run()
    expect(JSON.stringify(await memory.get("reasoning-history"))).toBe(ledgerBefore)

    const cycles = await readCycles(memory)
    const scoped = new ScopedMemory(memory, readScopeFor("RESEARCH"), true)
    await expect(scoped.save("reasoning-history", { version: 1, cycles })).rejects.toThrow(
      /write-scope violation/,
    )
    await expect(scoped.save("decisions", { version: 1, records: [] })).rejects.toThrow(
      /write-scope violation/,
    )
    await sealCycle(memory, cycles, cycles[0]!)
    expect(JSON.stringify(await memory.get("reasoning-history"))).toBe(ledgerBefore)
  })

  it("6: resuming a truncated RUNNING cursor reproduces the uninterrupted run byte-identically", async () => {
    const dirA = await tmpDir()
    const dirB = await tmpDir()
    const optsA = await makeOptions(dirA, { hypotheses: [contradictedHypothesis()] })
    await new ReasoningEngine(optsA).run()
    const storeA = optsA.memory as JsonMemoryStore
    const reasoningA = await storeA.get<{ state: ReasoningCursor }>("reasoning")
    const cursorA = reasoningA!.state
    const ledgerA = JSON.stringify(await storeA.get("reasoning-history"))

    const storeB = new JsonMemoryStore(dirB)
    for (const key of ["research", "hypotheses", "hypothesis-versions", "intelligence"]) {
      await storeB.save(key, await storeA.get(key))
    }
    const truncatedSteps = cursorA.steps.slice(0, -1)
    const tail = truncatedSteps[truncatedSteps.length - 1]
    const truncated: ReasoningCursor = {
      ...cursorA,
      steps: truncatedSteps,
      nextStepNumber: (tail ? Number(tail.id.slice("STEP_".length)) : 0) + 1,
      lastStopping: null,
      status: "RUNNING",
    }
    await storeB.save("reasoning", { version: 2, state: truncated })

    const optsB = await makeOptions(dirB, { hypotheses: [contradictedHypothesis()] })
    const resumed = await new ReasoningEngine(optsB).run()

    expect(JSON.stringify(resumed)).toBe(JSON.stringify(toReasoningState(cursorA)))
    expect(JSON.stringify(await storeB.get("reasoning"))).toBe(JSON.stringify(reasoningA))
    expect(JSON.stringify(await storeB.get("reasoning-history"))).toBe(ledgerA)
    for (const key of ["hypotheses", "hypothesis-versions", "intelligence", "research"]) {
      expect(JSON.stringify(await storeB.get(key))).toBe(JSON.stringify(await storeA.get(key)))
    }
  })

  it("7: new evidence makes a previously terminal state eligible for a new cycle", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const memory = options.memory as JsonMemoryStore
    const firstRun = await new ReasoningEngine(options).run()
    expect(firstRun.lastStopping?.stoppingKind).toBe("STOP_CONFIDENT_ENOUGH")

    const noop = await new ReasoningEngine(options).run()
    expect(JSON.stringify(noop)).toBe(JSON.stringify(firstRun))
    expect(await readCycles(memory)).toHaveLength(1)

    const research = (await memory.get<ResearchBundle>("research"))!
    research.claims.push(
      makeClaim({
        id: "CLM_003",
        statement: "Prolonged isolation can erode reproductive compatibility.",
        evidenceIds: [],
        sources: [],
        subquestionIds: ["SUB_Q_002"],
        confidence: 0.7,
      }),
    )
    await memory.save("research", research)

    await new ReasoningEngine(options).run()
    const rows = await readCycles(memory)
    expect(rows).toHaveLength(2)
    expect(rows[1]!.trigger).toBe("epistemic-change")
    expect(rows[1]!.endedWithEpistemicSignature).not.toBe(rows[0]!.endedWithEpistemicSignature)
  })

  it("8: repeated STOP is deterministic and appends no history", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const memory = options.memory as JsonMemoryStore
    const first = await new ReasoningEngine(options).run()
    const ledger = JSON.stringify(await memory.get("reasoning-history"))
    const reasoning = JSON.stringify(await memory.get("reasoning"))

    for (let i = 0; i < 2; i++) {
      const again = await new ReasoningEngine(options).run()
      expect(JSON.stringify(again)).toBe(JSON.stringify(first))
    }
    expect(JSON.stringify(await memory.get("reasoning-history"))).toBe(ledger)
    expect(JSON.stringify(await memory.get("reasoning"))).toBe(reasoning)
  })

  it("9: referenceDate is deterministic and explicit", async () => {
    const dirA = await tmpDir()
    const dirB = await tmpDir()
    const runA = await new ReasoningEngine(await makeOptions(dirA, {})).run()
    const runB = await new ReasoningEngine(await makeOptions(dirB, {})).run()
    expect(JSON.stringify(runA)).toBe(JSON.stringify(runB))

    const dirC = await tmpDir()
    const optsC = await makeOptions(dirC, {})
    await new ReasoningEngine(optsC).run()
    const memoryC = optsC.memory as JsonMemoryStore
    await new ReasoningEngine({ ...optsC, referenceDate: DATE2 }).run()
    const rows = await readCycles(memoryC)
    expect(rows[1]!.trigger).toBe("temporal-change")
    expect(rows[1]!.referenceDate).toBe(DATE2)

    await new ReasoningEngine({ ...optsC, referenceDate: undefined }).run()
    expect(await readCycles(memoryC)).toHaveLength(2)
    const cursor = await readCursor(memoryC)
    expect(cursor.referenceDate).toBe(DATE2)
  })

  it("10: missing (or stale) intelligence is recomputed from inputs, never becomes evidence", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const memory = options.memory as JsonMemoryStore
    await new ReasoningEngine(options).run()
    const original = JSON.parse((await memory.readRaw("intelligence"))!) as {
      inputSignature: string
      report: ResearchIntelligenceReport
    }
    await memory.remove("intelligence")

    await new ReasoningEngine(options).run({ force: true })

    const recomputed = JSON.parse((await memory.readRaw("intelligence"))!)
    expect(JSON.stringify(recomputed.report)).toBe(JSON.stringify(original.report))
    expect(recomputed.inputSignature).toBe(original.inputSignature)
    const research = await memory.get<ResearchBundle>("research")
    expect(research).toEqual(options.research!)
  })

  it("11: v0.4/v0.5 projects migrate without corruption", async () => {
    const dirA = await tmpDir()
    const dirB = await tmpDir()

    const research = makeResearchBundle()
    const hypotheses = [makeHypothesis()]
    const memoryA = new JsonMemoryStore(dirA)
    await memoryA.save("research", research)
    const versionsA = await seedEpistemic(memoryA, research, hypotheses)
    await memoryA.save("intelligence", expectedIntelligence(research, versionsA))
    await new ReasoningEngine(await makeOptions(dirA, { memory: memoryA })).run()
    const rowsA = await readCycles(memoryA)
    expect(rowsA.map((r) => r.cycleId)).toEqual(["CYC_001"])
    expect(rowsA[0]!.source).toBe("engine")
    expect(rowsA[0]!.trigger).toBe("first")
    expect(JSON.stringify(await getReport(memoryA))).toBe(
      JSON.stringify(expectedIntelligence(research, versionsA)),
    )

    const memoryB = new JsonMemoryStore(dirB)
    await memoryB.save("research", research)
    const versionsB = await seedEpistemic(memoryB, research, hypotheses)
    await memoryB.save("intelligence", expectedIntelligence(research, versionsB))
    await memoryB.save("reasoning", { version: 1, state: legacyReasoningState() })

    await new ReasoningEngine(await makeOptions(dirB, { memory: memoryB })).run()
    let rows = await readCycles(memoryB)
    expect(rows.map((r) => r.cycleId)).toEqual(["CYC_001"])
    expect(rows[0]!.source).toBe("legacy-v1")
    expect(rows[0]!.trigger).toBe("first")
    expect(rows[0]!.stepIds ?? []).toEqual([])

    await new ReasoningEngine(await makeOptions(dirB, { memory: memoryB })).run({ force: true })
    rows = await readCycles(memoryB)
    expect(rows.map((r) => r.cycleId)).toEqual(["CYC_001", "CYC_002"])
    expect(rows[1]!.trigger).toBe("explicit-request")
    expect(JSON.stringify(await getReport(memoryB))).toBe(
      JSON.stringify(expectedIntelligence(research, versionsB)),
    )
  })

  it("12: a human rejection forecloses the rejected action across cycles at the same signature", async () => {
    const dir = await tmpDir()
    let calls = 0
    const options = await makeOptions(dir, {
      research: partialBundle(),
      hypotheses: [partiallySupported()],
      approvals: {
        async review() {
          calls++
          return { approved: false, message: "human rejects revision" }
        },
      },
    })
    const memory = options.memory as JsonMemoryStore
    await new ReasoningEngine(options).run()

    // Cycle 1: the REVISE was refused exactly once and recorded durably.
    let rows = await readCycles(memory)
    expect(rows.map((r) => r.cycleId)).toEqual(["CYC_001"])
    const firstRevises = rows[0]!.steps.filter((s) => s.action.kind === "REVISE_HYPOTHESIS")
    expect(firstRevises.length).toBeGreaterThan(0)
    expect(firstRevises.every((s) => s.status === "BLOCKED")).toBe(true)
    const rejectionsBefore = (await readDecisions(memory)).filter((d) => d.response === "rejected")
    expect(rejectionsBefore).toHaveLength(calls)
    const callsBefore = calls
    expect(await memory.get("hypothesis-versions")).toHaveLength(1)

    // Forced new cycle at the SAME epistemic signature: the rejected REVISE is
    // foreclosed — it is not re-proposed, not re-asked, not re-recorded.
    await new ReasoningEngine(options).run({ force: true })
    rows = await readCycles(memory)
    expect(rows.map((r) => r.cycleId)).toEqual(["CYC_001", "CYC_002"])
    const secondRevises = rows[1]!.steps.filter((s) => s.action.kind === "REVISE_HYPOTHESIS")
    expect(secondRevises).toHaveLength(0)
    expect(calls).toBe(callsBefore)
    expect((await readDecisions(memory)).filter((d) => d.response === "rejected")).toHaveLength(
      rejectionsBefore.length,
    )
    expect(await memory.get("hypothesis-versions")).toHaveLength(1)
    expect(rows[1]!.stopping?.stoppingKind).toMatch(/^STOP_/)
    expect(rows[1]!.delta.keysWritten.filter((k) => k !== "reasoning")).toEqual([])
    const cursor = await readCursor(memory)
    expect(cursor.consumedDecisionIds).toEqual([])
  })

  it("12b: the foreclosure lifts as soon as the epistemic signature changes", async () => {
    const dir = await tmpDir()
    let calls = 0
    const options = await makeOptions(dir, {
      research: partialBundle(),
      hypotheses: [partiallySupported()],
      approvals: {
        async review() {
          calls++
          return { approved: false, message: "human rejects revision" }
        },
      },
    })
    const memory = options.memory as JsonMemoryStore
    await new ReasoningEngine(options).run()
    const callsAfterRejection = calls
    expect(callsAfterRejection).toBeGreaterThan(0)

    // Same state, forced: foreclosed, no new review.
    await new ReasoningEngine(options).run({ force: true })
    expect(calls).toBe(callsAfterRejection)

    // New evidence (A changes) ⇒ different signature ⇒ the REVISE may be
    // considered again and is refused once more in the new cycle.
    const research = (await memory.get<ResearchBundle>("research"))!
    research.claims.push(
      makeClaim({
        id: "CLM_003",
        statement: "Prolonged isolation can erode reproductive compatibility.",
        evidenceIds: [],
        sources: [],
        subquestionIds: ["SUB_Q_002"],
        confidence: 0.7,
      }),
    )
    await memory.save("research", research)
    await new ReasoningEngine(options).run()

    const rows = await readCycles(memory)
    expect(rows.map((r) => r.cycleId)).toEqual(["CYC_001", "CYC_002", "CYC_003"])
    expect(rows[2]!.trigger).toBe("epistemic-change")
    const thirdRevises = rows[2]!.steps.filter((s) => s.action.kind === "REVISE_HYPOTHESIS")
    expect(thirdRevises.length).toBeGreaterThan(0)
    expect(thirdRevises.every((s) => s.status === "BLOCKED")).toBe(true)
    expect(calls).toBe(callsAfterRejection + 1)
  })

  it("13: state-transition signatures stay consistent with the recorded write scope", async () => {
    const dirA = await tmpDir()
    const dirB = await tmpDir()
    const optsA = await makeOptions(dirA, {
      research: gapBundle(),
      search: new MockSearchProvider(),
      budget: budgetOf(1),
    })
    const optsB = await makeOptions(dirB, {
      research: partialBundle(),
      hypotheses: [contradictedHypothesis()],
      budget: budgetOf(1),
    })
    const stateA = await new ReasoningEngine(optsA).run()
    const stateB = await new ReasoningEngine(optsB).run()
    const memoryA = optsA.memory as JsonMemoryStore
    const memoryB = optsB.memory as JsonMemoryStore

    for (const [state, memory] of [
      [stateA, memoryA],
      [stateB, memoryB],
    ] as Array<[ReturnType<typeof toReasoningState>, JsonMemoryStore]>) {
      for (const step of state.steps) {
        const scope = ACTION_WRITE_SCOPE[step.action.kind]
        expect(step.writes.every((w) => scope.includes(w))).toBe(true)
        if (step.action.kind === "STOP") {
          expect(step.writes).toEqual(["reasoning"])
          expect(step.stateSignatureAfter).toBe(step.stateSignatureBefore)
        }
        if (step.stateSignatureAfter !== step.stateSignatureBefore) {
          expect(step.writes.length).toBeGreaterThan(0)
        }
      }
      const rows = await readCycles(memory)
      const row = rows[0]!
      expect(row.startedWithStateSignature).toBe(row.steps[0]!.stateSignatureBefore)
      const last = row.steps[row.steps.length - 1]!
      expect(row.endedWithStateSignature).toBe(last.stateSignatureAfter)
      expect(row.endedWithStateSignature).toBe(state.cycleContext?.stateSignature)
    }
  })

  it("14: replaying the same persisted state creates no epistemic drift", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const memory = options.memory as JsonMemoryStore
    await new ReasoningEngine(options).run()

    for (let i = 0; i < 3; i++) {
      const cursor = await memory.get("reasoning")
      await memory.save("reasoning", cursor)
    }
    const before = await drain(memory)

    await new ReasoningEngine(options).run()
    expect(await drain(memory)).toBe(before)
  })

  it("15: governance-change opens a cycle without silently mutating belief", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    const memory = options.memory as JsonMemoryStore
    await new ReasoningEngine(options).run()
    const before = {
      research: await memory.get("research"),
      versions: await memory.get("hypothesis-versions"),
      hypotheses: await memory.get("hypotheses"),
      intelligence: await memory.get("intelligence"),
    }
    await appendDecision(memory, [], {
      decisionId: "DEC_001",
      kind: "REQUEST_HUMAN_INPUT",
      subject: "STEP_001",
      response: "answer",
      responseDetail: "adjudicated",
      cycleId: "CYC_001",
      stepId: "STEP_001",
      createdAt: REFERENCE_DATE,
    })

    await new ReasoningEngine(options).run()

    const rows = await readCycles(memory)
    expect(rows.map((r) => r.cycleId)).toEqual(["CYC_001", "CYC_002"])
    expect(rows[1]!.trigger).toBe("governance-change")
    expect(await memory.get("research")).toEqual(before.research)
    expect(await memory.get("hypothesis-versions")).toEqual(before.versions)
    expect(await memory.get("hypotheses")).toEqual(before.hypotheses)
    expect(JSON.stringify(await memory.get("intelligence"))).toBe(
      JSON.stringify(before.intelligence),
    )
    const cursor = await readCursor(memory)
    expect(cursor.consumedDecisionIds).toEqual([])
  })

  it("16: committed effects are never re-executed on resume (search + LLM spies)", async () => {
    const dirR = await tmpDir()
    const dirH = await tmpDir()

    const searchCalls: string[] = []
    const search = {
      name: "counting-mock",
      async search(request: { query: string }) {
        searchCalls.push(request.query)
        return new MockSearchProvider().search(request)
      },
    }
    const optsR = await makeOptions(dirR, {
      research: gapBundle(),
      search,
      hypotheses: [makeHypothesis()],
      budget: budgetOf(1),
    })
    await new ReasoningEngine(optsR).run()
    const memoryR = optsR.memory as JsonMemoryStore
    const baselineR = await drainEpistemic(memoryR)
    const cursorR = await readCursor(memoryR)
    await memoryR.save("reasoning", {
      version: 2,
      state: { ...cursorR, status: "RUNNING", steps: [], nextStepNumber: 1, lastStopping: null },
    })
    await memoryR.save("reasoning-history", {
      version: 1,
      cycles: [
        {
          cycleId: "CYC_001",
          status: "SEEDED",
          trigger: "first",
          referenceDate: REFERENCE_DATE,
          budget: budgetOf(1),
          humanInTheLoop: false,
          startedWithStateSignature: "",
          endedWithStateSignature: "",
          endedWithEpistemicSignature: "",
          steps: [],
          stopping: null,
          delta: {
            producedVersionIds: [],
            supersededVersionIds: [],
            rejectedVersionIds: [],
            keysWritten: [],
          },
          source: "engine",
        },
      ],
    })
    searchCalls.length = 0
    const resumedR = await new ReasoningEngine(optsR).run()
    expect(resumedR.steps[0]!.notes.join(" ")).toContain("recovered")
    expect(searchCalls).toHaveLength(0)
    const researchR = await memoryR.get<{ queries: Array<{ createdAfterStep?: string }> }>(
      "research",
    )
    expect(researchR?.queries.filter((q) => q.createdAfterStep === "STEP_001")).toHaveLength(1)

    const llmCalls: unknown[] = []
    const optsH = await makeOptions(dirH, {
      research: partialBundle(),
      hypotheses: [partiallySupported()],
      agent: new StructuredAgent(
        new MockLLMProvider((request) => {
          llmCalls.push(request)
          return null
        }),
        readPromptFile,
      ),
      budget: budgetOf(1),
    })
    await new ReasoningEngine(optsH).run()
    expect(llmCalls).toHaveLength(1)
    const memoryH = optsH.memory as JsonMemoryStore
    const baselineH = await drainEpistemic(memoryH)
    const cursorH = await readCursor(memoryH)
    await memoryH.save("reasoning", {
      version: 2,
      state: { ...cursorH, status: "RUNNING", steps: [], nextStepNumber: 1, lastStopping: null },
    })
    await memoryH.save("reasoning-history", {
      version: 1,
      cycles: [
        {
          cycleId: "CYC_001",
          status: "SEEDED",
          trigger: "first",
          referenceDate: REFERENCE_DATE,
          budget: budgetOf(1),
          humanInTheLoop: false,
          startedWithStateSignature: "",
          endedWithStateSignature: "",
          endedWithEpistemicSignature: "",
          steps: [],
          stopping: null,
          delta: {
            producedVersionIds: [],
            supersededVersionIds: [],
            rejectedVersionIds: [],
            keysWritten: [],
          },
          source: "engine",
        },
      ],
    })
    llmCalls.length = 0
    const resumedH = await new ReasoningEngine(optsH).run()
    expect(resumedH.steps[0]!.notes.join(" ")).toContain("recovered")
    expect(resumedH.steps[0]!.action.kind).toBe("REVISE_HYPOTHESIS")
    expect(llmCalls).toHaveLength(0)
    const versionsH = (await memoryH.get("hypothesis-versions")) as Array<{ version: number }>
    expect(versionsH).toHaveLength(2)
    expect(versionsH[1]!.version).toBe(2)

    expect(await drainEpistemic(memoryR)).toBe(baselineR)
    expect(await drainEpistemic(memoryH)).toBe(baselineH)
  })
})
