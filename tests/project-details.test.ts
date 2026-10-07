import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { updateProjectDetails } from "../src/application/project-details.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { initProject } from "../src/storage/project-store.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
let root: string
let viewer: ViewerServer | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-details-"))
  await initProject(root, "demo", "Original question", "Original title")
})
afterEach(async () => {
  await viewer?.close()
  viewer = undefined
  await rm(root, { recursive: true, force: true })
})
async function input(title = "Updated title", question = "Original question") {
  return {
    requestId: randomUUID(),
    expectedVersion: (await new ProjectReader(root).read("demo")).readVersion,
    title,
    question,
  }
}
describe("project details commands", () => {
  it("changes empty project details, preserving identity and unknown metadata", async () => {
    const file = join(root, "demo", "project.json")
    const original = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...original, extra: { keep: true } }))
    const request = await input("  New title  ", "New question")
    expect(await updateProjectDetails(root, "demo", request)).toEqual({
      id: "demo",
      replayed: false,
    })
    const meta = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect(meta).toMatchObject({
      project: "demo",
      title: "New title",
      question: "New question",
      createdAt: original.createdAt,
      extra: { keep: true },
    })
    expect(await new ProjectReader(root).list()).toEqual([
      { id: "demo", title: "New title", question: "New question", status: "VALID" },
    ])
    expect(await readdir(join(root, "demo", "memory"))).toEqual([])
    expect(await readdir(join(root, "demo", "output"))).toEqual([])
  })
  it("replays across command instances and does not overwrite a later edit", async () => {
    const first = await input()
    await updateProjectDetails(root, "demo", first)
    const second = await input("Later title")
    await updateProjectDetails(root, "demo", second)
    const bytes = await readFile(join(root, "demo", "project.json"), "utf8")
    expect(await updateProjectDetails(root, "demo", first)).toEqual({ id: "demo", replayed: true })
    expect(await readFile(join(root, "demo", "project.json"), "utf8")).toBe(bytes)
    await expect(
      updateProjectDetails(root, "demo", { ...first, title: "Reused" }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" })
  })
  it("reconciles a committed rename without a completed receipt", async () => {
    const request = await input()
    await updateProjectDetails(root, "demo", request)
    const key = createHash("sha256").update("demo").digest("hex")
    await rm(join(root, ".scad-settings", key, request.requestId, "completed.json"))
    const bytes = await readFile(join(root, "demo", "project.json"), "utf8")
    expect((await updateProjectDetails(root, "demo", request)).replayed).toBe(true)
    expect(await readFile(join(root, "demo", "project.json"), "utf8")).toBe(bytes)
  })
  it.each(["memory", "output"])(
    "fixes the question after any %s material exists and preserves bytes",
    async (folder) => {
      const file = join(root, "demo", folder, "unknown.bin")
      await writeFile(file, "protected bytes")
      expect((await new ProjectReader(root).read("demo")).questionEditable).toBe(false)
      await expect(
        updateProjectDetails(root, "demo", await input("Title", "Different question")),
      ).rejects.toMatchObject({ code: "QUESTION_LOCKED" })
      await updateProjectDetails(root, "demo", await input("New title"))
      expect(await readFile(file, "utf8")).toBe("protected bytes")
      expect((await new ProjectReader(root).read("demo")).meta?.question).toBe("Original question")
    },
  )
  it("rejects snapshot drift and competing CLI ownership", async () => {
    const request = await input()
    await writeFile(join(root, "demo", "memory", "claims.json"), JSON.stringify({ claims: [] }))
    const bytes = await readFile(join(root, "demo", "project.json"), "utf8")
    await expect(updateProjectDetails(root, "demo", request)).rejects.toMatchObject({
      code: "SNAPSHOT_CHANGED",
    })
    expect(await readFile(join(root, "demo", "project.json"), "utf8")).toBe(bytes)
    await withProjectWrite(root, "demo", "CLI", async () => {
      await expect(updateProjectDetails(root, "demo", await input())).rejects.toMatchObject({
        code: "PROJECT_BUSY",
      })
    })
  })
  it("refuses corrupt metadata and an unverified revision journal", async () => {
    await writeFile(join(root, "demo", "memory", "production-revisions.json"), "{")
    await expect(updateProjectDetails(root, "demo", await input())).rejects.toMatchObject({
      code: "REVISION_UNVERIFIED",
    })
    await rm(join(root, "demo", "memory", "production-revisions.json"))
    await writeFile(join(root, "demo", "project.json"), "{")
    await expect(updateProjectDetails(root, "demo", await input())).rejects.toMatchObject({
      code: "INVALID_METADATA",
    })
  })
  it("refuses unsafe folders and invalid inputs without touching project files", async () => {
    const bytes = await readFile(join(root, "demo", "project.json"), "utf8")
    const request = await input()
    for (const value of [
      null,
      { ...request, title: " " },
      { ...request, expectedVersion: "old" },
      { ...request, question: "x".repeat(4001) },
      { ...request, extra: 1 },
    ])
      await expect(updateProjectDetails(root, "demo", value)).rejects.toMatchObject({ status: 400 })
    await expect(updateProjectDetails(root, "../demo", request)).rejects.toMatchObject({
      status: 400,
    })
    const external = join(root, "outside")
    await mkdir(external)
    await rm(join(root, "demo", "output"), { recursive: true })
    await symlink(external, join(root, "demo", "output"), "junction")
    await expect(
      updateProjectDetails(root, "demo", { ...request, question: "New question" }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" })
    expect(await readFile(join(root, "demo", "project.json"), "utf8")).toBe(bytes)
  })
  it("requires local origin and capability for the settings route", async () => {
    viewer = await startViewer({ dataDir: root, port: 0 })
    const html = await (await fetch(viewer.url)).text(),
      token = html.match(/name="scad-session" content="([a-f0-9]+)"/)![1]!
    const url = viewer.url + "/api/projects/demo/settings",
      body = JSON.stringify(await input())
    const headers = {
      Authorization: "Bearer " + token,
      Origin: viewer.url,
      "Content-Type": "application/json",
    }
    expect(
      (await fetch(url, { method: "POST", headers: { Origin: viewer.url }, body })).status,
    ).toBe(401)
    expect(
      (await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token }, body }))
        .status,
    ).toBe(403)
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
    expect((await new ProjectReader(root).read("demo")).meta?.title).toBe("Updated title")
  })
})
