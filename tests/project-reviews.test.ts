import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { ProjectRuns } from "../src/application/project-runs.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { ApprovalLedger, dependencySignature } from "../src/core/production/approval.js"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { initProject } from "../src/storage/project-store.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
import type { ReviewRequest } from "../src/application/project-reviews.js"
let root: string, jobs: ProjectRuns, server: ViewerServer | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-reviews-"))
  await initProject(root, "demo", "How does evolution work?", "Evolution")
  vi.stubEnv("SCAD_SEARCH_CACHE", "0")
  vi.stubEnv("LLM_PROVIDER", "mock")
  vi.stubEnv("SEARCH_PROVIDER", "mock")
  vi.stubEnv("CONTENT_PROVIDER", "noop")
  jobs = new ProjectRuns(root)
  await jobs.start("demo", {
    requestId: randomUUID(),
    expectedVersion: (await new ProjectReader(root).read("demo")).readVersion,
  })
  await vi.waitFor(async () =>
    expect((await jobs.status("demo")).run?.state).toBe("WAITING_REVIEW"),
  )
})
afterEach(async () => {
  await jobs.close()
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function request(action: ReviewRequest["action"] = "APPROVE"): Promise<ReviewRequest> {
  const review = await jobs.review("demo")
  return {
    requestId: randomUUID(),
    runId: review.runId,
    expectedVersion: review.version,
    artifactSignature: review.artifactSignature,
    dependencySignature: review.dependencySignature,
    action,
    reason: action === "REJECT" ? "Sources need verification" : "Reviewed",
  }
}
async function journal() {
  const key = (await readdir(join(root, ".scad-runs")))[0]!
  const folder = join(root, ".scad-runs", key),
    id = (await jobs.status("demo")).run!.id
  return { folder, id, path: join(folder, id + ".json") }
}
describe("Research browser decisions", () => {
  it("records a real human ledger approval for exact raw content and preserves candidate/output bytes", async () => {
    const candidate = join(root, "demo", "memory", "research.json")
    const bytes = await readFile(candidate)
    const review = await jobs.review("demo")
    expect(review.decidable).toBe(true)
    const input = await request()
    const decision = await jobs.decide("demo", input)
    expect(decision.action).toBe("APPROVE")
    const ledger = new ApprovalLedger(new JsonMemoryStore(join(root, "demo", "memory")))
    expect(
      await ledger.isApproved({
        stage: "research",
        artifactSignature: review.artifactSignature,
        dependencySignature: dependencySignature({}),
      }),
    ).toBe(true)
    expect(await ledger.get("research")).toMatchObject({
      authority: "human",
      modified: false,
      decisionId: input.requestId,
    })
    expect(await readFile(candidate)).toEqual(bytes)
    expect(await readdir(join(root, "demo", "output"))).toEqual([])
    expect(await readdir(join(root, "demo", "memory"))).not.toContain("claims.json")
    expect((await jobs.review("demo")).decidable).toBe(false)
    expect((await jobs.status("demo")).run?.state).toBe("WAITING_REVIEW")
  })
  it("rejects with a reason while retaining the candidate and not granting approval", async () => {
    const candidate = join(root, "demo", "memory", "research.json"),
      bytes = await readFile(candidate)
    const input = await request("REJECT")
    await expect(jobs.decide("demo", { ...input, reason: " " })).rejects.toMatchObject({
      code: "INVALID_DECISION",
    })
    expect((await jobs.decide("demo", input)).reason).toBe(input.reason)
    expect(await readFile(candidate)).toEqual(bytes)
    expect(
      await new ApprovalLedger(new JsonMemoryStore(join(root, "demo", "memory"))).get("research"),
    ).toBeNull()
    expect((await jobs.review("demo")).decision?.action).toBe("REJECT")
  })
  it.each(["candidate", "metadata", "snapshot"])(
    "refuses %s drift without a decision",
    async (kind) => {
      const input = await request()
      if (kind === "candidate") {
        const path = join(root, "demo", "memory", "research.json"),
          value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        await writeFile(path, JSON.stringify({ ...value, summary: "Changed" }))
      } else if (kind === "metadata") {
        const path = join(root, "demo", "project.json"),
          value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        await writeFile(path, JSON.stringify({ ...value, title: "Changed title" }))
      } else
        await writeFile(join(root, "demo", "memory", "claims.json"), JSON.stringify({ claims: [] }))
      await expect(jobs.decide("demo", input)).rejects.toMatchObject({ status: 409 })
      expect(
        await new ApprovalLedger(new JsonMemoryStore(join(root, "demo", "memory"))).get("research"),
      ).toBeNull()
    },
  )
  it("replays across instances without overwriting a later ledger record or duplicating events", async () => {
    const input = await request(),
      first = await jobs.decide("demo", input),
      { path } = await journal(),
      bytes = await readFile(path)
    const store = new JsonMemoryStore(join(root, "demo", "memory")),
      ledger = new ApprovalLedger(store)
    const original = (await ledger.get("research"))!
    await ledger.record({ ...original, artifactSignature: "a".repeat(64) })
    const ledgerBytes = await readFile(join(store.location, "approved.json"))
    const restarted = new ProjectRuns(root)
    expect(await restarted.decide("demo", input)).toEqual(first)
    expect(await readFile(join(store.location, "approved.json"))).toEqual(ledgerBytes)
    expect(await readFile(path)).toEqual(bytes)
    await expect(
      restarted.decide("demo", { ...input, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "DECISION_CONFLICT" })
    await restarted.close()
  })
  it.each([false, true])(
    "reconciles a committed ledger after crash, journal already written=%s",
    async (journalWritten) => {
      const input = await request(),
        first = await jobs.decide("demo", input),
        { folder, id, path } = await journal()
      await rm(join(folder, id + ".decision-done.json"))
      if (!journalWritten) {
        const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        delete saved.decision
        saved.events = (saved.events as unknown[]).slice(0, -1)
        await writeFile(path, JSON.stringify(saved))
      }
      const before = await readFile(join(root, "demo", "memory", "approved.json"))
      expect(await jobs.decide("demo", input)).toEqual(first)
      expect(await readFile(join(root, "demo", "memory", "approved.json"))).toEqual(before)
      expect(
        (await jobs.status("demo")).run?.events.filter((e) =>
          e.message.includes("Research decision"),
        ).length,
      ).toBe(1)
    },
  )
  it("refuses corrupt ledger, unknown fields, shared ownership and legacy unsigned checkpoints", async () => {
    const input = await request()
    await expect(jobs.decide("demo", { ...input, authority: "auto" })).rejects.toMatchObject({
      code: "INVALID_DECISION",
    })
    await withProjectWrite(root, "demo", "cli", async () => {
      await expect(jobs.decide("demo", input)).rejects.toMatchObject({ code: "PROJECT_BUSY" })
    })
    await writeFile(join(root, "demo", "memory", "approved.json"), "{")
    await expect(jobs.decide("demo", input)).rejects.toMatchObject({ code: "APPROVALS_INVALID" })
    await rm(join(root, "demo", "memory", "approved.json"))
    const { path } = await journal(),
      saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    delete saved.checkpoint
    await writeFile(path, JSON.stringify(saved))
    expect((await jobs.review("demo")).decidable).toBe(false)
    await expect(jobs.decide("demo", input)).rejects.toMatchObject({ code: "CHECKPOINT_CHANGED" })
  })
  it("keeps a recorded approval historical when Research changes later", async () => {
    const input = await request()
    await jobs.decide("demo", input)
    const path = join(root, "demo", "memory", "research.json")
    const candidate = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...candidate, summary: "Later edited summary" }))
    const review = await jobs.review("demo")
    expect(review.decidable).toBe(false)
    expect(review.explanation).toContain("does not approve the displayed candidate")
    expect(review.checkpointArtifactSignature).toBe(input.artifactSignature)
    expect(review.artifactSignature).not.toBe(input.artifactSignature)
  })
  it("refuses an inconsistent interrupted decision receipt", async () => {
    const input = await request()
    await jobs.decide("demo", input)
    const { folder, id } = await journal()
    const path = join(folder, id + ".decision.json")
    const receipt = JSON.parse(await readFile(path, "utf8")) as { approval: { authority: string } }
    receipt.approval.authority = "auto"
    await writeFile(path, JSON.stringify(receipt))
    await rm(join(folder, id + ".decision-done.json"))
    await expect(jobs.decide("demo", input)).rejects.toMatchObject({ code: "DECISION_INVALID" })
    expect(
      await new ApprovalLedger(new JsonMemoryStore(join(root, "demo", "memory"))).get("research"),
    ).toMatchObject({ authority: "human" })
  })
  it("uses protected review HTTP routes without generation", async () => {
    server = await startViewer({ dataDir: root, port: 0 })
    const token = (await (await fetch(server.url)).text()).match(
      /name="scad-session" content="([a-f0-9]+)"/,
    )![1]!
    const url = server.url + "/api/projects/demo/review",
      body = JSON.stringify(await request())
    const auth = { Authorization: "Bearer " + token },
      headers = { ...auth, Origin: server.url, "Content-Type": "application/json" }
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: auth })).status).toBe(200)
    expect((await fetch(url, { method: "POST", headers: auth, body })).status).toBe(403)
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body,
        })
      ).status,
    ).toBe(403)
    expect((await fetch(url, { method: "POST", headers, body: "{" })).status).toBe(400)
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(200)
    expect((await jobs.review("demo")).decision?.action).toBe("APPROVE")
  })
})
