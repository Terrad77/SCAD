import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { ProjectReader, ViewerError } from "./project-reader.js"
export class ProjectTrash {
  private busy = false
  constructor(private readonly base: string) {}
  private async directory(create = true) {
    const root = await realpath(resolve(this.base)),
      path = join(root, ".scad-trash")
    if (create) await mkdir(path, { recursive: true })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new ViewerError(403, "UNSAFE_PATH", "Trash directory is unsafe")
    return { root, path }
  }
  async list() {
    let path: string
    try {
      path = (await this.directory(false)).path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const items: Array<{ id: string; project: string }> = []
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
      try {
        const record = await this.record(path, entry.name)
        items.push({ id: entry.name, project: record.project })
      } catch {
        /* Incomplete entries remain on disk for recovery. */
      }
    }
    return items
  }
  private async record(path: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new ViewerError(400, "INVALID_TRASH", "Invalid trash identifier")
    const folder = join(path, id),
      info = await lstat(folder)
    if (info.isSymbolicLink() || (await realpath(folder)) !== folder)
      throw new ViewerError(403, "UNSAFE_PATH", "Trash entry is unsafe")
    const metadata = await lstat(join(folder, "record.json"))
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new ViewerError(403, "UNSAFE_PATH", "Trash metadata is unsafe")
    const data: unknown = JSON.parse(await readFile(join(folder, "record.json"), "utf8"))
    if (
      !data ||
      typeof data !== "object" ||
      !("project" in data) ||
      typeof data.project !== "string" ||
      !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u.test(data.project) ||
      data.project.endsWith(".") ||
      data.project.endsWith(" ")
    )
      throw new ViewerError(400, "INVALID_TRASH", "Invalid trash record")
    const project = join(folder, "project"),
      projectInfo = await lstat(project)
    if (
      !projectInfo.isDirectory() ||
      projectInfo.isSymbolicLink() ||
      (await realpath(project)) !== project
    )
      throw new ViewerError(403, "UNSAFE_PATH", "Trashed project is unsafe")
    return { project: data.project, source: project }
  }
  async remove(name: string, version: string) {
    if (this.busy) throw new ViewerError(409, "BUSY", "Another project operation is running")
    this.busy = true
    try {
      const reader = new ProjectReader(this.base),
        snapshot = await reader.read(name)
      if (!version || snapshot.readVersion !== version)
        throw new ViewerError(409, "SNAPSHOT_CHANGED", "Project changed; refresh before deleting")
      if (snapshot.production.publication === "PUBLISHING")
        throw new ViewerError(409, "PUBLISHING", "Finish the pending publication before deleting")
      const { root, path } = await this.directory(),
        source = join(root, name),
        info = await lstat(source)
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(source)) !== source)
        throw new ViewerError(403, "UNSAFE_PATH", "Project directory is unsafe")
      const id = randomUUID(),
        destination = join(path, id)
      await mkdir(destination)
      await writeFile(join(destination, "record.json"), JSON.stringify({ project: name }), {
        flag: "wx",
      })
      await rename(source, join(destination, "project"))
      return { id, project: name }
    } finally {
      this.busy = false
    }
  }
  async restore(id: string) {
    if (this.busy) throw new ViewerError(409, "BUSY", "Another project operation is running")
    this.busy = true
    try {
      const { root, path } = await this.directory(),
        record = await this.record(path, id),
        destination = join(root, record.project)
      try {
        await lstat(destination)
        throw new ViewerError(409, "PROJECT_EXISTS", "A project with this name already exists")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await rename(record.source, destination)
      return { project: record.project }
    } finally {
      this.busy = false
    }
  }
}
