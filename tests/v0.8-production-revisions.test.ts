import { ReasoningEngine } from "../src/agents/reasoning/reasoning-engine.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import { HumanApprover } from "../src/core/human-approval.js"
import type { ResearchBundle, Hypothesis } from "../src/core/schemas.js"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore, type MemoryStore } from "../src/core/memory/json-memory.js"
import { runDocumentaryPipeline } from "../src/core/documentary.js"
import { createLLMProvider } from "../src/providers/llm/factory.js"
import { createRevisionGenerator } from "../src/agents/production/revision-generator.js"
import {
  ProductionRevisionEngine,
  REVISION_KEY,
  revisionDiff,
  type RevisionGenerator,
} from "../src/core/production/revisions.js"
import { protectedKeys, PRODUCTION_WRITE_KEYS } from "../src/core/production/write-scope.js"
import { AutoApprover, type ApprovalGate } from "../src/core/pipeline.js"
import { ScopedMemory } from "../src/core/memory/scoped-memory.js"
import type { Narrative } from "../src/core/schemas.js"

let dir: string,
  memory: JsonMemoryStore,
  engine: ProductionRevisionEngine,
  generate: RevisionGenerator
const human: ApprovalGate = { review: async () => ({ approved: true, authority: "human" }) }
const provider = () => createLLMProvider({ provider: "mock" }).provider
async function bytes(keys: readonly string[]) {
  return Object.fromEntries(
    await Promise.all(keys.map(async (key) => [key, await memory.readRaw(key)])),
  )
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-v08-"))
  memory = new JsonMemoryStore(dir)
  await runDocumentaryPipeline({
    provider: provider(),
    memoryDir: dir,
    project: "demo",
    question: "Can humanity become a new species?",
    title: "Demo",
    referenceDate: "2024-06-01T00:00:00.000Z",
  })
  engine = new ProductionRevisionEngine(memory)
  const raw = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
  generate = async (stage, candidate) => {
    const value = await raw(stage, candidate)
    return stage === "narrative" ? { ...(value as Narrative), title: "Revised documentary" } : value
  }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("governed production revisions", () => {
  it("plans are deterministic and read-only, with downstream dependency closure", async () => {
    const before = await bytes(await memory.keys())
    const plan = await engine.plan("narrative")
    expect(plan.stages).toEqual(["narrative", "visual", "selfCheck"])
    expect(await engine.plan("narrative")).toEqual(plan)
    expect(await bytes(await memory.keys())).toEqual(before)
    expect(await memory.readRaw(REVISION_KEY)).toBeNull()
  })
  it("saves baseline, gets fresh human approvals and publishes only after final review", async () => {
    const protectedBefore = await bytes(protectedKeys().filter((k) => k !== "approved"))
    const productionBefore = await bytes(PRODUCTION_WRITE_KEYS)
    const seen: string[] = []
    const gate: ApprovalGate = {
      review: async (stage, value) => {
        seen.push(stage)
        expect(await bytes(PRODUCTION_WRITE_KEYS)).toEqual(productionBefore)
        if (stage === "revision.final")
          expect(JSON.stringify(value)).toContain("Revised documentary")
        return { approved: true, authority: "human" }
      },
    }
    const revision = await engine.apply(await engine.plan("narrative"), generate, gate)
    expect(revision.status).toBe("COMPLETED")
    expect(revision.baseline.narrative?.title).not.toBe("Revised documentary")
    expect((await memory.get<Narrative>("narrative"))?.title).toBe("Revised documentary")
    expect(seen).toEqual([
      "revision.narrative",
      "revision.visual",
      "revision.selfCheck",
      "revision.final",
    ])
    expect(await bytes(protectedKeys().filter((k) => k !== "approved"))).toEqual(protectedBefore)
    expect(revisionDiff(revision)).toContainEqual(
      expect.objectContaining({
        artifact: "narrative",
        path: "/title",
        after: "Revised documentary",
      }),
    )
  })
  it("a crash at a checkpoint reopens that same saved candidate without generation", async () => {
    const plan = await engine.plan("narrative")
    const baseline = await bytes(PRODUCTION_WRITE_KEYS)
    const calls: string[] = []
    const generator: RevisionGenerator = async (stage, draft) => {
      calls.push(stage)
      return generate(stage, draft)
    }
    await expect(
      engine.apply(plan, generator, {
        review: async () => {
          throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    expect(await bytes(PRODUCTION_WRITE_KEYS)).toEqual(baseline)
    const revision = await new ProductionRevisionEngine(memory).resume(generator, human)
    expect(revision.status).toBe("COMPLETED")
    expect(calls).toEqual(["narrative", "visual", "selfCheck"])
    expect(await engine.history()).toHaveLength(1)
  })
  it("does not consume a completed revision twice", async () => {
    const plan = await engine.plan("narrative")
    await engine.apply(plan, generate, human)
    const before = await bytes(await memory.keys())
    await engine.apply(
      plan,
      async () => {
        throw new Error("must not generate")
      },
      {
        review: async () => {
          throw new Error("must not review")
        },
      },
    )
    expect(await bytes(await memory.keys())).toEqual(before)
  })
  it("rejection preserves current production and its historical baseline", async () => {
    const baseline = await bytes(PRODUCTION_WRITE_KEYS)
    await expect(
      engine.apply(await engine.plan("narrative"), generate, {
        review: async () => ({ approved: false, authority: "human" }),
      }),
    ).rejects.toThrow("rejected")
    expect(await bytes(PRODUCTION_WRITE_KEYS)).toEqual(baseline)
    expect((await engine.history())[0]?.status).toBe("REJECTED")
  })
  it("machine approval cannot authorize publishing", async () => {
    const baseline = await bytes(PRODUCTION_WRITE_KEYS)
    await expect(
      engine.apply(await engine.plan("narrative"), generate, new AutoApprover()),
    ).rejects.toThrow("human approval")
    expect(await bytes(PRODUCTION_WRITE_KEYS)).toEqual(baseline)
  })
  it("rejects a stale plan before creating a draft", async () => {
    const plan = await engine.plan("narrative")
    const narrative = (await memory.get<Narrative>("narrative"))!
    await memory.save("narrative", { ...narrative, title: "External edit" })
    await expect(engine.apply(plan, generate, human)).rejects.toThrow("Plan changed")
    expect(await memory.readRaw(REVISION_KEY)).toBeNull()
  })
  it("stops resume on epistemic drift and permits explicitly rejecting the draft", async () => {
    await expect(
      engine.apply(await engine.plan("narrative"), generate, {
        review: async () => {
          throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    await memory.save("claims", { claims: [] })
    await expect(engine.resume(generate, human)).rejects.toThrow("inputs changed")
    await engine.reject()
    expect((await engine.history())[0]?.status).toBe("REJECTED")
  })
  it("context corruption requires context replacement and never reruns cognition", async () => {
    const context = (await memory.get<Record<string, unknown>>("reasoningContext"))!
    await memory.save("reasoningContext", { ...context, question: "Tampered" })
    const plan = await engine.plan()
    expect(plan.stages[0]).toBe("reasoningContext")
    const before = await bytes(protectedKeys().filter((k) => k !== "approved"))
    const revision = await engine.apply(plan, generate, human)
    expect(revision.status).toBe("COMPLETED")
    expect(await bytes(protectedKeys().filter((k) => k !== "approved"))).toEqual(before)
  })
  it("refuses corrupt journal instead of reseeding history", async () => {
    await memory.save(REVISION_KEY, { body: {}, signature: "wrong" })
    await expect(engine.history()).rejects.toThrow("Corrupt")
  })
  it("checks final dependency signatures after manual edits", async () => {
    const gate: ApprovalGate = {
      review: async (stage, value) => {
        const wrapped = value as { artifact: Narrative }
        return stage === "revision.narrative"
          ? {
              approved: true,
              authority: "human",
              replacement: { ...wrapped.artifact, title: "Human edit" },
            }
          : { approved: true, authority: "human" }
      },
    }
    const revision = await engine.apply(await engine.plan("narrative"), generate, gate)
    expect(revision.candidate.narrative?.title).toBe("Human edit")
    expect(
      revision.candidate.production?.staleness.artifacts.every((a) => a.status === "CURRENT"),
    ).toBe(true)
  })
  it("resumes publication after a write committed before its journal checkpoint", async () => {
    const plan = await engine.plan("narrative")
    let failed = false
    const fault: MemoryStore = {
      get: memory.get.bind(memory),
      readRaw: memory.readRaw.bind(memory),
      keys: memory.keys.bind(memory),
      search: memory.search.bind(memory),
      remove: memory.remove.bind(memory),
      save: async (key, value) => {
        await memory.save(key, value)
        if (key === "visual" && !failed) {
          failed = true
          throw new Error("publication crash")
        }
      },
    }
    await expect(new ProductionRevisionEngine(fault).apply(plan, generate, human)).rejects.toThrow(
      "publication crash",
    )
    expect((await engine.history())[0]?.status).toBe("PUBLISHING")
    const revision = await engine.resume(
      async () => {
        throw new Error("no regeneration")
      },
      {
        review: async () => {
          throw new Error("no duplicate approval")
        },
      },
    )
    expect(revision.status).toBe("COMPLETED")
    expect(await engine.history()).toHaveLength(1)
  })
})

describe("revision boundaries and human review", () => {
  it("old pipeline writers refuse a pending draft", async () => {
    await expect(
      engine.apply(await engine.plan("narrative"), generate, {
        review: async () => {
          throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    await expect(
      runDocumentaryPipeline({
        provider: provider(),
        memoryDir: dir,
        question: "different",
        title: "different",
      }),
    ).rejects.toThrow("revision pending")
  })
  it("retains real persisted reasoning and sealed history across context revision", async () => {
    const research = (await memory.get<ResearchBundle>("research"))!
    const hypotheses = (await memory.get<{ hypotheses: Hypothesis[] }>("hypotheses"))!
    await new ReasoningEngine({
      project: "demo",
      question: "Can humanity become a new species?",
      memory,
      agent: new StructuredAgent(provider(), readPromptFile),
      search: new NoopSearchProvider(),
      research,
      hypotheses: hypotheses.hypotheses,
      referenceDate: "2024-06-01T00:00:00.000Z",
      budget: { maxSteps: 1 },
    }).run()
    expect(await memory.readRaw("reasoning-history")).not.toBeNull()
    const before = await bytes(protectedKeys().filter((k) => k !== "approved"))
    const plan = await engine.plan()
    expect(plan.stages[0]).toBe("reasoningContext")
    const revision = await engine.apply(plan, generate, human)
    expect(revision.status).toBe("COMPLETED")
    expect(await bytes(protectedKeys().filter((k) => k !== "approved"))).toEqual(before)
  })
  it("reopens approval on the exact persisted guarded manual replacement", async () => {
    const seen: string[] = []
    let edited = false
    const gate: ApprovalGate = {
      review: async (stage, value) => {
        const wrapped = value as { artifact: Narrative }
        if (stage === "revision.narrative") {
          seen.push(wrapped.artifact.title)
          if (!edited) {
            edited = true
            return {
              approved: true,
              authority: "human",
              replacement: { ...wrapped.artifact, title: "Human title" },
            }
          }
        }
        return { approved: true, authority: "human" }
      },
    }
    await engine.apply(await engine.plan("narrative"), generate, gate)
    expect(seen).toEqual(["Revised documentary", "Human title"])
  })
  it("a second revision preserves the first completed snapshot", async () => {
    await engine.apply(await engine.plan("narrative"), generate, human)
    const first = structuredClone((await engine.history())[0])
    await engine.apply(await engine.plan("visual"), generate, human)
    expect(await engine.history()).toHaveLength(2)
    expect((await engine.history())[0]).toEqual(first)
  })
  it("stale intelligence is recomputed only in memory during revisions", async () => {
    const envelope = (await memory.get<Record<string, unknown>>("intelligence"))!
    await memory.save("intelligence", { ...envelope, inputSignature: "tampered" })
    const raw = await memory.readRaw("intelligence")
    await engine.apply(await engine.plan("narrative"), generate, human)
    expect(await memory.readRaw("intelligence")).toBe(raw)
  })
  it("the human editor receives the artifact rather than the revision wrapper", async () => {
    const plan = await engine.plan("narrative")
    let askCount = 0
    const approver = new HumanApprover(memory, {
      ask: async () =>
        ++askCount === 1
          ? "m"
          : JSON.stringify({ ...(await memory.get<Narrative>("narrative"))!, title: "Edited" }),
      output: () => {},
    })
    const draft = (await engine.history()).at(-1)
    expect(draft).toBeUndefined()
    const artifact = (await memory.get<Narrative>("narrative"))!
    const answer = await approver.review("revision.narrative", {
      revisionId: plan.id,
      artifact,
      diff: [],
    })
    expect((answer.replacement as Narrative).title).toBe("Edited")
    expect((answer.replacement as Record<string, unknown>).revisionId).toBeUndefined()
  })
})

describe("resume plan and generation binding", () => {
  it("rejects a substituted plan with the same ID", async () => {
    const plan = await engine.plan("narrative")
    await expect(
      engine.apply(plan, generate, {
        review: async () => {
          throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    await expect(engine.apply({ ...plan, stages: ["selfCheck"] }, generate, human)).rejects.toThrow(
      "Stored plan differs",
    )
  })
  it("regenerates saved downstream drafts after a newly reviewed upstream edit", async () => {
    const calls: string[] = []
    const generator: RevisionGenerator = async (stage, draft) => {
      calls.push(stage)
      return generate(stage, draft)
    }
    await expect(
      engine.apply(await engine.plan("narrative"), generator, {
        review: async (stage) => {
          if (stage === "revision.final") throw new Error("final crash")
          return { approved: true, authority: "human" }
        },
      }),
    ).rejects.toThrow("final crash")
    const approvals = (await memory.get<Record<string, unknown>>("approved"))!
    delete approvals["REV_0001.narrative"]
    await memory.save("approved", approvals)
    let edited = false
    await engine.resume(generator, {
      review: async (stage, value) => {
        if (stage === "revision.narrative" && !edited) {
          edited = true
          return {
            approved: true,
            authority: "human",
            replacement: {
              ...(value as { artifact: Narrative }).artifact,
              title: "Changed after crash",
            },
          }
        }
        return { approved: true, authority: "human" }
      },
    })
    expect(calls).toEqual(["narrative", "visual", "selfCheck", "visual", "selfCheck"])
    expect((await memory.get<Narrative>("narrative"))?.title).toBe("Changed after crash")
  })
})

it("publication resume verifies actual values even for journaled writes", async () => {
  const original = await memory.get<Narrative>("narrative")
  let failed = false
  const fault: MemoryStore = {
    get: memory.get.bind(memory),
    readRaw: memory.readRaw.bind(memory),
    keys: memory.keys.bind(memory),
    search: memory.search.bind(memory),
    remove: memory.remove.bind(memory),
    save: async (key, value) => {
      await memory.save(key, value)
      if (key === "visual" && !failed) {
        failed = true
        throw new Error("publication crash")
      }
    },
  }
  await expect(
    new ProductionRevisionEngine(fault).apply(await engine.plan("narrative"), generate, human),
  ).rejects.toThrow("publication crash")
  await memory.save("narrative", original)
  const revision = await engine.resume(generate, human)
  expect(revision.status).toBe("COMPLETED")
  expect((await memory.get<Narrative>("narrative"))?.title).toBe("Revised documentary")
})
