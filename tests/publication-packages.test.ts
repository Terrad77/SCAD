import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest"
import { mkdtemp, cp, rm, readFile, writeFile, readdir, mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { initProject } from "../src/storage/project-store.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { ProjectRuns } from "../src/application/project-runs.js"
import { runDocumentaryPipeline } from "../src/core/documentary.js"
import { createLLMProvider } from "../src/providers/llm/factory.js"
import {
  readPublication,
  changePublication,
  exportPublication,
  comparePublication,
  type PublicationRequest,
  type PublicationState,
} from "../src/application/publication-packages.js"
import { inspectPublication, type PublicationDocument } from "../src/core/publication.js"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
import { ProductionRevisionEngine } from "../src/core/production/revisions.js"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { createRevisionGenerator } from "../src/agents/production/revision-generator.js"
import { ScopedMemory } from "../src/core/memory/scoped-memory.js"

let template: string
let root: string
let server: ViewerServer | undefined
const provider = () => createLLMProvider({ provider: "mock" }).provider
beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), "scad-pub-template-"))
  await initProject(template, "film", "How does evolution work?", "MOCK publication fixture")
  const jobs = new ProjectRuns(template, async (options) => {
    // Explicit test-only human gate; never an application default or real editorial consent.
    await runDocumentaryPipeline({
      ...options,
      provider: provider(),
      referenceDate: "2026-10-16T00:00:00.000Z",
      approvals: { review: async () => ({ approved: true, authority: "human" }) },
    })
  })
  await jobs.start("film", {
    requestId: randomUUID(),
    expectedVersion: (await new ProjectReader(template).read("film")).readVersion,
  })
  await jobs.close()
  expect((await jobs.status("film")).run?.state).toBe("COMPLETED")
}, 20000)
afterAll(async () => {
  await rm(template, { recursive: true, force: true })
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-pub-"))
  await cp(template, root, { recursive: true })
})
afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true })
})
const bytes = async () =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(join(root, "film", "memory")))
        .sort()
        .map(async (file) => [file, await readFile(join(root, "film", "memory", file), "utf8")]),
    ),
  )
function filled(state: PublicationState): PublicationDocument {
  const source = state.sources[0]!
  const sentence = source.snapshot.narrative.sections
    .flatMap((section) => section.sentences)
    .find((sentence) => sentence.claimIds.length)!
  const value = (text: string) => ({ text, sentenceIds: [sentence.id] })
  return {
    audienceQuestion: "What remains uncertain?",
    titles: [value("An unresolved question"), value("A second perspective")],
    summary: value("Explore the saved hypothesis without resolving it."),
    description: value("A documentary investigation of the saved material."),
    thumbnailBrief: value("A question mark over a branching lineage; no factual promise."),
    chapters: [value("The open question")],
  }
}
async function create(document?: PublicationDocument) {
  const state = await readPublication(root, "film")
  expect(state.sources.length).toBeGreaterThan(0)
  const request: PublicationRequest = {
    action: "CREATE",
    requestId: randomUUID(),
    packageId: randomUUID(),
    expectedProjectVersion: state.projectVersion,
    expectedJournalVersion: state.journalVersion,
    sourceId: state.sources[0]!.id,
    document: document ?? filled(state),
  }
  await changePublication(root, "film", request)
  return request
}
async function decision(
  action: "APPROVE" | "REJECT" = "APPROVE",
  reason = "Test-only packaging review",
) {
  const state = await readPublication(root, "film")
  const item = state.packages.at(-1)!
  return {
    action,
    reason,
    requestId: randomUUID(),
    packageId: item.packageId,
    revision: item.revision,
    expectedProjectVersion: state.projectVersion,
    expectedJournalVersion: state.journalVersion,
    artifactSignature: item.signature,
    dependencySignature: item.source.dependencySignature,
  } as const
}
describe("isolated publication packages", () => {
  it("compares bound saved fields without copying historical consent or writing any files", async () => {
    await create()
    await changePublication(root, "film", await decision())
    const first = await readPublication(root, "film")
    const item = first.packages[0]!
    const document = structuredClone(item.document)
    document.description.text = "Changed editorial description"
    document.summary.sentenceIds = ["MISSING_REVIEW_LINK"]
    document.titles.push({ text: "Additional title", sentenceIds: [] })
    await changePublication(root, "film", {
      action: "SAVE",
      requestId: randomUUID(),
      packageId: item.packageId,
      revision: 1,
      expectedProjectVersion: first.projectVersion,
      expectedJournalVersion: first.journalVersion,
      document,
    })
    const state = await readPublication(root, "film")
    const path = join(root, "film", "publication", "journal.json")
    const before = await readFile(path, "utf8"),
      protectedBytes = await bytes()
    const result = await comparePublication(
      root,
      "film",
      item.packageId,
      "1",
      "2",
      state.journalVersion,
    )
    expect(result.before.decision?.action).toBe("APPROVE")
    expect(result.before.currentlyApproved).toBe(false)
    expect(result.after.decision).toBeNull()
    expect(result.after.currentlyApproved).toBe(false)
    expect(result.fields).toContainEqual(
      expect.objectContaining({ label: "Description", textChanged: true, linksChanged: false }),
    )
    expect(result.fields).toContainEqual(
      expect.objectContaining({ label: "Summary", textChanged: false, linksChanged: true }),
    )
    expect(result.fields).toContainEqual(
      expect.objectContaining({ label: "Title 3", status: "ADDED", before: null }),
    )
    expect(result.after.findings).toContainEqual(
      expect.objectContaining({ status: "FAIL", code: "MATERIAL_LINK" }),
    )
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await bytes()).toEqual(protectedBytes)
    await expect(
      comparePublication(root, "film", item.packageId, "1", "2", "a".repeat(64)),
    ).rejects.toMatchObject({ code: "PUBLICATION_CHANGED" })
    await expect(
      comparePublication(root, "film", item.packageId, "1", "99", state.journalVersion),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      comparePublication(root, "film", "../escape", "1", "2", state.journalVersion),
    ).rejects.toMatchObject({ status: 400 })
  }, 20000)
  it("uses a genuinely completed mock run, preserves protected bytes and exports bound consent without certifying semantics", async () => {
    const before = await bytes()
    await create()
    let state = await readPublication(root, "film")
    expect(state.packages[0]?.freshness).toBe("CURRENT")
    expect(state.packages[0]?.findings).toContainEqual(
      expect.objectContaining({ code: "SEMANTIC_SUPPORT", status: "UNKNOWN" }),
    )
    await changePublication(root, "film", await decision())
    state = await readPublication(root, "film")
    const item = state.packages[0]!
    const exported = JSON.parse(
      (await exportPublication(root, "film", item.packageId, "1", state.journalVersion, "json"))
        .content,
    )
    expect(exported.status).toBe("APPROVED PACKAGING COPY")
    expect(exported.decision.authority).toBe("human")
    expect(exported.source.snapshot.selfCheck).toEqual(item.source.snapshot.selfCheck)
    expect(exported.traces[0].sentences[0].claims[0].evidence[0].sourceId).toBeTruthy()
    expect(exported.traces[0].sentences[0].knowledge).toBe(
      item.source.snapshot.narrative.sections[0]!.sentences[0]!.knowledge,
    )
    const md = (
      await exportPublication(root, "film", item.packageId, "1", state.journalVersion, "md")
    ).content
    expect(md).toContain("Planned segment 1")
    expect(md).toContain("no final timestamps")
    expect(await bytes()).toEqual(before)
    expect(await readdir(join(root, "film", "output"))).toEqual([])
  }, 20000)
  it("persists exact request replay across later edits and rejects request identity conflicts", async () => {
    const request = await create()
    const state = await readPublication(root, "film")
    const item = state.packages[0]!
    await changePublication(root, "film", {
      action: "SAVE",
      requestId: randomUUID(),
      packageId: item.packageId,
      revision: 1,
      expectedProjectVersion: state.projectVersion,
      expectedJournalVersion: state.journalVersion,
      document: { ...item.document, audienceQuestion: "A changed audience question" },
    })
    expect(await changePublication(root, "film", request)).toMatchObject({
      revision: 1,
      replayed: true,
    })
    await expect(
      changePublication(root, "film", {
        ...request,
        document: { ...request.document, audienceQuestion: "Conflict" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" })
    expect((await readPublication(root, "film")).packages[0]?.revision).toBe(2)
  })
  it("clears consent on a new draft and labels older approved versions as historical review copies", async () => {
    await create()
    await changePublication(root, "film", await decision())
    let state = await readPublication(root, "film")
    const item = state.packages[0]!
    await changePublication(root, "film", {
      action: "SAVE",
      requestId: randomUUID(),
      packageId: item.packageId,
      revision: 1,
      expectedProjectVersion: state.projectVersion,
      expectedJournalVersion: state.journalVersion,
      document: { ...item.document, audienceQuestion: "Another audience" },
    })
    state = await readPublication(root, "film")
    expect(state.packages[0]?.decision).toBeUndefined()
    expect(state.history[0]?.decision?.action).toBe("APPROVE")
    const old = JSON.parse(
      (await exportPublication(root, "film", item.packageId, "1", state.journalVersion, "json"))
        .content,
    )
    expect(old.isLatest).toBe(false)
    expect(old.status).toContain("NOT CURRENTLY APPROVED")
  }, 20000)
  it("detects source/approval drift without regenerating or updating the saved package", async () => {
    await create()
    await changePublication(root, "film", await decision())
    const packagePath = join(root, "film", "publication", "journal.json")
    const original = await readFile(packagePath, "utf8")
    const approvalPath = join(root, "film", "memory", "approved.json")
    const approvals = JSON.parse(await readFile(approvalPath, "utf8"))
    approvals.narrative.authority = "auto"
    await writeFile(approvalPath, JSON.stringify(approvals))
    const state = await readPublication(root, "film")
    expect(state.sources).toHaveLength(0)
    expect(state.packages[0]?.freshness).toBe("STALE")
    const item = state.packages[0]!
    expect(
      JSON.parse(
        (await exportPublication(root, "film", item.packageId, "1", state.journalVersion, "json"))
          .content,
      ).status,
    ).toContain("NOT CURRENTLY APPROVED")
    expect(await readFile(packagePath, "utf8")).toBe(original)
  }, 20000)
  it("blocks approval of missing content or broken references and records rejection reasons", async () => {
    const state = await readPublication(root, "film")
    const document = filled(state)
    document.titles[0]!.sentenceIds = ["MISSING"]
    await create(document)
    await expect(changePublication(root, "film", await decision())).rejects.toMatchObject({
      code: "PACKAGE_NOT_READY",
    })
    await expect(
      changePublication(root, "film", await decision("REJECT", "")),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" })
    await changePublication(root, "film", await decision("REJECT", "Missing source support"))
    expect((await readPublication(root, "film")).packages[0]?.decision?.reason).toBe(
      "Missing source support",
    )
  }, 20000)
  it("flags definitive title language but never converts lexical checks into semantic PASS", async () => {
    const state = await readPublication(root, "film")
    const document = filled(state)
    document.titles[0]!.text = "A guaranteed answer"
    const findings = inspectPublication(state.sources[0]!, document)
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "PROMISE_LANGUAGE", status: "WARN" }),
    )
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "SEMANTIC_SUPPORT", status: "UNKNOWN" }),
    )
  })
  it("refuses stale saves, unsafe publication paths, corrupt signatures and machine-authority inputs", async () => {
    const request = await create()
    await expect(
      changePublication(root, "film", {
        ...request,
        requestId: randomUUID(),
        packageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_CHANGED" })
    await expect(
      changePublication(root, "film", { ...request, authority: "auto" }),
    ).rejects.toMatchObject({ status: 400 })
    const path = join(root, "film", "publication", "journal.json")
    const raw = await readFile(path, "utf8")
    const envelope = JSON.parse(raw)
    envelope.body.versions[0].document.audienceQuestion = "Tampered"
    await writeFile(path, JSON.stringify(envelope))
    await expect(readPublication(root, "film")).rejects.toMatchObject({
      code: "PUBLICATION_INVALID",
    })
    await rm(join(root, "film", "publication"), { recursive: true })
    const external = join(root, "external")
    await mkdir(external)
    await symlink(external, join(root, "film", "publication"), "junction")
    await expect(readPublication(root, "film")).rejects.toMatchObject({ code: "UNSAFE_PATH" })
    expect(await readdir(external)).toEqual([])
  })
  it("serializes against CLI writers and refuses changed export snapshots", async () => {
    const request = await create()
    await withProjectWrite(root, "film", "test-cli", async () => {
      await expect(changePublication(root, "film", request)).rejects.toMatchObject({
        code: "PROJECT_BUSY",
      })
    })
    const state = await readPublication(root, "film")
    await expect(
      exportPublication(root, "film", request.packageId, "1", "a".repeat(64), "json"),
    ).rejects.toMatchObject({ code: "PUBLICATION_CHANGED" })
    await expect(
      exportPublication(root, "film", "../escape", "1", state.journalVersion, "json"),
    ).rejects.toMatchObject({ status: 400 })
  })
  it("offers completed revisions only with a matching final human approval", async () => {
    const memory = new JsonMemoryStore(join(root, "film", "memory"))
    const engine = new ProductionRevisionEngine(memory)
    await engine.apply(
      await engine.plan("visual"),
      createRevisionGenerator(new ScopedMemory(memory, new Set()), provider()),
      { review: async () => ({ approved: true, authority: "human" }) },
    )
    const state = await readPublication(root, "film")
    expect(state.sources.some((source) => source.id === "revision:REV_0001")).toBe(true)
    const approved = await memory.get<Record<string, { authority: string }>>("approved")
    approved!["REV_0001.final"]!.authority = "auto"
    await memory.save("approved", approved)
    expect(
      (await readPublication(root, "film")).sources.some(
        (source) => source.id === "revision:REV_0001",
      ),
    ).toBe(false)
  }, 20000)
  it("protects package GET/POST/export with session, local Origin, JSON validation and method limits", async () => {
    server = await startViewer({ dataDir: root, port: 0 })
    const token = (await (await fetch(server.url)).text()).match(
      /name="scad-session" content="([a-f0-9]+)"/,
    )![1]!
    const url = server.url + "/api/projects/film/publication"
    const headers = {
      Authorization: "Bearer " + token,
      Origin: server.url,
      "Content-Type": "application/json",
    }
    expect((await fetch(url)).status).toBe(401)
    expect(
      (await fetch(url, { headers: { ...headers, Origin: "https://evil.example" } })).status,
    ).toBe(403)
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { Authorization: headers.Authorization },
          body: "{}",
        })
      ).status,
    ).toBe(403)
    expect((await fetch(url, { method: "POST", headers, body: "{" })).status).toBe(400)
    expect((await fetch(url + "/export", { method: "POST", headers, body: "{}" })).status).toBe(405)
    const state = (await (await fetch(url, { headers })).json()) as PublicationState
    const request: PublicationRequest = {
      action: "CREATE",
      requestId: randomUUID(),
      packageId: randomUUID(),
      expectedProjectVersion: state.projectVersion,
      expectedJournalVersion: state.journalVersion,
      sourceId: state.sources[0]!.id,
      document: filled(state),
    }
    expect(
      (await fetch(url, { method: "POST", headers, body: JSON.stringify(request) })).status,
    ).toBe(200)
    const next = (await (await fetch(url, { headers })).json()) as PublicationState
    const exported = await fetch(
      url +
        "/export?id=" +
        request.packageId +
        "&revision=1&version=" +
        next.journalVersion +
        "&format=json",
      { headers },
    )
    expect(exported.status).toBe(200)
    expect(JSON.parse((await exported.json()).content).status).toContain("REVIEW COPY")
    const compareUrl =
      url + "/compare?id=" + request.packageId + "&from=1&to=1&version=" + next.journalVersion
    expect((await fetch(compareUrl)).status).toBe(401)
    expect(
      (await fetch(compareUrl, { headers: { ...headers, Origin: "https://evil.example" } })).status,
    ).toBe(403)
    expect((await fetch(compareUrl, { method: "POST", headers, body: "{}" })).status).toBe(405)
    const comparison = await fetch(compareUrl, { headers })
    expect(comparison.status).toBe(200)
    expect(
      (await comparison.json()).fields.every(
        (field: { status: string }) => field.status === "UNCHANGED",
      ),
    ).toBe(true)
  }, 20000)
})
