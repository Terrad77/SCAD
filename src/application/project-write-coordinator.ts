import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ViewerError } from "./project-reader.js"
export function validateProjectId(name: string) {
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ||
    name.endsWith(".") ||
    name.endsWith(" ")
  )
    throw new ViewerError(400, "INVALID_PROJECT", "Invalid project identifier")
}
/** Stable root-level ownership survives project moves. Never steals an existing lock. */
export async function withProjectWrite<T>(
  base: string,
  name: string,
  action: string,
  work: () => Promise<T>,
): Promise<T> {
  validateProjectId(name)
  await mkdir(resolve(base), { recursive: true })
  const root = await realpath(resolve(base)),
    folder = join(root, ".scad-writes")
  await mkdir(folder, { recursive: true })
  const info = await lstat(folder)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(folder)) !== folder)
    throw new ViewerError(403, "UNSAFE_PATH", "Write coordinator directory is unsafe")
  const key = createHash("sha256").update(name.normalize("NFC").toLowerCase()).digest("hex"),
    path = join(folder, key)
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ViewerError(
        409,
        "PROJECT_BUSY",
        "Project is busy or an interrupted operation needs recovery. Do not remove its lock while a SCAD process is running.",
      )
    throw error
  }
  const owner = randomUUID(),
    record = join(path, "owner.json")
  let recorded = false
  try {
    await writeFile(record, JSON.stringify({ owner, project: name, action, pid: process.pid }), {
      flag: "wx",
    })
    recorded = true
    const projectPath = join(root, name)
    try {
      const projectInfo = await lstat(projectPath)
      if (
        !projectInfo.isDirectory() ||
        projectInfo.isSymbolicLink() ||
        (await realpath(projectPath)) !== projectPath
      )
        throw new ViewerError(403, "UNSAFE_PATH", "Project directory is unsafe")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return await work()
  } finally {
    // A missing or replaced ownership record must never unlock another operation.
    const saved: unknown = recorded ? JSON.parse(await readFile(record, "utf8")) : null
    if (saved && typeof saved === "object" && "owner" in saved && saved.owner === owner) {
      const lockInfo = await lstat(path)
      if (lockInfo.isDirectory() && !lockInfo.isSymbolicLink() && (await realpath(path)) === path)
        await rm(path, { recursive: true })
    }
  }
}
