import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { ProjectTrash } from "../src/application/project-trash.js"
import { ProjectReader } from "../src/application/project-reader.js"
import { initProject } from "../src/storage/project-store.js"
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-write-test-"))
  await initProject(root, "demo", "Q", "Demo")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe("shared project writer", () => {
  it("rejects a writer in another Node process", async () => {
    const moduleUrl = new URL("../src/application/project-write-coordinator.ts", import.meta.url)
      .href
    await withProjectWrite(root, "demo", "parent", async () => {
      const code =
        "import { withProjectWrite } from " +
        JSON.stringify(moduleUrl) +
        "; try { await withProjectWrite(" +
        JSON.stringify(root) +
        ', "demo", "child", async () => {}); process.exitCode = 9 } catch(error) { console.log(error.code) }'
      const result = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        { timeout: 10000 },
      )
      expect(result.stdout.trim()).toBe("PROJECT_BUSY")
    })
  }, 15000)

  it("excludes independent writers and case aliases while allowing another project", async () => {
    await withProjectWrite(root, "demo", "first", async () => {
      await expect(withProjectWrite(root, "demo", "second", async () => 1)).rejects.toMatchObject({
        status: 409,
      })
      await expect(withProjectWrite(root, "DEMO", "alias", async () => 1)).rejects.toMatchObject({
        status: 409,
      })
      expect(await withProjectWrite(root, "other", "other", async () => 2)).toBe(2)
    })
    expect(await withProjectWrite(root, "demo", "next", async () => 3)).toBe(3)
    expect(await readdir(join(root, ".scad-writes"))).toEqual([])
    expect((await new ProjectReader(root).list()).map((p) => p.id)).toEqual(["demo"])
  })
  it("releases after a failed operation and rejects unsafe names before creating coordinator files", async () => {
    await expect(withProjectWrite(root, "../outside", "bad", async () => 1)).rejects.toMatchObject({
      status: 400,
    })
    expect(await readdir(root)).toEqual(["demo"])
    await expect(
      withProjectWrite(root, "demo", "failure", async () => {
        throw Error("domain failure")
      }),
    ).rejects.toThrow("domain failure")
    expect(await withProjectWrite(root, "demo", "retry", async () => true)).toBe(true)
  })
  it("refuses trash while a writer owns the project and locks restoration against concurrent work", async () => {
    const trash = new ProjectTrash(root),
      snapshot = await new ProjectReader(root).read("demo")
    await withProjectWrite(root, "demo", "cli", async () => {
      await expect(trash.remove("demo", snapshot.readVersion)).rejects.toMatchObject({
        status: 409,
      })
    })
    const deleted = await trash.remove("demo", snapshot.readVersion)
    await withProjectWrite(root, "demo", "cli", async () => {
      await expect(trash.restore(deleted.id)).rejects.toMatchObject({ status: 409 })
    })
    await trash.restore(deleted.id)
  })
  it("never unlocks an ownership record replaced by another owner", async () => {
    await withProjectWrite(root, "demo", "test", async () => {
      const dirs = await readdir(join(root, ".scad-writes"))
      await writeFile(
        join(root, ".scad-writes", dirs[0]!, "owner.json"),
        JSON.stringify({ owner: "another" }),
      )
    })
    await expect(withProjectWrite(root, "demo", "new", async () => 1)).rejects.toMatchObject({
      status: 409,
    })
  })
})
