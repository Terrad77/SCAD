import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { HumanApprover } from "../src/core/human-approval.js"
import { Pipeline } from "../src/core/pipeline.js"
import type { ApprovalGate } from "../src/core/pipeline.js"
import { makeResearch, makeNarrative } from "./fixtures.js"

let dir: string
let memory: JsonMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-approval-"))
  memory = new JsonMemoryStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("HumanApprover", () => {
  it("auto-approves non-reviewable stages without prompting", async () => {
    const answered: string[] = []
    const approver = new HumanApprover(memory, {
      ask: async () => {
        answered.push("a")
        return "a"
      },
    })
    const decision = await approver.review("claims", { claims: [] })
    expect(decision).toEqual({ approved: true })
    expect(answered).toHaveLength(0)
  })

  it("stores the explicit approval state for a reviewed stage", async () => {
    const approver = new HumanApprover(memory, { ask: async () => "a" })
    const decision = await approver.review("research", makeResearch())
    expect(decision).toEqual({ approved: true })
    const approved = await memory.get<Record<string, unknown>>("approved")
    expect(approved).toHaveProperty("research")
  })

  it("rejects a stage", async () => {
    const approver = new HumanApprover(memory, { ask: async () => "r" })
    const decision = await approver.review("narrative", makeNarrative())
    expect(decision.approved).toBe(false)
    expect(decision.message).toMatch(/Rejected by operator/)
  })

  it("requests regeneration", async () => {
    const approver = new HumanApprover(memory, { ask: async () => "g" })
    const decision = await approver.review("hypotheses", { hypotheses: [] })
    expect(decision.approved).toBe(false)
    expect(decision.regenerate).toBe(true)
  })

  it("returns a hand-edited replacement on modify", async () => {
    const replacement = {
      sources: [{ id: "SRC_EDITED", title: "Edited source", type: "book", reliability: 0.9 }],
      summary: "edited summary",
    }
    const approver = new HumanApprover(memory, {
      ask: async (prompt: string) =>
        prompt.startsWith("Replace") ? JSON.stringify(replacement) : "m",
    })
    const decision = await approver.review("research", makeResearch())
    expect(decision.approved).toBe(true)
    expect(decision.replacement).toEqual(replacement)
  })

  it("retries on an invalid choice and rejects on the next prompt", async () => {
    const answers = ["x", "r"]
    const approver = new HumanApprover(memory, { ask: async () => answers.shift() ?? "r" })
    const decision = await approver.review("selfCheck", {
      critical: [],
      warnings: [],
      info: [],
    })
    expect(decision.approved).toBe(false)
  })
})

describe("Pipeline approval loop", () => {
  it("regenerates the stage until the reviewer approves", async () => {
    // Review: first research response → regenerate, second → approve.
    let researchRuns = 0
    const research = makeResearch()
    const approver: ApprovalGate = {
      async review(stage: string) {
        if (stage !== "research") return { approved: true }
        researchRuns += 1
        return researchRuns === 1 ? { approved: false, regenerate: true } : { approved: true }
      },
    }
    const p = new Pipeline(memory, approver, async (stage) =>
      stage === "research" ? research : { [stage]: [] },
    )
    const artifacts = await p.run()
    expect(artifacts.research).toBeDefined()
    expect(researchRuns).toBe(2)
  })

  it("persists a human-edited replacement artifact", async () => {
    const replacement = makeResearch({ summary: "operator rewrite" })
    const approver: ApprovalGate = {
      async review(stage: string) {
        if (stage !== "research") return { approved: true }
        return { approved: true, replacement }
      },
    }
    const p = new Pipeline(memory, approver, async (stage) =>
      stage === "research" ? makeResearch({ summary: "original" }) : { [stage]: [] },
    )
    const artifacts = await p.run()
    expect((artifacts.research as { summary: string }).summary).toBe("operator rewrite")
    const stored = await memory.get<{ summary: string }>("research")
    expect(stored?.summary).toBe("operator rewrite")
  })
})
