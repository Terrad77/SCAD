import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createProject } from "../src/application/project-create.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { ProjectTrash } from "../src/application/project-trash.js"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
let root: string
let viewer: ViewerServer | undefined
const input = () => ({
  requestId: randomUUID(),
  title: "Working film",
  question: "What supports this idea?",
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-create-"))
})
afterEach(async () => {
  await viewer?.close()
  viewer = undefined
  await rm(root, { recursive: true, force: true })
})
describe("local project creation", () => {
  it("publishes CLI-compatible empty folders and metadata, with durable replay", async () => {
    const request = input()
    const result = await createProject(root, request)
    const reader = new ProjectReader(root)
    expect(await reader.list()).toEqual([
      { id: result.id, title: request.title, question: request.question, status: "VALID" },
    ])
    expect((await reader.read(result.id)).meta).toMatchObject({ title: request.title })
    expect(await readdir(join(root, result.id, "memory"))).toEqual([])
    expect(await readdir(join(root, result.id, "output"))).toEqual([])
    const original = await readFile(join(root, result.id, "project.json"), "utf8")
    expect(await createProject(root, request)).toEqual({ id: result.id, replayed: true })
    expect(await readFile(join(root, result.id, "project.json"), "utf8")).toBe(original)
    await expect(createProject(root, { ...request, title: "Different" })).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    })
  })
  it("does not resurrect a trashed project on request replay", async () => {
    const request = input(),
      created = await createProject(root, request)
    const snapshot = await new ProjectReader(root).read(created.id)
    const trash = new ProjectTrash(root)
    const removed = await trash.remove(created.id, snapshot.readVersion)
    await expect(createProject(root, request)).rejects.toMatchObject({ code: "CREATE_UNAVAILABLE" })
    expect(await new ProjectReader(root).list()).toEqual([])
    await trash.restore(removed.id)
    expect((await createProject(root, request)).replayed).toBe(true)
  })
  it("rejects invalid input before creating files", async () => {
    for (const value of [
      null,
      {},
      { ...input(), title: "  " },
      { ...input(), question: "x".repeat(4001) },
      { ...input(), requestId: "../escape" },
      { ...input(), extra: true },
    ]) {
      await expect(createProject(root, value)).rejects.toMatchObject({ status: 400 })
    }
    expect(await readdir(root)).toEqual([])
  })
  it("refuses an existing target and interrupted receipt without changing them", async () => {
    const request = input(),
      target = join(root, "project-" + request.requestId)
    await mkdir(target)
    await writeFile(join(target, "keep.txt"), "preserve")
    await expect(createProject(root, request)).rejects.toMatchObject({ code: "PROJECT_EXISTS" })
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("preserve")
    const interrupted = input(),
      receipt = join(root, ".scad-creates", interrupted.requestId)
    await mkdir(receipt, { recursive: true })
    await writeFile(join(receipt, "request.json"), "{")
    await expect(createProject(root, interrupted)).rejects.toMatchObject({
      code: "CREATE_INTERRUPTED",
    })
    expect(await new ProjectReader(root).list()).toHaveLength(0)
  })
  it("shares ownership with CLI writers and allows safe retry", async () => {
    const request = input()
    await withProjectWrite(root, "project-" + request.requestId, "cli", async () => {
      await expect(createProject(root, request)).rejects.toMatchObject({ code: "PROJECT_BUSY" })
    })
    expect((await createProject(root, request)).replayed).toBe(false)
  })
  it("protects POST and validates content type, JSON and body size", async () => {
    viewer = await startViewer({ dataDir: root, port: 0 })
    const html = await (await fetch(viewer.url)).text()
    const token = html.match(/name="scad-session" content="([a-f0-9]+)"/)![1]!
    const url = viewer.url + "/api/projects"
    const headers = {
      Authorization: "Bearer " + token,
      Origin: viewer.url,
      "Content-Type": "application/json",
    }
    const body = JSON.stringify(input())
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
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "text/plain" },
          body,
        })
      ).status,
    ).toBe(415)
    expect((await fetch(url, { method: "POST", headers, body: "{" })).status).toBe(400)
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...input(), question: "x".repeat(33000) }),
        })
      ).status,
    ).toBe(413)
    const created = await fetch(url, { method: "POST", headers, body })
    expect(created.status).toBe(201)
    const replay = await fetch(url, { method: "POST", headers, body })
    expect(await replay.json()).toMatchObject({ replayed: true })
    expect(await new ProjectReader(root).list()).toHaveLength(1)
  })
})
