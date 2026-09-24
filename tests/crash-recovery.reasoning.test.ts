import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { ReasoningEngine } from "../src/agents/reasoning/reasoning-engine.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import { MockSearchProvider } from "../src/providers/search/mock-search-provider.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import {
  readReasoningCycles,
  reconcileCursor,
  seedCycleHeader,
  sealCycle,
} from "../src/agents/reasoning/reasoning-repository.js"
import type { ReasoningCursor, ReasoningCycle } from "../src/core/reasoning/types.js"
import { makeHypothesis, makeResearchBundle } from "./fixtures.js"

const QUESTION = "Can humanity become a new species?"
const REFERENCE_DATE = "2024-01-01T00:00:00.000Z"

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

const gapBundle = () =>
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
  const dir = await mkdtemp(join(tmpdir(), "scad-crash-"))
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

async function readCursor(memory: JsonMemoryStore): Promise<ReasoningCursor> {
  const raw = await memory.get<{ version: number; state: ReasoningCursor }>("reasoning")
  if (raw === null) throw new Error("missing reasoning cursor")
  return raw.state
}

async function readCycles(memory: JsonMemoryStore): Promise<ReasoningCycle[]> {
  return readReasoningCycles(memory)
}

async function writeCursor(memory: JsonMemoryStore, cursor: ReasoningCursor): Promise<void> {
  await memory.save("reasoning", { version: 2, state: cursor })
}

async function writeCycles(memory: JsonMemoryStore, cycles: ReasoningCycle[]): Promise<void> {
  await memory.save("reasoning-history", { version: 1, cycles })
}

/** The deterministic pre-seal header a new cycle writes before any action. */
function seededHeader(cycleId: string): ReasoningCycle {
  return {
    cycleId,
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
  }
}

/** Simulates a crash mid-cycle just after an effect committed: the ledger holds
 *  only the seeded header, and the cursor has no recorded steps yet. */
function crashedCursor(original: ReasoningCursor): ReasoningCursor {
  return { ...original, status: "RUNNING", steps: [], nextStepNumber: 1, lastStopping: null }
}

async function drainEpistemic(memory: JsonMemoryStore): Promise<string> {
  const out: Record<string, unknown> = {}
  for (const key of ["research", "hypothesis-versions", "hypotheses", "intelligence"]) {
    out[key] = await memory.get(key)
  }
  return JSON.stringify(out)
}

describe("v0.6 crash-recovery boundaries (§13, §17.13-17, F1-F4, F15-F16)", () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  it("corrupt reasoning JSON is surfaced loudly, never reseeded", async () => {
    const dir = await tmpDir()
    const memory = new JsonMemoryStore(dir)
    await writeFile(join(dir, "reasoning.json"), "{{{{ not json", "utf8")
    const engine = new ReasoningEngine(await makeOptions(dir, { memory }))
    await expect(engine.run()).rejects.toThrow(/corrupt/)
    expect(await memory.readRaw("reasoning")).toContain("not json")
  })

  it("corrupt reasoning-history and decisions JSON are surfaced loudly, never reseeded", async () => {
    const dirHistory = await tmpDir()
    const memoryHistory = new JsonMemoryStore(dirHistory)
    await writeFile(join(dirHistory, "reasoning-history.json"), "[[[[[ broken", "utf8")
    await expect(
      new ReasoningEngine(await makeOptions(dirHistory, { memoryHistory })).run(),
    ).rejects.toThrow(/corrupt/)

    const dirDecisions = await tmpDir()
    const memoryDecisions = new JsonMemoryStore(dirDecisions)
    await writeFile(join(dirDecisions, "decisions.json"), "{ not-an-array", "utf8")
    await expect(
      new ReasoningEngine(await makeOptions(dirDecisions, { memory: memoryDecisions })).run(),
    ).rejects.toThrow(/corrupt/)
  })

  it("an unknown reasoning schema version is rejected, not reinterpreted", async () => {
    const dir = await tmpDir()
    const memory = new JsonMemoryStore(dir)
    await memory.save("reasoning", { version: 99, state: { question: QUESTION } })
    const engine = new ReasoningEngine(await makeOptions(dir, { memory }))
    await expect(engine.run()).rejects.toThrow(/unknown schema version/)
  })

  it("F1: a committed RESEARCH effect without a recorded step is healed, never re-searched", async () => {
    const dir = await tmpDir()
    const calls: string[] = []
    const search = {
      name: "counting-mock",
      async search(request: { query: string }) {
        calls.push(request.query)
        return new MockSearchProvider().search(request)
      },
    }
    const options = await makeOptions(dir, {
      research: gapBundle(),
      search,
      hypotheses: [makeHypothesis()],
      budget: budgetOf(1),
    })
    await new ReasoningEngine(options).run()
    expect(calls).toHaveLength(1)

    const memory = options.memory as JsonMemoryStore
    const baseline = await drainEpistemic(memory)
    const cursor = await readCursor(memory)
    await writeCursor(memory, crashedCursor(cursor))
    await writeCycles(memory, [seededHeader("CYC_001")])

    calls.length = 0
    const resumed = await new ReasoningEngine(options).run()

    const research = await memory.get<{ queries: Array<{ createdAfterStep?: string }> }>("research")
    expect(research?.queries.filter((q) => q.createdAfterStep === "STEP_001")).toHaveLength(1)

    const healed = resumed.steps[0]!
    expect(healed.action.kind).toBe("RESEARCH")
    expect(healed.status).toBe("COMPLETED")
    expect(healed.notes.join(" ")).toContain("recovered")
    expect(resumed.steps[1]!.action).toMatchObject({ kind: "STOP" })
    expect(resumed.lastStopping?.stoppingKind).toBe("STOP_RESEARCH_LIMIT")

    expect(calls).toHaveLength(0)
    expect(await drainEpistemic(memory)).toBe(baseline)
  })

  it("F2: a committed hypothesis version without a recorded step is healed, not re-executed", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {
      hypotheses: [contradictedHypothesis()],
      budget: budgetOf(1),
    })
    await new ReasoningEngine(options).run()

    const memory = options.memory as JsonMemoryStore
    const baseline = await drainEpistemic(memory)
    const cursor = await readCursor(memory)
    await writeCursor(memory, crashedCursor(cursor))
    await writeCycles(memory, [seededHeader("CYC_001")])

    const resumed = await new ReasoningEngine(options).run()

    const healed = resumed.steps[0]!
    expect(healed.action.kind).toBe("REJECT_HYPOTHESIS")
    expect((healed.action as { targetHypothesis: string }).targetHypothesis).toBe("HYP_001")
    expect(healed.status).toBe("COMPLETED")
    expect(healed.notes.join(" ")).toContain("recovered")
    expect(resumed.steps[1]!.action).toMatchObject({ kind: "STOP" })

    const versions =
      await memory.get<Array<{ status: string; version: number }>>("hypothesis-versions")
    expect(versions).toHaveLength(2)
    expect(versions[1]!.status).toBe("REJECTED")
    expect(await drainEpistemic(memory)).toBe(baseline)
  })

  it("the STEP_000 baseline import is never synthesized into a step (no spurious heal)", () => {
    const versions = [
      makeHypothesis({
        reason: "imported from the hypotheses stage",
        createdAfterStep: "STEP_000",
      }),
    ] as unknown as Parameters<typeof reconcileCursor>[2]
    const cursor: ReasoningCursor = {
      sessionId: "SSN_001",
      project: "humanity-2",
      question: QUESTION,
      status: "RUNNING",
      currentCycleId: "CYC_001",
      nextStepNumber: 1,
      previousCycleId: null,
      referenceDate: REFERENCE_DATE,
      budget: budgetOf(100),
      stateSignature: "sig",
      consumedDecisionIds: [],
      steps: [],
      lastStopping: null,
    }
    const result = reconcileCursor(cursor, [], versions, makeResearchBundle(), "sig")
    expect(result.healed).toBe(0)
    expect(result.notes).toEqual([])
  })

  it("a sealed cycle and a seeded header are both idempotent to re-apply", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    await new ReasoningEngine(options).run()
    const memory = options.memory as JsonMemoryStore
    const cycles = await readCycles(memory)
    const row = cycles[0]!
    expect(row.status).toBe("COMPLETED")

    await seedCycleHeader(memory, cycles, row)
    await sealCycle(memory, cycles, { ...row, trigger: "first" })
    expect(JSON.stringify(await readCycles(memory))).toBe(JSON.stringify(cycles))
  })

  it("a pending seal (SEEDED header + STOPPED cursor) completes the row byte-identically", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    await new ReasoningEngine(options).run()
    const memory = options.memory as JsonMemoryStore
    const originalRows = await readCycles(memory)

    await writeCycles(memory, [seededHeader("CYC_001")])
    const resumed = await new ReasoningEngine(options).run()

    expect(resumed.status).toBe("STOPPED")
    const rows = await readCycles(memory)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).toBe(JSON.stringify(originalRows))
  })

  it("cursor loss: a SEEDED cycle seals RECOVERED and a rebuilt terminal stays stable", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    await new ReasoningEngine(options).run()
    const memory = options.memory as JsonMemoryStore

    const second: ReasoningCycle = { ...seededHeader("CYC_002"), trigger: "explicit-request" }
    const rows = await readCycles(memory)
    await writeCycles(memory, [...rows, second])
    await memory.remove("reasoning")

    const recoveredInstanceState = await new ReasoningEngine(options).run()
    expect(recoveredInstanceState.status).toBe("STOPPED")
    let all = await readCycles(memory)
    expect(all.map((c) => c.cycleId)).toEqual(["CYC_001", "CYC_002"])
    expect(all[1]!.status).toBe("RECOVERED")
    expect(all[1]!.endedWithEpistemicSignature).not.toBe("")
    expect(all).toHaveLength(2)

    const forced = await new ReasoningEngine(options).run({ force: true })
    expect(forced.cycleContext?.cycleId).toBe("CYC_003")
    all = await readCycles(memory)
    expect(all.map((c) => c.cycleId)).toEqual(["CYC_001", "CYC_002", "CYC_003"])
    expect(all[1]!.status).toBe("RECOVERED")
    expect(all[2]!.trigger).toBe("explicit-request")
  })

  it("cursor loss after a completed seal rebuilds a byte-identical terminal view", async () => {
    const dir = await tmpDir()
    const options = await makeOptions(dir, {})
    await new ReasoningEngine(options).run()
    const memory = options.memory as JsonMemoryStore
    const firstState = await new ReasoningEngine(options).run()
    const rowsBefore = JSON.stringify(await readCycles(memory))

    await memory.remove("reasoning")
    const rebuilt = await new ReasoningEngine(options).run()

    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(firstState))
    expect(rebuilt.steps).toHaveLength(firstState.steps.length)
    expect(JSON.stringify(await readCycles(memory))).toBe(rowsBefore)
  })
})
