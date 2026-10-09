import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { ProjectRuns } from "../src/application/project-runs.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { initProject } from "../src/storage/project-store.js"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
let root: string, jobs: ProjectRuns, server: ViewerServer | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-resume-"))
  await initProject(root, "demo", "How does evolution work?", "Evolution")
  vi.stubEnv("LLM_PROVIDER", "mock")
  vi.stubEnv("SEARCH_PROVIDER", "mock")
  vi.stubEnv("CONTENT_PROVIDER", "noop")
  vi.stubEnv("SCAD_SEARCH_CACHE", "0")
  jobs = new ProjectRuns(root)
  await jobs.start("demo", {
    requestId: randomUUID(),
    expectedVersion: (await new ProjectReader(root).read("demo")).readVersion,
  })
  await vi.waitFor(async () =>
    expect((await jobs.status("demo")).run?.state).toBe("WAITING_REVIEW"),
  )
  await vi.waitFor(() => withProjectWrite(root, "demo", "test-ready", async () => {}))
})
afterEach(async () => {
  await jobs.close()
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function approve(action: "APPROVE" | "REJECT" = "APPROVE") {
  const review = await jobs.review("demo")
  await jobs.decide("demo", {
    requestId: randomUUID(),
    runId: review.runId,
    expectedVersion: review.version,
    artifactSignature: review.artifactSignature,
    dependencySignature: review.dependencySignature,
    action,
    reason: "Reviewed",
  })
}
async function input() {
  return {
    requestId: randomUUID(),
    runId: (await jobs.status("demo")).run!.id,
    expectedVersion: (await new ProjectReader(root).read("demo")).readVersion,
  }
}
async function folder() {
  return join(root, ".scad-runs", (await readdir(join(root, ".scad-runs")))[0]!)
}
describe("explicit Research continuation", () => {
  it("preserves Research and approval bytes, admits a linked job and stops at claims without approving it", async () => {
    await approve()
    const research = await readFile(join(root, "demo", "memory", "research.json"))
    const approval = await readFile(join(root, "demo", "memory", "approved.json"))
    const request = await input()
    const admitted = await jobs.resume("demo", request)
    expect(admitted).toMatchObject({
      id: request.requestId,
      resumeOf: request.runId,
      state: "RUNNING",
    })
    await jobs.close()
    expect((await jobs.status("demo")).run).toMatchObject({
      id: request.requestId,
      state: "WAITING_REVIEW",
      stage: "claims",
    })
    expect(await readFile(join(root, "demo", "memory", "research.json"))).toEqual(research)
    expect(await readFile(join(root, "demo", "memory", "approved.json"))).toEqual(approval)
    const claims = JSON.parse(
      await readFile(join(root, "demo", "memory", "claims.json"), "utf8"),
    ) as { claims: unknown[] }
    expect(claims.claims.length).toBeGreaterThan(0)
    expect(await readdir(join(root, "demo", "memory"))).not.toContain("hypotheses.json")
    expect(await readdir(join(root, "demo", "output"))).toEqual([])
    const parent = JSON.parse(
      await readFile(join(await folder(), request.runId + ".json"), "utf8"),
    ) as { decision: { action: string } }
    expect(parent.decision.action).toBe("APPROVE")
    const restarted = new ProjectRuns(root)
    expect((await restarted.resume("demo", request)).id).toBe(request.requestId)
    await expect(
      restarted.resume("demo", { ...request, expectedVersion: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" })
    await expect(
      restarted.start("demo", {
        requestId: request.requestId,
        expectedVersion: request.expectedVersion,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" })
    await expect(
      restarted.resume("demo", { ...request, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CHANGED" })
    await restarted.close()
  })
  it.each([
    "undecided",
    "rejected",
    "candidate",
    "inputs",
    "ledger",
    "receipt",
    "snapshot",
    "running",
    "legacy",
  ])("refuses %s without executing", async (kind) => {
    if (kind !== "undecided") await approve(kind === "rejected" ? "REJECT" : "APPROVE")
    const request = await input()
    const memory = join(root, "demo", "memory")
    if (kind === "candidate") {
      const p = join(memory, "research.json")
      const data = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>
      await writeFile(p, JSON.stringify({ ...data, summary: "Changed" }))
    }
    if (kind === "inputs") {
      const p = join(root, "demo", "project.json")
      const data = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>
      await writeFile(p, JSON.stringify({ ...data, title: "Changed" }))
    }
    if (kind === "ledger") await writeFile(join(memory, "approved.json"), "{}")
    if (kind === "receipt") await rm(join(await folder(), request.runId + ".decision-done.json"))
    if (kind === "snapshot") request.expectedVersion = "a".repeat(64)
    if (kind === "running" || kind === "legacy") {
      const p = join(await folder(), request.runId + ".json")
      const data = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>
      if (kind === "running") data.state = "RUNNING"
      else delete data.checkpoint
      await writeFile(p, JSON.stringify(data))
    }
    const execute = vi.fn(async () => {})
    const other = new ProjectRuns(root, execute)
    await expect(other.resume("demo", request)).rejects.toMatchObject({ status: 409 })
    expect(execute).not.toHaveBeenCalled()
    expect(await readdir(memory)).not.toContain("claims.json")
    await other.close()
  })
  it("rejects unknown fields and excludes CLI writers", async () => {
    await approve()
    const request = await input()
    await expect(jobs.resume("demo", { ...request, force: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
    await withProjectWrite(root, "demo", "cli", async () => {
      await expect(jobs.resume("demo", request)).rejects.toMatchObject({ code: "PROJECT_BUSY" })
    })
  })
  it("replays an active continuation without launching another executor or claiming its ownership", async () => {
    await approve()
    const request = await input()
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.fn(async () => {
      await paused
    })
    const active = new ProjectRuns(root, execute)
    const otherExecute = vi.fn(async () => {})
    const restarted = new ProjectRuns(root, otherExecute)
    try {
      await active.resume("demo", request)
      expect((await active.status("demo")).owned).toBe(true)
      expect((await restarted.status("demo")).owned).toBe(false)
      expect((await restarted.resume("demo", request)).state).toBe("RUNNING")
      await expect(
        restarted.resume("demo", { ...request, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: "PROJECT_BUSY" })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(otherExecute).not.toHaveBeenCalled()
    } finally {
      release()
      await active.close()
      await restarted.close()
    }
    const p = join(await folder(), request.requestId + ".json")
    const saved = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>
    saved.state = "RUNNING"
    await writeFile(p, JSON.stringify(saved))
    const recoveryExecute = vi.fn(async () => {})
    const recovery = new ProjectRuns(root, recoveryExecute)
    expect((await recovery.resume("demo", request)).state).toBe("RUNNING")
    expect((await recovery.status("demo")).owned).toBe(false)
    expect(recoveryExecute).not.toHaveBeenCalled()
    await recovery.close()
  })
  it("protects Resume HTTP and accepts a single explicit continuation", async () => {
    await approve()
    server = await startViewer({ dataDir: root, port: 0 })
    const token = (await (await fetch(server.url)).text()).match(
      /name="scad-session" content="([a-f0-9]+)"/,
    )![1]!
    const url = server.url + "/api/projects/demo/resume",
      body = JSON.stringify(await input())
    const auth = { Authorization: "Bearer " + token },
      headers = { ...auth, Origin: server.url, "Content-Type": "application/json" }
    expect((await fetch(url, { method: "POST", body })).status).toBe(401)
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
    expect((await fetch(url, { headers: auth })).status).toBe(405)
    expect((await fetch(url, { method: "POST", headers, body: "{" })).status).toBe(400)
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(202)
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(202)
  })
})
