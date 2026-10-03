import { ReasoningEngine } from "../src/agents/reasoning/reasoning-engine.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import { readDecisions, readReasoningCycles } from "../src/agents/reasoning/reasoning-repository.js"
import type { ResearchBundle, Hypothesis } from "../src/core/schemas.js"
import type { ReasoningCursor } from "../src/core/reasoning/types.js"
import type { RevisionGenerator } from "../src/core/production/revisions.js"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore, type MemoryStore } from "../src/core/memory/json-memory.js"
import { runDocumentaryPipeline } from "../src/core/documentary.js"
import { createLLMProvider } from "../src/providers/llm/factory.js"
import { ProductionIssueEngine, ISSUE_KEY } from "../src/core/production/issues.js"
import { AutoApprover, type ApprovalGate } from "../src/core/pipeline.js"
import { createRevisionGenerator } from "../src/agents/production/revision-generator.js"
import { ScopedMemory } from "../src/core/memory/scoped-memory.js"
import { ProductionRevisionEngine } from "../src/core/production/revisions.js"
import { protectedKeys } from "../src/core/production/write-scope.js"
import { contentSignature } from "../src/core/production/approval.js"
import type { Narrative, SelfCheckOutput } from "../src/core/schemas.js"
import { HumanApprover } from "../src/core/human-approval.js"

let dir: string, memory: JsonMemoryStore, engine: ProductionIssueEngine
const human: ApprovalGate = { review: async () => ({ approved: true, authority: "human" }) }
const provider = () => createLLMProvider({ provider: "mock" }).provider
const bytes = async (keys: readonly string[]) =>
  Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await memory.readRaw(k)])))
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-v010-"))
  memory = new JsonMemoryStore(dir)
  await runDocumentaryPipeline({
    provider: provider(),
    memoryDir: dir,
    project: "demo",
    question: "Can humanity become a new species?",
    title: "Demo",
    referenceDate: "2024-06-01T00:00:00.000Z",
  })
  engine = new ProductionIssueEngine(memory)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("governed production issues", () => {
  it("listing is read-only; sync is snapshot-bound, idempotent, and preserves protected bytes", async () => {
    const before = await bytes(await memory.keys())
    expect(await engine.list()).toEqual([])
    expect(await bytes(await memory.keys())).toEqual(before)
    const issues = await engine.sync()
    expect(issues.length).toBeGreaterThan(0)
    expect(await engine.sync()).toEqual(issues)
    expect(await bytes(Object.keys(before))).toEqual(before)
  })
  it("rejects auto, missing-authority, edited and rejected approvals without effects", async () => {
    const issue = (await engine.sync())[0]!
    const before = await bytes(await memory.keys())
    for (const gate of [
      new AutoApprover(),
      { review: async () => ({ approved: true }) },
      { review: async () => ({ approved: true, authority: "human" as const, replacement: {} }) },
      { review: async () => ({ approved: false, authority: "human" as const }) },
    ]) {
      await expect(engine.decide(issue.id, "dismiss", "Operator rationale", gate)).rejects.toThrow(
        "human approval",
      )
    }
    expect(await bytes(await memory.keys())).toEqual(before)
  })
  it("defer and dismiss retain history and never certify resolution", async () => {
    const issue = (await engine.sync())[0]!
    expect((await engine.decide(issue.id, "defer", "Await review", human)).status).toBe("DEFERRED")
    const result = await engine.decide(issue.id, "dismiss", "Known diagnostic limitation", human)
    expect(result.status).toBe("DISMISSED")
    expect(result.operations).toHaveLength(2)
    expect(result.verificationSignature).toBeNull()
    await expect(engine.verify(issue.id)).rejects.toThrow("explicit fix")
  })
  it("refuses outdated issues, missing provenance and changed audit contents", async () => {
    const issue = (await engine.sync())[0]!
    const narrative = (await memory.get<Narrative>("narrative"))!
    await memory.save("narrative", { ...narrative, title: "Changed" })
    await expect(engine.decide(issue.id, "dismiss", "Reason", human)).rejects.toThrow("CURRENT")
    await expect(engine.sync()).rejects.toThrow("CURRENT")
  })
  it("fails closed on corrupt journal and corrupt artifacts", async () => {
    await memory.save(ISSUE_KEY, { body: { version: 1, issues: [] }, signature: "bad" })
    await expect(engine.list()).rejects.toThrow("signature")
    await memory.remove(ISSUE_KEY)
    await memory.save("selfCheck", { critical: [], warnings: [], info: [] })
    await expect(engine.sync()).rejects.toThrow()
  })
  it("independently detects diagnostic forgery even with unchanged input/dependencies", async () => {
    const report = (await memory.get<SelfCheckOutput>("selfCheck"))!
    report.production!.diagnostics = []
    await memory.save("selfCheck", report)
    await expect(engine.sync()).rejects.toThrow("independent audit")
  })
  it("does not let an approval callback change the approved dependencies", async () => {
    const issue = (await engine.sync())[0]!
    await expect(
      engine.decide(issue.id, "defer", "Reason", {
        review: async () => {
          const narrative = (await memory.get<Narrative>("narrative"))!
          await memory.save("narrative", { ...narrative, title: "Drift" })
          return { approved: true, authority: "human" }
        },
      }),
    ).rejects.toThrow()
    expect((await engine.list())[0]!.operations).toEqual([])
  })
  it("fix delegates to v0.8 revisions and never closes merely after generation", async () => {
    const issue = (await engine.sync())[0]!
    const before = await bytes(protectedKeys().filter((k) => k !== "approved"))
    const generate = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
    const result = await engine.decide(issue.id, "fix", "Rework production", human, generate)
    expect(result.status).toBe("AWAITING_VERIFICATION")
    expect(result.operations[0]!.revisionId).toBe("REV_0001")
    expect((await new ProductionRevisionEngine(memory).history())[0]!.status).toBe("COMPLETED")
    expect(await bytes(protectedKeys().filter((k) => k !== "approved"))).toEqual(before)
    await expect(engine.verify(issue.id)).rejects.toThrow("not demonstrably")
  })
  it("resumes a crash after authorization without asking the issue checkpoint again", async () => {
    const issue = (await engine.sync())[0]!
    let fail = true
    const wrapper: MemoryStore = {
      get: memory.get.bind(memory),
      readRaw: memory.readRaw.bind(memory),
      keys: memory.keys.bind(memory),
      search: memory.search.bind(memory),
      remove: memory.remove.bind(memory),
      save: async (key, value) => {
        if (
          key === ISSUE_KEY &&
          (value as { body: { issues: Array<{ operations: Array<{ status: string }> }> } }).body
            .issues[0]?.operations[0]?.status === "COMPLETED" &&
          fail
        ) {
          fail = false
          throw new Error("crash")
        }
        return memory.save(key, value)
      },
    }
    const crashing = new ProductionIssueEngine(wrapper)
    await expect(crashing.decide(issue.id, "defer", "Pending review", human)).rejects.toThrow(
      "crash",
    )
    const never: ApprovalGate = {
      review: async () => {
        throw new Error("unexpected checkpoint")
      },
    }
    expect((await engine.resume(issue.id, never)).status).toBe("DEFERRED")
    expect(await engine.resume(issue.id, never)).toEqual((await engine.list())[0])
  })
  it("human issue checkpoint displays rationale and cannot edit or regenerate", async () => {
    let output = ""
    const choices = ["m", "g", "a"]
    const gate = new HumanApprover(memory, {
      ask: async () => choices.shift()!,
      output: (t) => {
        output += t
      },
    })
    const result = await gate.review("issue.decision", { action: "defer", note: "Wait for review" })
    expect(result).toEqual({ approved: true, authority: "human" })
    expect(output).toContain("Wait for review")
    expect(output).toContain("cannot be hand-edited")
  })
  it("signed journal validates schema instead of trusting its digest alone", async () => {
    const body = { version: 99, issues: [] }
    await memory.save(ISSUE_KEY, { body, signature: contentSignature(body) })
    await expect(engine.list()).rejects.toThrow()
  })
})

async function seedReasoning() {
  const research = (await memory.get<ResearchBundle>("research"))!
  const hypotheses = (await memory.get<{ hypotheses: Hypothesis[] }>("hypotheses"))!.hypotheses
  const options = {
    project: "demo",
    question: research.question,
    memory,
    agent: new StructuredAgent(provider(), readPromptFile),
    search: new NoopSearchProvider(),
    research,
    hypotheses,
    referenceDate: "2024-06-01T00:00:00.000Z",
    budget: { maxSteps: 1 },
  }
  await new ReasoningEngine(options).run()
  const revisions = new ProductionRevisionEngine(memory)
  await revisions.apply(
    await revisions.plan("reasoningContext"),
    createRevisionGenerator(new ScopedMemory(memory, new Set()), provider()),
    human,
  )
  return options
}

describe("issue handoff and verification", () => {
  it.each(["research", "reasoning"] as const)(
    "queues %s once in the existing decisions ledger and preserves epistemic bytes",
    async (action) => {
      await seedReasoning()
      const issue = (await engine.sync())[0]!
      const keys = protectedKeys().filter((k) => k !== "approved" && k !== "decisions")
      const before = await bytes(keys)
      const result = await engine.decide(
        issue.id,
        action,
        "Investigate upstream uncertainty",
        human,
      )
      expect(result.status).toBe("AWAITING_VERIFICATION")
      const decisions = await readDecisions(memory)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]!.response).toBe("approved")
      expect(decisions[0]!.proposedAction).toMatchObject({
        diagnosticIsEvidence: false,
        issueId: issue.id,
      })
      await engine.resume(issue.id, human)
      expect(await readDecisions(memory)).toEqual(decisions)
      expect(await bytes(keys)).toEqual(before)
    },
  )
  it("requires a sealed cycle and never answers a paused input checkpoint", async () => {
    const issue = (await engine.sync())[0]!
    await expect(engine.decide(issue.id, "research", "Reason", human)).rejects.toThrow(
      "persisted reasoning",
    )
    await seedReasoning()
    const currentIssue = (await engine.sync()).filter((i) => i.id !== issue.id).at(-1)!
    const stored = (await memory.get<{ version: 2; state: ReasoningCursor }>("reasoning"))!
    await memory.save("reasoning", { ...stored, state: { ...stored.state, status: "PAUSED" } })
    await expect(
      engine.decide(currentIssue.id, "reasoning", "Human request", human),
    ).rejects.toThrow()
    expect(await readDecisions(memory)).toEqual([])
  })
  it("acknowledges a request in one new cycle and does not repeatedly trigger cycles", async () => {
    const options = await seedReasoning()
    const issue = (await engine.sync())[0]!
    const result = await engine.decide(issue.id, "reasoning", "Reconsider explicitly", human)
    const decisionId = result.operations[0]!.decisionId!
    await new ReasoningEngine(options).run()
    const history = await readReasoningCycles(memory)
    expect(history.at(-1)!.issueDecisionIds).toContain(decisionId)
    expect(history.at(-1)!.trigger).toBe("governance-change")
    const before = await bytes(await memory.keys())
    await new ReasoningEngine(options).run()
    expect(await bytes(await memory.keys())).toEqual(before)
  })
  it("a committed decision survives a crash and dependency drift without duplicate effects", async () => {
    await seedReasoning()
    const issue = (await engine.sync())[0]!
    let fail = true
    const wrapper: MemoryStore = {
      get: memory.get.bind(memory),
      readRaw: memory.readRaw.bind(memory),
      keys: memory.keys.bind(memory),
      search: memory.search.bind(memory),
      remove: memory.remove.bind(memory),
      save: async (key, value) => {
        await memory.save(key, value)
        if (key === "decisions" && fail) {
          fail = false
          throw new Error("after decision commit")
        }
      },
    }
    await expect(
      new ProductionIssueEngine(wrapper).decide(issue.id, "research", "Check sources", human),
    ).rejects.toThrow("after decision commit")
    const records = await readDecisions(memory)
    const narrative = (await memory.get<Narrative>("narrative"))!
    await memory.save("narrative", { ...narrative, title: "Later change" })
    const result = await engine.resume(issue.id, human)
    expect(result.status).toBe("AWAITING_VERIFICATION")
    expect(await readDecisions(memory)).toEqual(records)
  })
  it("ledger acknowledgement survives a crash before cursor persistence", async () => {
    const options = await seedReasoning()
    const issue = (await engine.sync())[0]!
    const result = await engine.decide(issue.id, "reasoning", "Explicit new cycle", human)
    const decisionId = result.operations[0]!.decisionId!
    let fail = true
    const wrapper: MemoryStore = {
      get: memory.get.bind(memory),
      readRaw: memory.readRaw.bind(memory),
      keys: memory.keys.bind(memory),
      search: memory.search.bind(memory),
      remove: memory.remove.bind(memory),
      save: async (key, value) => {
        await memory.save(key, value)
        if (key === "reasoning-history" && JSON.stringify(value).includes(decisionId) && fail) {
          fail = false
          throw new Error("after header commit")
        }
      },
    }
    await expect(new ReasoningEngine({ ...options, memory: wrapper }).run()).rejects.toThrow(
      "after header commit",
    )
    await new ReasoningEngine(options).run()
    expect(
      (await readReasoningCycles(memory))
        .flatMap((c) => c.issueDecisionIds ?? [])
        .filter((id) => id === decisionId),
    ).toHaveLength(1)
  })
  it("UNKNOWN cannot close an issue even after its local finding disappears", async () => {
    const issue = (await engine.sync()).find((i) => i.diagnostic.kind === "uncertainty-loss")!
    expect(issue).toBeDefined()
    const base = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
    const generate: RevisionGenerator = async (stage, candidate) => {
      const value = await base(stage, candidate)
      if (stage !== "narrative") return value
      const narrative = value as Narrative
      for (const [index, uncertainty] of candidate.reasoningContext.uncertainties.entries()) {
        const hypothesis = candidate.reasoningContext.activeHypotheses.find(
          (h) => h.hypothesisId === uncertainty.subjectId,
        )
        const claimIds =
          uncertainty.subjectType === "claim"
            ? [uncertainty.subjectId]
            : uncertainty.subjectType === "evidence"
              ? candidate.reasoningContext.traceRefs.claimTraceEdges
                  .filter((e) => e.evidenceIds.includes(uncertainty.subjectId))
                  .map((e) => e.claimId)
              : []
        narrative.sections[0]!.sentences.push({
          id: `SNT_UNCERTAIN_${index}`,
          text:
            hypothesis?.statement ??
            "This subject remains uncertain and requires further evidence.",
          knowledge: "SPECULATION",
          claimIds,
        })
      }
      return narrative
    }
    await engine.decide(issue.id, "fix", "Acknowledge each uncertainty", human, generate)
    await expect(engine.verify(issue.id)).rejects.toThrow("not demonstrably")
  })
  it("links revision checkpoint crash recovery to the authorized issue", async () => {
    const issue = (await engine.sync())[0]!
    const generate = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
    let issueReviews = 0
    const gate: ApprovalGate = {
      review: async (stage) => {
        if (stage === "issue.decision") {
          issueReviews++
          return { approved: true, authority: "human" }
        }
        throw new Error("checkpoint crash")
      },
    }
    await expect(engine.decide(issue.id, "fix", "Fix production", gate, generate)).rejects.toThrow(
      "checkpoint crash",
    )
    expect((await engine.list())[0]!.operations[0]!.status).toBe("PENDING")
    expect((await engine.resume(issue.id, human, generate)).status).toBe("AWAITING_VERIFICATION")
    expect(issueReviews).toBe(1)
  })
  it("a rejected revision cancels its operation without reporting resolution", async () => {
    const issue = (await engine.sync())[0]!
    const generate = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
    const gate: ApprovalGate = {
      review: async (stage) =>
        stage === "issue.decision"
          ? { approved: true, authority: "human" }
          : { approved: false, authority: "human" },
    }
    await expect(
      engine.decide(issue.id, "fix", "Try production fix", gate, generate),
    ).rejects.toThrow()
    const result = await engine.resume(issue.id, human, generate)
    expect(result.status).toBe("OPEN")
    expect(result.operations[0]!.status).toBe("CANCELLED")
  })
})

describe("verified closure and inspection", () => {
  it("resolves repaired traceability only after explicit verification of a current revision", async () => {
    const base = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
    const broken: RevisionGenerator = async (stage, candidate) => {
      const result = await base(stage, candidate)
      if (stage === "narrative")
        (result as Narrative).sections[0]!.sentences[0]!.claimIds.push("CLM_MISSING")
      return result
    }
    const revisions = new ProductionRevisionEngine(memory)
    await revisions.apply(await revisions.plan("narrative"), broken, human)
    const issue = (await engine.sync()).find((i) => i.diagnostic.kind === "traceability")!
    expect(issue).toBeDefined()
    expect(issue.references.sentenceIds.length).toBeGreaterThan(0)
    expect((await engine.inspect(issue.id)).freshness).toBe("CURRENT")
    await engine.decide(issue.id, "fix", "Remove the dangling claim reference", human, base)
    expect((await engine.list()).find((i) => i.id === issue.id)!.status).toBe(
      "AWAITING_VERIFICATION",
    )
    const resolved = await engine.verify(issue.id)
    expect(resolved.status).toBe("RESOLVED")
    expect(resolved.verificationSignature).not.toBe(issue.snapshotSignature)
    expect(await engine.verify(issue.id)).toEqual(resolved)
    expect((await engine.inspect(issue.id)).freshness).toBe("STALE")
  })
  it("inspection retains history and shows unverifiable freshness when production drifts", async () => {
    const issue = (await engine.sync())[0]!
    const before = await bytes(await memory.keys())
    await engine.inspect(issue.id)
    expect(await bytes(await memory.keys())).toEqual(before)
    const narrative = (await memory.get<Narrative>("narrative"))!
    await memory.save("narrative", { ...narrative, title: "Drift" })
    const view = await engine.inspect(issue.id)
    expect(view.issue).toEqual(issue)
    expect(view.freshness).toBe("UNVERIFIABLE")
  })
})

describe("issue approval binding", () => {
  it.each(["auto", "proposal"])("refuses resume after %s approval drift", async (change) => {
    const issue = (await engine.sync())[0]!
    const generate = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
    const gate: ApprovalGate = {
      review: async (stage) => {
        if (stage === "issue.decision") return { approved: true, authority: "human" }
        throw new Error("pause before revision approval")
      },
    }
    await expect(
      engine.decide(issue.id, "fix", "Repair current production", gate, generate),
    ).rejects.toThrow("pause before")
    const pending = (await engine.list())[0]!
    const operation = pending.operations[0]!
    if (change === "auto") {
      const ledger = (await memory.get<Record<string, { authority: string }>>("approved"))!
      ledger[operation.id]!.authority = "auto"
      await memory.save("approved", ledger)
    } else {
      const journal = (await memory.get<{
        body: { version: 1; issues: (typeof pending)[] }
        signature: string
      }>(ISSUE_KEY))!
      journal.body.issues[0]!.operations[0]!.note = "Changed request after approval"
      journal.signature = contentSignature(journal.body)
      await memory.save(ISSUE_KEY, journal)
    }
    const before = await bytes(await memory.keys())
    await expect(engine.resume(issue.id, human, generate)).rejects.toThrow(
      "matching human approval",
    )
    expect(await bytes(await memory.keys())).toEqual(before)
  })
})
