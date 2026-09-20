import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { Pipeline, AutoApprover, PIPELINE_ORDER } from "../src/core/pipeline.js"
import type { ApprovalGate } from "../src/core/pipeline.js"

let dir: string
let memory: JsonMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-pipeline-"))
  memory = new JsonMemoryStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("Pipeline", () => {
  it("runs every stage in order", async () => {
    const p = new Pipeline(memory, new AutoApprover(), async (stage) => ({ stage }))
    await p.run()
    const keys = (await memory.keys()).sort()
    expect(keys).toEqual([...PIPELINE_ORDER].sort())
  })

  it("resumes from the first incomplete stage", async () => {
    await memory.save("research", { done: true })
    await memory.save("claims", { done: true })

    const ran: string[] = []
    const p = new Pipeline(memory, new AutoApprover(), async (stage) => {
      ran.push(stage)
      return { stage }
    })
    await p.run()
    expect(ran).toEqual([...PIPELINE_ORDER].slice(2))
  })

  it("reruns everything when forced", async () => {
    await memory.save("research", { done: true })
    const ran: string[] = []
    const p = new Pipeline(memory, new AutoApprover(), async (stage) => {
      ran.push(stage)
      return { stage }
    })
    await p.run(true)
    expect(ran).toEqual([...PIPELINE_ORDER])
  })

  it("regenerates only the stages listed in forceStages", async () => {
    for (const stage of PIPELINE_ORDER) {
      await memory.save(stage, { done: true })
    }
    const ran: string[] = []
    const p = new Pipeline(memory, new AutoApprover(), async (stage) => {
      ran.push(stage)
      return { stage, regenerated: true }
    })
    await p.run(false, new Set(["narrative", "selfCheck"]))
    expect(ran).toEqual(["narrative", "selfCheck"])
    expect(await memory.get("narrative")).toEqual({ stage: "narrative", regenerated: true })
    expect(await memory.get("selfCheck")).toEqual({ stage: "selfCheck", regenerated: true })
    expect(await memory.get("research")).toEqual({ done: true })
    expect(await memory.get("visual")).toEqual({ done: true })
  })

  it("rejects a stage and stops the pipeline", async () => {
    const p = new Pipeline(memory, new RejectingApprover(["research"]), async (stage) => ({
      stage,
    }))
    await expect(p.run()).rejects.toThrow("rejected")
    expect(await memory.get("research")).toBeNull()
  })

  it("passes context forward between stages", async () => {
    const seen: unknown[] = []
    const p = new Pipeline(memory, new AutoApprover(), async (stage, context) => {
      seen.push(context)
      return { stage }
    })
    await p.run()
    const finalContext = seen.at(-1) as Record<string, unknown>
    expect(Object.keys(finalContext)).toContain("research")
    expect(Object.keys(finalContext)).toContain("narrative")
  })
})

/** Approver used to simulate a rejection by a human reviewer at a given stage. */
class RejectingApprover implements ApprovalGate {
  constructor(private readonly rejectAt: string[]) {}
  async review(stage: string) {
    return this.rejectAt.includes(stage)
      ? { approved: false, message: "needs work" }
      : { approved: true }
  }
}
