import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { get } from "node:http"
import { ProjectRuns, type ProjectRun } from "../src/application/project-runs.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { initProject } from "../src/storage/project-store.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"

let root: string
let folder: string
let server: ViewerServer | undefined
const record = (index: number): ProjectRun => ({
  id: randomUUID(),
  project: "demo",
  owner: randomUUID(),
  expectedVersion: "a".repeat(64),
  state: "COMPLETED",
  stage: null,
  startedAt: new Date(Date.UTC(2026, 9, 15, 0, 0, index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 15, 0, 1, index)).toISOString(),
  events: [{ at: "2026-10-15T00:00:00.000Z", message: "Test-only saved event" }],
})
const navigationStatus = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    get(url, { headers }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode ?? 0))
    }).on("error", reject)
  })
async function save(run: ProjectRun, latest = true) {
  await writeFile(join(folder, run.id + ".json"), JSON.stringify(run))
  if (latest) await writeFile(join(folder, "latest.json"), run.id)
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-run-history-"))
  await initProject(root, "demo", "Why?", "Film")
  folder = join(root, ".scad-runs", createHash("sha256").update("demo").digest("hex"))
  await mkdir(folder, { recursive: true })
})
afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true })
})
describe("read-only browser run history", () => {
  it("paginates newest first with a stable cursor when a newer run is inserted", async () => {
    const jobs = new ProjectRuns(root)
    const runs = Array.from({ length: 23 }, (_, i) => record(i))
    for (const run of runs) await save(run)
    const first = await jobs.history("demo")
    expect(first.total).toBe(23)
    expect(first.entries.map((run) => run.id)).toEqual(
      runs
        .slice(13)
        .reverse()
        .map((run) => run.id),
    )
    expect(first.entries[0]?.latest).toBe(true)
    expect(first.entries[0]).not.toHaveProperty("owner")
    expect(first.entries[0]).not.toHaveProperty("expectedVersion")
    await save(record(24))
    const second = await jobs.history("demo", first.nextCursor!)
    const third = await jobs.history("demo", second.nextCursor!)
    expect([...first.entries, ...second.entries, ...third.entries].map((run) => run.id)).toEqual(
      [...runs].reverse().map((run) => run.id),
    )
    expect(third.nextCursor).toBeNull()
    expect(second.total).toBe(24)
    await jobs.close()
  })
  it("preserves parents, historical decisions and raw journal bytes without writing", async () => {
    const parent = {
      ...record(1),
      state: "WAITING_REVIEW" as const,
      stage: "claims",
      checkpoint: {
        artifactSignature: "a".repeat(64),
        dependencySignature: "b".repeat(64),
        inputSignature: "c".repeat(64),
      },
      decision: {
        requestId: randomUUID(),
        action: "APPROVE" as const,
        reason: "Historical note <script>",
        decidedAt: "2026-10-15T00:02:00.000Z",
      },
    }
    const child = { ...record(2), resumeOf: parent.id }
    await save(parent)
    await save(child)
    await writeFile(join(folder, parent.id + ".decision.json"), "Receipt is not a run")
    const before = await Promise.all(
      (await readdir(folder))
        .sort()
        .map(async (name) => [name, await readFile(join(folder, name), "utf8")]),
    )
    const jobs = new ProjectRuns(root)
    const history = await jobs.history("demo")
    expect(history.entries[0]).toMatchObject({ resumeOf: parent.id, parentMissing: false })
    expect(history.entries[1]?.decision).toEqual(parent.decision)
    expect(
      await Promise.all(
        (await readdir(folder))
          .sort()
          .map(async (name) => [name, await readFile(join(folder, name), "utf8")]),
      ),
    ).toEqual(before)
    await jobs.close()
  })
  it("distinguishes owned execution from another instance and never restarts a saved RUNNING record", async () => {
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const jobs = new ProjectRuns(root, async () => {
      await paused
    })
    await jobs.start("demo", {
      requestId: randomUUID(),
      expectedVersion: (await new ProjectReader(root).read("demo")).readVersion,
    })
    const other = new ProjectRuns(root)
    try {
      expect((await jobs.history("demo")).entries[0]?.execution).toBe("ACTIVE")
      expect((await other.history("demo")).entries[0]?.execution).toBe("UNVERIFIED")
    } finally {
      release()
      await jobs.close()
      await other.close()
    }
    expect((await jobs.history("demo")).entries[0]?.execution).toBe("STOPPED")
  })
  it("reports missing parents and refuses corrupt or cross-project journals", async () => {
    const run = { ...record(1), resumeOf: randomUUID() }
    await save(run)
    const jobs = new ProjectRuns(root)
    expect((await jobs.history("demo")).entries[0]?.parentMissing).toBe(true)
    await save({ ...run, project: "another-project" })
    await expect(jobs.history("demo")).rejects.toMatchObject({ code: "RUN_JOURNAL_INVALID" })
    await writeFile(join(folder, run.id + ".json"), "{")
    await expect(jobs.history("demo")).rejects.toMatchObject({ code: "RUN_JOURNAL_INVALID" })
    await jobs.close()
  })
  it("handles empty history and refuses invalid cursors/latest pointers", async () => {
    const jobs = new ProjectRuns(root)
    expect(await jobs.history("demo")).toEqual({ entries: [], nextCursor: null, total: 0 })
    await expect(jobs.history("demo", "../escape")).rejects.toMatchObject({ status: 400 })
    await expect(jobs.history("demo", randomUUID())).rejects.toMatchObject({
      code: "HISTORY_CHANGED",
    })
    await save(record(1))
    await writeFile(join(folder, "latest.json"), "../escape")
    await expect(jobs.history("demo")).rejects.toMatchObject({ code: "HISTORY_CHANGED" })
    await jobs.close()
  })
  it("bounds history before reading more than 1000 run files", async () => {
    await Promise.all(
      Array.from({ length: 1001 }, () => writeFile(join(folder, randomUUID() + ".json"), "{}")),
    )
    const jobs = new ProjectRuns(root)
    await expect(jobs.history("demo")).rejects.toMatchObject({
      status: 413,
      code: "HISTORY_TOO_LARGE",
    })
    await jobs.close()
  })
  it("protects GET history and retains records across viewer restart", async () => {
    const run = record(1)
    await save(run)
    server = await startViewer({ dataDir: root, port: 0 })
    const token = (await (await fetch(server.url)).text()).match(
      /name="scad-session" content="([a-f0-9]+)"/,
    )![1]!
    const url = server.url + "/api/projects/demo/runs/history"
    const headers = { Authorization: "Bearer " + token }
    const navigation = {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-User": "?1",
    }
    expect(await navigationStatus(server.url, navigation)).toBe(200)
    expect((await fetch(server.url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(
      403,
    )
    expect((await fetch(url, { headers: { ...headers, ...navigation } })).status).toBe(403)
    expect((await fetch(url)).status).toBe(401)
    expect(
      (await fetch(url, { headers: { ...headers, Origin: "https://evil.example" } })).status,
    ).toBe(403)
    expect((await fetch(url, { headers, method: "POST" })).status).toBe(405)
    expect((await fetch(url + "?cursor=bad", { headers })).status).toBe(400)
    expect((await (await fetch(url, { headers })).json()).entries[0].id).toBe(run.id)
    await server.close()
    server = await startViewer({ dataDir: root, port: 0 })
    const nextToken = (await (await fetch(server.url)).text()).match(
      /name="scad-session" content="([a-f0-9]+)"/,
    )![1]!
    expect(
      (
        await (
          await fetch(server.url + "/api/projects/demo/runs/history", {
            headers: { Authorization: "Bearer " + nextToken },
          })
        ).json()
      ).entries[0].id,
    ).toBe(run.id)
  })
})
