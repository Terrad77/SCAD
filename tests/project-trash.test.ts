import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectTrash } from "../src/application/project-trash.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { initProject } from "../src/storage/project-store.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-trash-test-"))
  await initProject(root, "demo", "Question", "Demo")
  await writeFile(join(root, "demo", "memory", "unknown.bin"), "protected bytes")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe("recoverable project deletion", () => {
  it("lists without creating trash and preserves every file through remove/restore", async () => {
    const trash = new ProjectTrash(root),
      reader = new ProjectReader(root)
    expect(await trash.list()).toEqual([])
    expect(await readdir(root)).toEqual(["demo"])
    const snapshot = await reader.read("demo"),
      deleted = await trash.remove("demo", snapshot.readVersion)
    expect(await reader.list()).toEqual([])
    expect(await trash.list()).toEqual([deleted])
    expect(
      await readFile(
        join(root, ".scad-trash", deleted.id, "project", "memory", "unknown.bin"),
        "utf8",
      ),
    ).toBe("protected bytes")
    await trash.restore(deleted.id)
    expect((await reader.read("demo")).readVersion).toBe(snapshot.readVersion)
    expect(await readFile(join(root, "demo", "memory", "unknown.bin"), "utf8")).toBe(
      "protected bytes",
    )
    expect(await trash.list()).toEqual([])
  })
  it("rejects snapshot drift, invalid identifiers and restore collisions", async () => {
    const trash = new ProjectTrash(root),
      reader = new ProjectReader(root),
      old = await reader.read("demo")
    await writeFile(
      join(root, "demo", "project.json"),
      JSON.stringify({ project: "demo", title: "Changed", question: "Q" }),
    )
    await expect(trash.remove("demo", old.readVersion)).rejects.toMatchObject({ status: 409 })
    await expect(trash.remove("../demo", old.readVersion)).rejects.toMatchObject({ status: 400 })
    const current = await reader.read("demo"),
      deleted = await trash.remove("demo", current.readVersion)
    await initProject(root, "demo", "New", "New")
    await expect(trash.restore(deleted.id)).rejects.toMatchObject({ status: 409 })
    expect(await trash.list()).toHaveLength(1)
    await expect(trash.restore("../demo")).rejects.toMatchObject({ status: 400 })
  })
  it("requires capability and exact Origin, then supports delete and restore", async () => {
    let viewer: ViewerServer | undefined
    try {
      viewer = await startViewer({ dataDir: root, port: 0 })
      const html = await (await fetch(viewer.url)).text(),
        token = html.match(/name="scad-session" content="([a-f0-9]+)"/)![1]!
      const snapshot = await new ProjectReader(root).read("demo"),
        path = `${viewer.url}/api/projects/demo?version=${snapshot.readVersion}`
      expect(
        (await fetch(path, { method: "DELETE", headers: { Origin: viewer.url } })).status,
      ).toBe(401)
      expect(
        (await fetch(path, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }))
          .status,
      ).toBe(403)
      const headers = { Authorization: `Bearer ${token}`, Origin: viewer.url }
      const response = await fetch(path, { method: "DELETE", headers })
      expect(response.status).toBe(200)
      const deleted = (await response.json()) as { id: string }
      expect(
        (await fetch(`${viewer.url}/api/trash/${deleted.id}/restore`, { method: "POST", headers }))
          .status,
      ).toBe(200)
      expect(await readFile(join(root, "demo", "memory", "unknown.bin"), "utf8")).toBe(
        "protected bytes",
      )
    } finally {
      await viewer?.close()
    }
  })
})
