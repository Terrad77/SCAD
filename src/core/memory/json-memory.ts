import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises"
import { join, basename, extname } from "node:path"
import { fileURLToPath } from "node:url"

export interface MemoryStore {
  save<T>(key: string, value: T): Promise<void>
  get<T>(key: string): Promise<T | null>
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

  async save<T>(key: string, value: T): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(key), `${JSON.stringify(value, null, 2)}\n`, "utf8")
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await readFile(this.file(key), "utf8")
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async remove(key: string): Promise<void> {
    if (key.includes("/") || key.includes("\\")) return // reject nested keys
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
