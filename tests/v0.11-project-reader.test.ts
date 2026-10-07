import { updateProjectDetails } from "../src/application/project-details.js"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ProjectReader, SnapshotMemory } from "../src/application/project-reader.js"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { initProject } from "../src/storage/project-store.js"
import { runDocumentaryPipeline } from "../src/core/documentary.js"
import { createLLMProvider } from "../src/providers/llm/factory.js"
import { ProductionIssueEngine } from "../src/core/production/issues.js"
import {
  ProductionRevisionEngine,
  type RevisionGenerator,
} from "../src/core/production/revisions.js"
import { createRevisionGenerator } from "../src/agents/production/revision-generator.js"
import { ScopedMemory } from "../src/core/memory/scoped-memory.js"
import type { Narrative, ResearchBundle, SelfCheckOutput } from "../src/core/schemas.js"
import type { ApprovalGate } from "../src/core/pipeline.js"

let root: string, project: string, memory: JsonMemoryStore, reader: ProjectReader
const human: ApprovalGate = { review: async () => ({ approved: true, authority: "human" }) }
const provider = () => createLLMProvider({ provider: "mock" }).provider
async function allBytes(dir: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      Object.assign(result, await allBytes(join(dir, entry.name), `${prefix}${entry.name}/`))
    else if (entry.isFile())
      result[`${prefix}${entry.name}`] = (await readFile(join(dir, entry.name))).toString("base64")
  }
  return result
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-viewer-reader-"))
  await initProject(root, "demo", "Can humanity become a new species?", "Demo")
  project = join(root, "demo")
  memory = new JsonMemoryStore(join(project, "memory"))
  await runDocumentaryPipeline({
    provider: provider(),
    memoryDir: join(project, "memory"),
    project: "demo",
    question: "Can humanity become a new species?",
    title: "Demo",
    referenceDate: "2024-06-01T00:00:00.000Z",
  })
  reader = new ProjectReader(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("v0.11 project reader", () => {
  it("projects, snapshot, trace, issues and diff preserve every project and output byte", async () => {
    await new ProductionIssueEngine(memory).sync()
    const revisions = new ProductionRevisionEngine(memory)
    await revisions.apply(
      await revisions.plan("narrative"),
      createRevisionGenerator(new ScopedMemory(memory, new Set()), provider()),
      human,
    )
    await writeFile(join(project, "output", "keep.txt"), "Do not rewrite output\r\n")
    const before = await allBytes(root)
    expect((await reader.list())[0]!.id).toBe("demo")
    const view = await reader.read("demo")
    expect(view.mode).toBe("READ_ONLY")
    expect(view.production.auditIntegrity).toBe("MATCH")
    expect(view.production.freshness!.artifacts.every((a) => a.status === "CURRENT")).toBe(true)
    expect(view.liveAudit!.checks.find((c) => c.id === "SCOPE_COMPLIANCE")!.status).toBe("UNKNOWN")
    expect(view.issues.length).toBeGreaterThan(0)
    expect(view.revisions[0]!.status).toBe("COMPLETED")
    const graph = await reader.trace(
      "demo",
      view.narrative!.sections[0]!.sentences[0]!.id,
      view.readVersion,
    )
    expect(graph.nodes.some((n) => n.kind === "evidence")).toBe(true)
    expect(graph.nodes.some((n) => n.kind === "source" && n.status === "FOUND")).toBe(true)
    expect(graph.nodes.some((n) => n.kind === "shot")).toBe(true)
    expect(await allBytes(root)).toEqual(before)
  })
  it("snapshot memory cannot write or remove anything", async () => {
    const store = new SnapshotMemory({ narrative: { raw: '{"title":"Original"}', error: false } })
    await expect(store.save()).rejects.toThrow("read-only")
    await expect(store.remove()).rejects.toThrow("read-only")
    expect(await store.get("narrative")).toEqual({ title: "Original" })
  })
  it("keeps a corrupted project visible and distinguishes missing and corrupt files", async () => {
    await writeFile(join(project, "project.json"), "{broken")
    await writeFile(join(project, "memory", "narrative.json"), "{broken")
    await memory.remove("visual")
    const list = await reader.list()
    expect(list[0]!.status).toBe("CORRUPT")
    const view = await reader.read("demo")
    expect(view.files.narrative!.status).toBe("CORRUPT")
    expect(view.files.visual!.status).toBe("MISSING")
    expect(view.production.freshness).toBeNull()
    expect(view.production.auditIntegrity).toBe("UNVERIFIABLE")
  })
  it("refuses to reinterpret a corrupt ResearchBundle as legacy research", async () => {
    const research = (await memory.get<ResearchBundle>("research"))!
    await memory.save("research", { ...research, evidence: "invalid" })
    expect((await reader.read("demo")).files.research!.status).toBe("CORRUPT")
  })
  it("does not create missing roots or missing issue journals during inspection", async () => {
    expect((await reader.read("demo")).issues).toEqual([])
    expect(await memory.readRaw("production-issues")).toBeNull()
    expect(await new ProjectReader(join(root, "missing")).list()).toEqual([])
    await expect(readdir(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("retries changing snapshots and refuses an endlessly moving project", async () => {
    const path = join(project, "project.json")
    let round = 0
    const once = new ProjectReader(root, {
      afterCapture: async () => {
        if (round++ === 0)
          await writeFile(
            path,
            JSON.stringify({ project: "demo", question: "Updated", title: "Changed" }),
          )
      },
    })
    expect((await once.read("demo")).meta!.question).toBe("Updated")
    const moving = new ProjectReader(root, {
      attempts: 2,
      afterCapture: async () => {
        await writeFile(
          path,
          JSON.stringify({ project: "demo", question: "Moving", title: `Version ${round++}` }),
        )
      },
    })
    await expect(moving.read("demo")).rejects.toMatchObject({
      status: 409,
      code: "UNSTABLE_SNAPSHOT",
    })
  })
  it("rejects a trace request from a previous readVersion", async () => {
    const view = await reader.read("demo")
    const narrative = (await memory.get<Narrative>("narrative"))!
    await memory.save("narrative", { ...narrative, title: "New title" })
    await expect(reader.trace("demo", "SNT_001", view.readVersion)).rejects.toMatchObject({
      code: "VIEW_CHANGED",
    })
  })
  it("preserves exact dangling evidence and source IDs without inventing support", async () => {
    const research = (await memory.get<ResearchBundle>("research"))!
    research.claims[0]!.evidenceIds = ["EVD_MISSING", research.evidence[0]!.id]
    research.evidence[0]!.sourceId = "SRC_MISSING"
    research.evidence[0]!.supportsClaims = []
    await memory.save("research", research)
    const graph = await reader.trace("demo", research.claims[0]!.id)
    expect(graph.nodes.find((n) => n.id === "EVD_MISSING")!.status).toBe("MISSING")
    expect(graph.nodes.find((n) => n.id === "SRC_MISSING")!.status).toBe("MISSING")
    expect(
      graph.edges
        .filter((e) => e.relation === "evidence-reference")
        .every((e) => e.supported === false),
    ).toBe(true)
  })
  it("reports ambiguous IDs rather than selecting an arbitrary node", async () => {
    const research = (await memory.get<ResearchBundle>("research"))!
    research.claims.push(structuredClone(research.claims[0]!))
    await memory.save("research", research)
    const graph = await reader.trace("demo", research.claims[0]!.id)
    expect(graph.nodes[0]!.status).toBe("AMBIGUOUS")
    expect(graph.nodes[0]!.data).toBeNull()
  })
  it("keeps declarations separate from evidence edges", async () => {
    const narrative = (await memory.get<Narrative>("narrative"))!
    narrative.sections[0]!.sentences[0]!.hypothesisIds = ["HYP_MISSING"]
    await memory.save("narrative", narrative)
    const graph = await reader.trace("demo", narrative.sections[0]!.sentences[0]!.id)
    expect(graph.edges.find((e) => e.to === "HYP_MISSING")).toMatchObject({
      relation: "declared-hypothesis",
      supported: null,
    })
    expect(graph.nodes.find((n) => n.id === "HYP_MISSING")!.status).toBe("MISSING")
  })
  it("shows a pending draft and avoids treating partial publication as coherent production", async () => {
    const revisionEngine = new ProductionRevisionEngine(memory)
    const base = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider())
    const changed: RevisionGenerator = async (stage, candidate) => {
      const value = await base(stage, candidate)
      return stage === "narrative" ? { ...(value as Narrative), title: "Revised" } : value
    }
    await expect(
      revisionEngine.apply(await revisionEngine.plan("narrative"), changed, {
        review: async () => {
          throw Error("paused")
        },
      }),
    ).rejects.toThrow("paused")
    expect((await reader.read("demo")).production.publication).toBe("DRAFT")
    const fault = new ScopedMemory(
      memory,
      new Set([
        "narrative",
        "visual",
        "selfCheck",
        "production",
        "reasoningContext",
        "production-revisions",
        "approved",
      ]),
    )
    const originalSave = fault.save.bind(fault)
    fault.save = async (key, value) => {
      if (key === "narrative") throw Error("publication pause")
      return originalSave(key, value)
    }
    await expect(new ProductionRevisionEngine(fault).resume(changed, human)).rejects.toThrow(
      "publication pause",
    )
    const view = await reader.read("demo")
    expect(view.production.publication).toBe("PUBLISHING")
    await expect(
      updateProjectDetails(root, "demo", {
        requestId: "b93e3f0e-a671-49cb-a622-d6b1ea28f43e",
        expectedVersion: view.readVersion,
        title: "Blocked edit",
        question: view.meta!.question,
      }),
    ).rejects.toMatchObject({ code: "PUBLISHING" })
    expect(view.narrative).toBeNull()
    expect(view.production.freshness).toBeNull()
    expect(view.revisions[0]!.diff.length).toBeGreaterThan(0)
    await expect(reader.trace("demo", "SNT_001")).rejects.toMatchObject({ code: "PUBLISHING" })
  })
  it("detects a forged stored audit rather than presenting its verdict as verified", async () => {
    const selfCheck = (await memory.get<SelfCheckOutput>("selfCheck"))!
    selfCheck.production!.diagnostics = []
    await memory.save("selfCheck", selfCheck)
    const view = await reader.read("demo")
    expect(view.production.auditIntegrity).toBe("MISMATCH")
    expect(view.liveAudit!.diagnostics.length).toBeGreaterThan(0)
  })
  it("fails closed on signed journals with invalid signatures", async () => {
    await memory.save("production-revisions", {
      body: { version: 1, revisions: [] },
      signature: "invalid",
    })
    await memory.save("production-issues", {
      body: { version: 1, issues: [] },
      signature: "invalid",
    })
    const view = await reader.read("demo")
    expect(view.files["production-revisions"]!.status).toBe("CORRUPT")
    expect(view.files["production-issues"]!.status).toBe("CORRUPT")
    expect(view.production.freshness).toBeNull()
  })
  it.each(["../demo", "demo/../demo", "C:\\Windows", "demo\\memory", ".env", "CON"])(
    "rejects unsafe project ID %s",
    async (id) => {
      await expect(reader.read(id)).rejects.toMatchObject({ code: "INVALID_PROJECT" })
    },
  )
  it("rejects directory junctions outside the configured root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "scad-outside-"))
    try {
      await symlink(
        outside,
        join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      )
      await expect(reader.read("escape")).rejects.toMatchObject({ code: "UNSAFE_PATH" })
    } finally {
      await rm(join(root, "escape"), { force: true, recursive: true })
      await rm(outside, { force: true, recursive: true })
    }
  })
  it("rejects a memory junction even when its target contains valid project data", async () => {
    const outside = await mkdtemp(join(tmpdir(), "scad-memory-outside-"))
    try {
      await rm(join(project, "memory"), { recursive: true })
      await symlink(
        outside,
        join(project, "memory"),
        process.platform === "win32" ? "junction" : "dir",
      )
      await expect(reader.read("demo")).rejects.toMatchObject({ code: "UNSAFE_PATH" })
    } finally {
      await rm(join(project, "memory"), { force: true, recursive: true })
      await rm(outside, { force: true, recursive: true })
    }
  })
  it("keeps projects with missing metadata discoverable", async () => {
    await rm(join(project, "project.json"))
    expect((await reader.list())[0]!.status).toBe("MISSING")
    expect((await reader.read("demo")).meta).toBeNull()
    await mkdir(join(root, "unrelated"))
    expect(await reader.list()).toHaveLength(1)
  })
})

it("distinguishes invalid JSON from incompatible schema", async () => {
  await writeFile(join(project, "memory", "claims.json"), "{")
  expect((await reader.read("demo")).files.claims!.reason).toContain("JSON syntax")
  await writeFile(join(project, "memory", "claims.json"), JSON.stringify({ claims: "legacy" }))
  const view = await reader.read("demo")
  expect(view.files.claims!.reason).toContain("current schema")
  expect(view.files.claims!.reason).toContain("claims")
})
it("retains standalone claims and unresolved evidence without certifying support", async () => {
  const research = (await memory.get<ResearchBundle>("research"))!
  await memory.save("claims", { claims: research.claims })
  await memory.save("research", { sources: research.sources, summary: "Legacy research" })
  const graph = await reader.trace("demo", research.claims[0]!.id)
  expect(graph.nodes.find((n) => n.id === research.claims[0]!.id)!.status).toBe("FOUND")
  expect(graph.nodes.some((n) => n.kind === "source" && n.status === "FOUND")).toBe(true)
  expect(
    graph.edges
      .filter((e) => e.relation === "evidence-reference")
      .every((e) => e.supported === null),
  ).toBe(true)
  expect(graph.nodes.some((n) => n.status === "UNAVAILABLE")).toBe(true)
  expect(graph.notices.some((n) => n.includes("evidence support is unverified"))).toBe(true)
})
