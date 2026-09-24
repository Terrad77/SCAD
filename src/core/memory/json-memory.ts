import { mkdir, readFile, writeFile, readdir, rm, rename } from "node:fs/promises"
import { join, basename, extname } from "node:path"
import { fileURLToPath } from "node:url"

export interface MemoryStore {
  save<T>(key: string, value: T): Promise<void>
  get<T>(key: string): Promise<T | null>
  /** v0.6 — raw file text (see JsonMemoryStore.readRaw): absent ⇒ null, corrupt ⇒ throws. */
  readRaw(key: string): Promise<string | null>
  search(query: string): Promise<unknown[]>
  keys(): Promise<string[]>
  remove(key: string): Promise<void>
}

export class JsonMemoryStore implements MemoryStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private file(key: string): string {
    return join(this.dir, `${key}.json`)
  }

  /**
   * Atomic replace (v0.6, F16): write to a same-directory temp file, then
   * rename over the target. Every single save is all-or-nothing, so a torn
   * write can never masquerade as a valid artifact. Non-`.json` temp files are
   * ignored by `keys()`.
   */
  async save<T>(key: string, value: T): Promise<void> {
    if (isUnsafeKey(key)) {
      throw new Error(`JsonMemoryStore: refusing unsafe store key "${key}"`)
    }
    await mkdir(this.dir, { recursive: true })
    const target = this.file(key)
    const temp = join(this.dir, `${key}.json.tmp`)
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(temp, target)
  }

  /**
   * Raw read (v0.6): returns the file text without JSON parsing so callers can
   * distinguish "absent" (file missing ⇒ `null`) from "corrupt" (present but
   * unparseable ⇒ throws). A missing file is the only `null` result; genuine
   * I/O failures surface loudly instead of being swallowed like `get`.
   */
  async readRaw(key: string): Promise<string | null> {
    if (isUnsafeKey(key)) return null
    try {
      return await readFile(this.file(key), "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null
      throw error
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (isUnsafeKey(key)) return null
    try {
      const raw = await readFile(this.file(key), "utf8")
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async remove(key: string): Promise<void> {
    if (isUnsafeKey(key)) return // reject nested keys
    await rm(join(this.dir, `${key}.json`), { force: true })
  }

  async search(query: string): Promise<unknown[]> {
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const result: unknown[] = []
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      try {
        const raw = await readFile(join(this.dir, entry), "utf8")
        const parsed = JSON.parse(raw) as unknown
        const haystack = JSON.stringify(parsed).toLowerCase()
        if (haystack.includes(query.toLowerCase())) result.push(parsed)
      } catch {
        // skip malformed files
      }
    }
    return result
  }

  async keys(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => basename(name, extname(name)))
  }

  get location(): string {
    return this.dir
  }
}

export const dataDir = (() => {
  const here = fileURLToPath(import.meta.url)
  return join(here, "..", "..", "..", "data", "projects")
})()

/** Nested/absolute keys would escape the store directory (path traversal). */
function isUnsafeKey(key: string): boolean {
  return key.includes("/") || key.includes("\\") || key.startsWith(".")
}

function isNodeError(error: unknown): error is { code: string } {
  return error instanceof Error && "code" in error
}
