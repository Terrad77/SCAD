import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import type { MemoryStore } from "../src/core/memory/json-memory.js"
import { ScopedMemory } from "../src/core/memory/scoped-memory.js"
import { Pipeline, AutoApprover, PIPELINE_ORDER } from "../src/core/pipeline.js"
import type { ApprovalDecision, ApprovalGate, PipelineRunner } from "../src/core/pipeline.js"
import {
  ApprovalLedger,
  contentSignature,
  dependencySignature,
} from "../src/core/production/approval.js"

/**
 * v0.7 (H7) — crash on an approval must not skip the checkpoint on resume.
 *
 * The defect: the pipeline saved an artifact BEFORE reviewing it and treated the
 * file's presence as proof the stage was done. A crash inside the review
 * therefore resumed with an unapproved artifact already passed downstream — for
 * `reasoningContext`, a production handoff no human ever agreed to.
 *
 * Every test here injects a real fault (a thrown error) at one of the three
 * points where a crash can land, then resumes with a fresh pipeline and checks
 * what the operator is asked about.
 *
 * Two semantics the assertions rely on:
 *   - a dependency signature covers the ENTIRE upstream chain, so a changed
 *     input invalidates every approval downstream of it, not just the stage
 *     immediately after;
 *   - a stage is skipped only on a matching human approval for the exact content
 *     AND the exact upstream it was built from.
 */

let dir: string
let memory: JsonMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-h7-"))
  memory = new JsonMemoryStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const artifactFor = (stage: string) => ({ stage, payload: `content of ${stage}` })

/** A gate that records what it was asked about and answers with a script. */
class ScriptedGate implements ApprovalGate {
  readonly seen: string[] = []
  constructor(
    private readonly answers: (stage: string) => ApprovalDecision = () => ({
      approved: true,
      authority: "human",
    }),
  ) {}

  async review(stage: string, _artifact: unknown): Promise<ApprovalDecision> {
    this.seen.push(stage)
    return this.answers(stage)
  }

  /** Stages reviewed more than once. */
  repeated(): string[] {
    return [...new Set(this.seen.filter((s, i) => this.seen.indexOf(s) !== i))]
  }
}

/** Seeds every stage's artifact, so a resume exercises review logic only. */
const seedAllArtifacts = async (): Promise<void> => {
  for (const stage of PIPELINE_ORDER) await memory.save(stage, artifactFor(stage))
}

const neverRan: PipelineRunner = async () => {
  throw new Error("runner must not be reached: the artifact already exists")
}

/** A pipeline over a fully seeded store, to answer "which checkpoints reopened?". */
const resumeOver = async (gate: ApprovalGate): Promise<string[]> => {
  const p = new Pipeline(memory, gate, neverRan)
  await p.run()
  return (gate as ScriptedGate).seen
}

/** Seed every artifact and approve it once, so later resumes isolate review logic. */
const approveSeeded = async (): Promise<void> => {
  await seedAllArtifacts()
  await new Pipeline(memory, new ScriptedGate(), neverRan).run()
}

/**
 * A store that dies on the nth write of `key` — the only honest way to hit the
 * window between persisting an artifact and binding an approval to it, which no
 * amount of gating can otherwise expose.
 */
class CrashingStore implements MemoryStore {
  private countdown: number
  constructor(
    private readonly inner: MemoryStore,
    private readonly key: string,
    on: number,
  ) {
    this.countdown = on
  }

  async save<T>(key: string, value: T): Promise<void> {
    if (key === this.key && --this.countdown === 0) throw new Error(`crash writing "${key}"`)
    return this.inner.save(key, value)
  }
  get<T>(key: string): Promise<T | null> {
    return this.inner.get<T>(key)
  }
  readRaw(key: string): Promise<string | null> {
    return this.inner.readRaw(key)
  }
  search(query: string): Promise<unknown[]> {
    return this.inner.search(query)
  }
  keys(): Promise<string[]> {
    return this.inner.keys()
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(key)
  }
}

describe("H7 — approval is a recorded fact, not an artifact's existence", () => {
  it("records only completed writes, excluding a failed production save", async () => {
    const observed: string[] = []
    const pipeline = new Pipeline(
      new CrashingStore(memory, "narrative", 1),
      new AutoApprover(),
      async (stage) => artifactFor(stage),
      {},
      (stage, key) => observed.push(`${stage}:${key}`),
    )
    await expect(pipeline.run()).rejects.toThrow('crash writing "narrative"')
    expect(observed).toContain("reasoningContext:reasoningContext")
    expect(observed).not.toContain("narrative:narrative")
    expect(observed).not.toContain("selfCheck:selfCheck")
    expect(await memory.get("narrative")).toBeNull()
  })
  it("re-reviews every persisted artifact that carries no approval", async () => {
    await seedAllArtifacts()
    expect(await memory.get("approved")).toBeNull()

    // Full artifacts on disk, zero approvals: the state a crash inside the first
    // review leaves behind. Every checkpoint must reopen — and nothing may be
    // regenerated, or the operator would be reviewing a different artifact.
    expect(await resumeOver(new ScriptedGate())).toEqual([...PIPELINE_ORDER])
  })

  it("skips every checkpoint once matching human approvals are on record", async () => {
    await approveSeeded()
    expect(await resumeOver(new ScriptedGate())).toEqual([])
  })

  it("reopens only the stage whose content changed", async () => {
    await approveSeeded()

    // `narrative` is edited behind the pipeline's back. Its own content no longer
    // matches its approval, and everything built from it inherits the mismatch.
    await memory.save("narrative", { stage: "narrative", payload: "edited behind our back" })

    expect(await resumeOver(new ScriptedGate())).toEqual(["narrative", "visual", "selfCheck"])
  })

  it("reopens the whole downstream chain when an upstream artifact changes", async () => {
    await approveSeeded()

    // `reasoningContext` is the production handoff. Every production artifact
    // was approved against THIS version of it, so none of them survive the swap.
    await memory.save("reasoningContext", {
      stage: "reasoningContext",
      payload: "a different handoff",
    })

    expect(await resumeOver(new ScriptedGate())).toEqual([
      "reasoningContext",
      "narrative",
      "visual",
      "selfCheck",
    ])
  })

  it("treats a legacy timestamp-only approval as no approval", async () => {
    // Pre-H7 `approved.json` held only `{ approvedAt }`, with nothing tying it to
    // content. Honouring it would reintroduce the original defect.
    await seedAllArtifacts()
    await memory.save("approved", { research: { approvedAt: "2024-01-01T00:00:00.000Z" } })

    expect(await resumeOver(new ScriptedGate())).toEqual([...PIPELINE_ORDER])
  })
})

describe("H7 — crash recovery", () => {
  it("reopens the checkpoint when the crash lands before the approval is recorded", async () => {
    await seedAllArtifacts()
    const crashing = new ScriptedGate(() => {
      throw new Error("terminated before approval")
    })
    await expect(new Pipeline(memory, crashing, neverRan).run()).rejects.toThrow(/terminated/)

    // The artifact survived, the decision did not.
    expect(await memory.get("research")).not.toBeNull()
    expect(await memory.get("approved")).toBeNull()

    expect(await resumeOver(new ScriptedGate())).toEqual([...PIPELINE_ORDER])
  })

  it("does not reopen a checkpoint whose approval was recorded before the crash", async () => {
    // Approve `research`, then die on the next stage. The decision for
    // `research` is durable and must not be asked twice.
    const crashing = new ScriptedGate((stage) => {
      if (stage === "claims") throw new Error("crashed after research was approved")
      return { approved: true, authority: "human" }
    })
    await expect(
      new Pipeline(memory, crashing, async (stage) => artifactFor(stage)).run(),
    ).rejects.toThrow(/crashed/)

    expect(Object.keys((await memory.get<Record<string, unknown>>("approved")) ?? {})).toEqual([
      "research",
    ])

    const resumed = new ScriptedGate()
    await new Pipeline(memory, resumed, async (stage) => artifactFor(stage)).run()

    // `research` is skipped; everything from the crash onward is reviewed once.
    expect(resumed.seen).toEqual([...PIPELINE_ORDER].slice(1))
    expect(resumed.repeated()).toEqual([])
  })

  it("reopens a hand-edited artifact whose approval was never bound", async () => {
    await seedAllArtifacts()
    const edited = { stage: "research", payload: "hand-edited" }

    // The operator's replacement is persisted, then the process dies on the very
    // next write — the approval. The edit is on disk and unconfirmed, which is
    // the one state a file's presence could previously be mistaken for consent.
    const gate = new ScriptedGate((stage) =>
      stage === "research"
        ? { approved: true, replacement: edited, authority: "human" }
        : { approved: true, authority: "human" },
    )
    await expect(
      new Pipeline(new CrashingStore(memory, "approved", 1), gate, neverRan).run(),
    ).rejects.toThrow(/crash writing "approved"/)

    expect(await memory.get("research")).toEqual(edited)
    expect(await memory.get("approved")).toBeNull()

    // The operator is asked about the artifact that is actually on disk — the
    // edited one — instead of the edit being silently accepted.
    expect(await resumeOver(new ScriptedGate())).toEqual([...PIPELINE_ORDER])
  })

  it("holds the production side until the handoff is actually approved", async () => {
    // The H7 report's scenario: a crash inside the reasoningContext review must
    // not leave production consuming an unapproved handoff.
    const order: string[] = []
    const crashing = new ScriptedGate((stage) => {
      order.push(`review:${stage}`)
      if (stage === "reasoningContext") throw new Error("crash inside the context review")
      return { approved: true, authority: "human" }
    })

    await expect(
      new Pipeline(memory, crashing, async (stage) => {
        order.push(`run:${stage}`)
        return artifactFor(stage)
      }).run(),
    ).rejects.toThrow(/crash inside/)

    // Nothing past the failed checkpoint ran at all.
    expect(order).not.toContain("run:narrative")
    expect(order).not.toContain("run:visual")
    expect(order).not.toContain("run:selfCheck")
    expect(await memory.get("narrative")).toBeNull()
    expect(await memory.get("visual")).toBeNull()

    // On resume the context is approved first, and only then does production run.
    order.length = 0
    await new Pipeline(
      memory,
      new ScriptedGate((stage) => {
        order.push(`review:${stage}`)
        return { approved: true, authority: "human" }
      }),
      async (stage) => {
        order.push(`run:${stage}`)
        return artifactFor(stage)
      },
    ).run()

    expect(order.indexOf("review:reasoningContext")).toBeGreaterThanOrEqual(0)
    expect(order).not.toContain("run:reasoningContext")
    expect(order.indexOf("run:narrative")).toBeGreaterThan(order.indexOf("review:reasoningContext"))
    expect(await memory.get("narrative")).toEqual(artifactFor("narrative"))
  })
})

describe("H7 — human and machine decisions stay distinguishable", () => {
  it("records an auto approval nowhere, so governance is only human-authored", async () => {
    await new Pipeline(memory, new AutoApprover(), async (stage) => artifactFor(stage)).run()
    expect(await memory.get("approved")).toBeNull()
  })

  it("does not let an auto decision satisfy a later human checkpoint", async () => {
    // An automated run leaves artifacts but no approvals, so a human opening the
    // project afterwards is still asked about every one of them.
    await new Pipeline(memory, new AutoApprover(), async (stage) => artifactFor(stage)).run()
    expect(await memory.get("approved")).toBeNull()

    const human = new ScriptedGate()
    await new Pipeline(memory, human, neverRan).run()
    expect(human.seen).toEqual([...PIPELINE_ORDER])
  })

  it("binds a human approval to the exact content and the exact upstream chain", async () => {
    await approveSeeded()
    const ledger = new ApprovalLedger(memory)

    const narrative = await ledger.get("narrative")
    expect(narrative).not.toBeNull()
    expect(narrative!.authority).toBe("human")
    expect(narrative!.modified).toBe(false)
    expect(narrative!.artifactSignature).toBe(contentSignature(artifactFor("narrative")))

    // The full upstream chain, not just the immediate parent: an approval is
    // consent to "this, built from exactly this".
    const upstream = Object.fromEntries(
      PIPELINE_ORDER.slice(0, PIPELINE_ORDER.indexOf("narrative")).map((s) => [s, artifactFor(s)]),
    )
    expect(narrative!.dependencySignature).toBe(dependencySignature(upstream))
  })

  it("marks a hand-edited approval and signs the edited content", async () => {
    const edited = { stage: "research", payload: "operator rewrote this" }
    await new Pipeline(
      memory,
      new ScriptedGate((stage) =>
        stage === "research"
          ? { approved: true, replacement: edited, authority: "human" }
          : { approved: true, authority: "human" },
      ),
      async (stage) => artifactFor(stage),
    ).run()

    const record = await new ApprovalLedger(memory).get("research")
    expect(record!.modified).toBe(true)
    expect(record!.artifactSignature).toBe(contentSignature(edited))

    // And the approval now covers the edit, so a resume does not re-ask.
    const resumed = new ScriptedGate()
    await new Pipeline(memory, resumed, neverRan).run()
    expect(resumed.seen).toEqual([])
  })

  it("refuses to honour an approval whose content or dependency identity moved", async () => {
    const ledger = new ApprovalLedger(memory)
    const proposal = {
      stage: "narrative",
      artifactSignature: contentSignature(artifactFor("narrative")),
      dependencySignature: dependencySignature({
        reasoningContext: artifactFor("reasoningContext"),
      }),
    }
    await ledger.record({
      stage: proposal.stage,
      artifactSignature: proposal.artifactSignature,
      dependencySignature: proposal.dependencySignature,
      decidedAt: "2024-01-01T00:00:00.000Z",
      authority: "human",
      modified: false,
    })

    expect(await ledger.isApproved(proposal)).toBe(true)
    expect(
      await ledger.isApproved({
        ...proposal,
        dependencySignature: dependencySignature({ reasoningContext: { changed: true } }),
      }),
    ).toBe(false)
    expect(await ledger.isApproved({ ...proposal, artifactSignature: "0".repeat(64) })).toBe(false)
    expect(await ledger.isApproved({ ...proposal, stage: "visual" })).toBe(false)
  })

  it("cannot be forged by a production stage", async () => {
    // Recording an approval is itself a governance write, so it goes through the
    // governance scope: a production stage cannot forge a sign-off.
    await approveSeeded()

    const productionScope = new ScopedMemory(memory, new Set(["narrative", "visual"]))
    await expect(
      productionScope.save("approved", { narrative: { approvedAt: "2024-01-01T00:00:00.000Z" } }),
    ).rejects.toThrow(/write-scope violation/)

    const untouched = await new ApprovalLedger(memory).get("narrative")
    expect(untouched!.artifactSignature).toBe(contentSignature(artifactFor("narrative")))
  })

  it("does not honour a machine-authored record as human approval", async () => {
    await approveSeeded()
    const ledger = new ApprovalLedger(memory)
    const record = await ledger.get("narrative")
    if (!record) throw new Error("missing approval")
    await ledger.record({ ...record, authority: "auto" })
    expect(await ledger.isApproved(record)).toBe(false)
    expect(await resumeOver(new ScriptedGate())).toEqual(["narrative"])
  })
})
