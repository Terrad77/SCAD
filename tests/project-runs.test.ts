import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { ProjectRuns } from "../src/application/project-runs.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { initProject } from "../src/storage/project-store.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
let root: string
let server: ViewerServer | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-runs-"))
  await initProject(root, "demo", "How does evolution work?", "Evolution")
  vi.stubEnv("LLM_PROVIDER", "mock")
  vi.stubEnv("SEARCH_PROVIDER", "mock")
  vi.stubEnv("CONTENT_PROVIDER", "noop")
})
afterEach(async () => {
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function input() {
  return {
    requestId: randomUUID(),
    expectedVersion: (await new ProjectReader(root).read("demo")).readVersion,
  }
}
describe("browser pipeline jobs", () => {
  it("runs the real pipeline to a persisted candidate without approving or running downstream", async () => {
    const jobs = new ProjectRuns(root)
    const request = await input()
    expect((await jobs.start("demo", request)).state).toBe("RUNNING")
    await jobs.close()
    const run = (await jobs.status("demo")).run!
    expect(run.state).toBe("WAITING_REVIEW")
    expect(run.stage).toBe("research")
    expect(run.events.map((e) => e.message).join(" ")).toContain("Generating research")
    const files = await readdir(join(root, "demo", "memory"))
    expect(files).toContain("research.json")
    expect(files).not.toContain("approved.json")
    expect(files).not.toContain("claims.json")
    expect(await readdir(join(root, "demo", "output"))).toEqual([])
    const bytes = await readFile(join(root, "demo", "memory", "research.json"))
    const restarted = new ProjectRuns(root)
    expect((await restarted.start("demo", request)).id).toBe(run.id)
    expect(await readFile(join(root, "demo", "memory", "research.json"))).toEqual(bytes)
    expect((await new ProjectReader(root).list()).map((p) => p.id)).toEqual(["demo"])
    await expect(restarted.start("demo", await input())).rejects.toMatchObject({
      code: "RUN_NEEDS_ATTENTION",
    })
    await restarted.close()
  })
  it("owns execution beyond admission, replays active requests, and excludes CLI writers", async () => {
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const jobs = new ProjectRuns(root, async (options) => {
      await options.onStageStart?.("research")
      await paused
    })
    const request = await input()
    await jobs.start("demo", request)
    try {
      expect((await jobs.status("demo")).owned).toBe(true)
      expect((await jobs.start("demo", request)).id).toBe(request.requestId)
      await expect(withProjectWrite(root, "demo", "cli", async () => {})).rejects.toMatchObject({
        code: "PROJECT_BUSY",
      })
      const other = new ProjectRuns(root)
      expect((await other.status("demo")).owned).toBe(false)
      expect((await other.status("demo")).run?.state).toBe("RUNNING")
      await expect(other.start("demo", await input())).rejects.toMatchObject({
        code: "PROJECT_BUSY",
      })
      await other.close()
    } finally {
      release()
      await jobs.close()
    }
    expect((await jobs.status("demo")).run?.state).toBe("COMPLETED")
    await withProjectWrite(root, "demo", "cli", async () => {})
  })
  it("retains old receipts after another run and rejects identity conflicts", async () => {
    const execute = vi.fn(async () => {})
    const jobs = new ProjectRuns(root, execute)
    const first = await input()
    await jobs.start("demo", first)
    await vi.waitFor(async () => expect((await jobs.status("demo")).run?.state).toBe("COMPLETED"))
    const second = await input()
    await jobs.start("demo", second)
    await vi.waitFor(async () => expect((await jobs.status("demo")).run?.id).toBe(second.requestId))
    await vi.waitFor(async () => expect((await jobs.status("demo")).run?.state).toBe("COMPLETED"))
    expect((await jobs.start("demo", first)).id).toBe(first.requestId)
    await expect(
      jobs.start("demo", { ...first, expectedVersion: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" })
    expect(execute).toHaveBeenCalledTimes(2)
    await jobs.close()
  })
  it("refuses stale input and invalid requests before execution", async () => {
    const execute = vi.fn(async () => {})
    const jobs = new ProjectRuns(root, execute)
    const request = await input()
    const path = join(root, "demo", "project.json")
    const meta = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...meta, title: "Changed" }))
    await expect(jobs.start("demo", request)).rejects.toMatchObject({ code: "SNAPSHOT_CHANGED" })
    await expect(jobs.start("demo", { ...(await input()), force: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
    await expect(jobs.start("../demo", await input())).rejects.toMatchObject({
      code: "INVALID_PROJECT",
    })
    expect(execute).not.toHaveBeenCalled()
    await jobs.close()
  })
  it("persists a failure without exposing provider secrets and releases ownership", async () => {
    const jobs = new ProjectRuns(root, async () => {
      throw new Error("secret-api-key")
    })
    await jobs.start("demo", await input())
    await jobs.close()
    const status = await jobs.status("demo")
    expect(status.run?.state).toBe("FAILED")
    expect(JSON.stringify(status)).not.toContain("secret-api-key")
    await withProjectWrite(root, "demo", "cli", async () => {})
  })
  it.each(["../escape", ""])(
    "fails closed on an invalid journal pointer %j",
    async (pointerValue) => {
      const jobs = new ProjectRuns(root, async () => {})
      await jobs.start("demo", await input())
      await jobs.close()
      const key = (await readdir(join(root, ".scad-runs")))[0]!
      const pointer = join(root, ".scad-runs", key, "latest.json")
      await writeFile(pointer, pointerValue)
      await expect(jobs.status("demo")).rejects.toMatchObject({ code: "RUN_JOURNAL_INVALID" })
      const fresh = new ProjectRuns(root)
      await expect(fresh.start("demo", await input())).rejects.toMatchObject({
        code: "RUN_JOURNAL_INVALID",
      })
      await fresh.close()
    },
  )
  it("rejects linked output entries before running", async () => {
    const external = join(root, "external")
    await mkdir(external)
    const file = join(external, "protected.txt")
    await writeFile(file, "protected")
    await symlink(external, join(root, "demo", "output", "script.md"), "junction")
    const execute = vi.fn(async () => {})
    const jobs = new ProjectRuns(root, execute)
    await expect(jobs.start("demo", await input())).rejects.toMatchObject({ code: "UNSAFE_PATH" })
    expect(await readFile(file, "utf8")).toBe("protected")
    expect(execute).not.toHaveBeenCalled()
    await jobs.close()
  })
  it("protects run APIs and preserves the same job after server restart", async () => {
    server = await startViewer({ dataDir: root, port: 0 })
    const html = await (await fetch(server.url)).text()
    const token = html.match(/name="scad-session" content="([a-f0-9]+)"/)![1]!
    const path = "/api/projects/demo/runs",
      url = server.url + path
    const request = await input(),
      body = JSON.stringify(request)
    const auth = { Authorization: "Bearer " + token }
    const headers = { ...auth, Origin: server.url, "Content-Type": "application/json" }
    expect((await fetch(url)).status).toBe(401)
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
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(202)
    await server.close()
    server = await startViewer({ dataDir: root, port: 0 })
    const nextHtml = await (await fetch(server.url)).text()
    const nextToken = nextHtml.match(/name="scad-session" content="([a-f0-9]+)"/)![1]!
    const status = (await (
      await fetch(server.url + path, { headers: { Authorization: "Bearer " + nextToken } })
    ).json()) as { run: { state: string; id: string } }
    expect(status.run).toMatchObject({ state: "WAITING_REVIEW", id: request.requestId })
  })
})
