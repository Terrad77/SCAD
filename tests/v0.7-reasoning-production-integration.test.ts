import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import {
  runDocumentaryPipeline,
  type HypothesesWithVerifications,
} from "../src/core/documentary.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { ReasoningEngine } from "../src/agents/reasoning/reasoning-engine.js"
import { readReasoningCycles } from "../src/agents/reasoning/reasoning-repository.js"
import { buildReasoningContext } from "../src/agents/production/reasoning-context.js"
import { ProductionEngine } from "../src/agents/production/production-engine.js"
import { auditProduction } from "../src/core/production/self-check-rules.js"
import { protectedKeys } from "../src/core/production/write-scope.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import type { Narrative, ResearchBundle } from "../src/core/schemas.js"
import { makeHypothesis, makeResearchBundle } from "./fixtures.js"

const DATE = "2024-06-01T00:00:00.000Z"
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const narrative: Narrative = {
  title: "The fossil record",
  logline: "An established finding.",
  thesis: "Evidence supports common ancestry.",
  sections: [
    {
      id: "SEC_001",
      heading: "The finding",
      sentences: [
        {
          id: "SNT_001",
          text: "Humans share a common ancestor with Neanderthals.",
          knowledge: "FACT",
          claimIds: ["CLM_001"],
        },
      ],
    },
  ],
}

function provider() {
  return new MockLLMProvider((request) => {
    if (request.meta?.stage === "narrative") return { text: JSON.stringify(narrative) }
    if (request.meta?.stage === "visual")
      return {
        text: JSON.stringify({
          shots: [
            {
              id: "SHOT_001",
              duration: 5,
              narration: "Common ancestry.",
              description: "A source document.",
              visualType: "ARCHIVE",
              source: "SRC_002",
              narrativeSentenceIds: ["SNT_001"],
            },
          ],
        }),
      }
    return null
  })
}

async function seededCycle() {
  const dir = await mkdtemp(join(tmpdir(), "scad-real-production-"))
  dirs.push(dir)
  const memory = new JsonMemoryStore(dir)
  const research = makeResearchBundle()
  await memory.save("research", research)
  await memory.save("claims", { claims: research.claims })
  await memory.save("factCheck", { assessments: [] })
  const state = await new ReasoningEngine({
    project: "integration",
    question: research.question,
    memory,
    agent: new StructuredAgent(provider(), readPromptFile),
    search: new NoopSearchProvider(),
    research,
    hypotheses: [makeHypothesis()],
    referenceDate: DATE,
    budget: { maxSteps: 1 },
  }).run()
  expect(state.steps.length).toBeGreaterThan(0)
  expect((await readReasoningCycles(memory)).some((cycle) => cycle.status === "COMPLETED")).toBe(
    true,
  )
  return { dir, memory, research }
}

async function protectedBytes(memory: JsonMemoryStore) {
  return Object.fromEntries(
    await Promise.all(protectedKeys().map(async (key) => [key, await memory.readRaw(key)])),
  )
}

describe("persistent reasoning to production", () => {
  it("keeps a genuinely backed FACT and preserves every protected byte on production and resume", async () => {
    const { dir, memory, research } = await seededCycle()
    const before = await protectedBytes(memory)
    const options = {
      provider: provider(),
      memoryDir: dir,
      project: "integration",
      question: research.question,
      title: narrative.title,
      referenceDate: DATE,
    }
    const result = await runDocumentaryPipeline(options)
    expect(await protectedBytes(memory)).toEqual(before)
    expect(result.reasoningContext?.decision.cycleCompleted).toBe(true)
    expect(result.reasoningContext?.reasoningCycleId).not.toBeNull()
    expect(result.reasoningContext?.claims.find((c) => c.claimId === "CLM_001")?.usable).toBe(true)
    expect(result.reasoningContext?.traceRefs.claimTraceEdges).toContainEqual({
      claimId: "CLM_001",
      evidenceIds: ["EV_001", "EV_002"],
      sourceIds: ["SRC_001", "SRC_002"],
      supported: true,
    })
    expect(result.narrative?.sections[0]?.sentences[0]?.knowledge).toBe("FACT")
    expect(result.narrative?.production?.normalizations).toEqual([])
    expect(result.selfCheck?.production?.checks.find((c) => c.id === "TRACEABILITY")?.status).toBe(
      "PASS",
    )
    expect(
      result.selfCheck?.production?.verdict,
      JSON.stringify(result.selfCheck?.production?.checks),
    ).toBe("PASS")
    const engine = new ProductionEngine(memory)
    expect((await engine.staleness(result.reasoningContext ?? null)).stale).toBe(false)
    await runDocumentaryPipeline({ ...options, forceStage: "reasoningContext" })
    expect(await protectedBytes(memory)).toEqual(before)
    expect((await readReasoningCycles(memory)).length).toBe(1)
  })

  it("recomputes stale intelligence read-only when entering production for the first time", async () => {
    const { dir, memory, research } = await seededCycle()
    await memory.save("research", { ...research, evidence: [] })
    const before = await protectedBytes(memory)
    const result = await runDocumentaryPipeline({
      provider: provider(),
      memoryDir: dir,
      project: "integration",
      question: research.question,
      title: narrative.title,
      referenceDate: DATE,
    })
    expect(result.reasoningContext?.traceRefs.intelligenceFreshness).toBe("recomputed")
    expect(result.reasoningContext?.claims[0]?.usable).toBe(false)
    expect(await protectedBytes(memory)).toEqual(before)
  })

  it("reports a corrupted persisted context as stale even when rebuilding it yields healthy data", async () => {
    const { dir, memory, research } = await seededCycle()
    const result = await runDocumentaryPipeline({
      provider: provider(),
      memoryDir: dir,
      project: "integration",
      question: research.question,
      title: narrative.title,
      referenceDate: DATE,
    })
    if (!result.reasoningContext) throw new Error("missing context")
    const corrupted = structuredClone(result.reasoningContext)
    corrupted.epistemicSummary.usableClaimCount += 10
    await memory.save("reasoningContext", corrupted)
    const bytes = await protectedBytes(memory)
    const stale = await new ProductionEngine(memory).staleness(corrupted)
    expect(
      stale.artifacts.every((a) => a.status === "STALE" && a.reason === "CONTEXT_CORRUPT"),
    ).toBe(true)
    expect(stale.autoRegenerate).toBe(false)
    expect(await memory.get("reasoningContext")).toEqual(corrupted)
    expect(await protectedBytes(memory)).toEqual(bytes)
    const narrativeBefore = await memory.readRaw("narrative")
    await expect(
      runDocumentaryPipeline({
        provider: provider(),
        memoryDir: dir,
        project: "integration",
        question: research.question,
        title: narrative.title,
        referenceDate: DATE,
        forceStage: "narrative",
      }),
    ).rejects.toThrow("Reasoning context signature is invalid")
    expect(await memory.readRaw("narrative")).toBe(narrativeBefore)
    expect(await protectedBytes(memory)).toEqual(bytes)
  })

  it("does not certify a visual artifact whose dependency signatures disappeared", async () => {
    const { dir, memory, research } = await seededCycle()
    const result = await runDocumentaryPipeline({
      provider: provider(),
      memoryDir: dir,
      project: "integration",
      question: research.question,
      title: narrative.title,
      referenceDate: DATE,
    })
    if (!result.visual?.production) throw new Error("missing visual provenance")
    await memory.save("visual", {
      ...result.visual,
      production: { ...result.visual.production, dependencies: [] },
    })
    const stale = await new ProductionEngine(memory).staleness(result.reasoningContext ?? null)
    expect(stale.artifacts.find((a) => a.artifact === "visual")).toMatchObject({
      status: "STALE",
      reason: "DEPENDENCY_MISSING",
    })
    expect(stale.autoRegenerate).toBe(false)
  })

  it("recomputes the same intelligence projection using the persisted reasoning budget", async () => {
    const { memory, research } = await seededCycle()
    const hypotheses = await memory.get<HypothesesWithVerifications>("hypotheses")
    const input = {
      project: "integration",
      question: research.question,
      research,
      hypotheses: hypotheses?.hypotheses ?? [],
      verifications: hypotheses?.verifications ?? [],
      referenceDate: DATE,
      memory,
    }
    const fresh = await buildReasoningContext(input)
    await memory.remove("intelligence")
    const before = await protectedBytes(memory)
    const rebuilt = await buildReasoningContext(input)
    expect(rebuilt.traceRefs.intelligenceFreshness).toBe("recomputed")
    expect(rebuilt.inputSignature).toBe(fresh.inputSignature)
    expect(rebuilt.epistemicSummary).toEqual(fresh.epistemicSummary)
    expect(await protectedBytes(memory)).toEqual(before)
  })

  it("resumes a real handoff checkpoint after a crash without rerunning reasoning", async () => {
    const { dir, memory, research } = await seededCycle()
    const before = await protectedBytes(memory)
    const options = {
      provider: provider(),
      memoryDir: dir,
      project: "integration",
      question: research.question,
      title: narrative.title,
      referenceDate: DATE,
    }
    await expect(
      runDocumentaryPipeline({
        ...options,
        approvals: {
          async review(stage) {
            if (stage === "reasoningContext") throw new Error("injected checkpoint crash")
            return { approved: true, authority: "auto" }
          },
        },
      }),
    ).rejects.toThrow("injected checkpoint crash")
    expect(await memory.get("reasoningContext")).not.toBeNull()
    expect(await memory.get("narrative")).toBeNull()
    const reviewed: string[] = []
    const result = await runDocumentaryPipeline({
      ...options,
      approvals: {
        async review(stage) {
          reviewed.push(stage)
          if (stage === "reasoningContext") expect(await memory.get("narrative")).toBeNull()
          return { approved: true, authority: "auto" }
        },
      },
    })
    expect(reviewed.indexOf("reasoningContext")).toBeGreaterThanOrEqual(0)
    expect(reviewed.indexOf("narrative")).toBeGreaterThan(reviewed.indexOf("reasoningContext"))
    expect(result.selfCheck?.production?.verdict).toBe("PASS")
    expect(await protectedBytes(memory)).toEqual(before)
  })

  it.each(["missing-evidence", "missing-source", "unrelated-evidence"] as const)(
    "detects %s through the persisted research and real context builder",
    async (damage) => {
      const { memory, research } = await seededCycle()
      const broken: ResearchBundle = structuredClone(research)
      if (damage === "missing-evidence")
        broken.evidence = broken.evidence.filter((e) => e.id !== "EV_001")
      if (damage === "missing-source")
        broken.sources = broken.sources.filter((s) => s.id !== "SRC_001")
      if (damage === "unrelated-evidence")
        broken.evidence = broken.evidence.map((e) => ({ ...e, supportsClaims: [] }))
      await memory.save("research", broken)
      const before = await protectedBytes(memory)
      const context = await buildReasoningContext({
        project: "integration",
        question: broken.question,
        research: broken,
        hypotheses: [],
        verifications: [],
        referenceDate: DATE,
        memory,
      })
      expect(broken.claims[0]?.status).toBe("SUPPORTED")
      expect(context.traceRefs.claimTraceEdges[0]?.supported).toBe(false)
      const report = auditProduction({ context, narrative, visual: { shots: [] } })
      expect(report.checks.find((c) => c.id === "TRACEABILITY")?.status).toBe("FAIL")
      expect(report.verdict).toBe("FAIL")
      expect(await protectedBytes(memory)).toEqual(before)
    },
  )
})
