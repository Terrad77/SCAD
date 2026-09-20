import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises"
import { join, basename } from "node:path"

export interface CacheStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
}

interface CacheEntry {
  savedAt: number
  ttlMs?: number
  value: unknown
}

export interface FileCacheOptions {
  /** Directory where cache JSON files are stored. */
  dir?: string
  /** Time-to-live in milliseconds; undefined means no expiry. */
  ttlMs?: number
}

/**
 * Deterministic JSON file cache. Keys are hashed so arbitrary strings
 * (APIs, queries, URLs) never become unsafe filenames. Caching is disabled by
 * setting `CACHE_ENABLED=0`; the directory and TTL come from `SCAD_CACHE_DIR`
 * and `CACHE_TTL` respectively.
 */
export class FileCache implements CacheStore {
  private readonly dir: string
  private readonly ttlMs: number | undefined

  constructor(options: FileCacheOptions = {}) {
    this.dir = options.dir ?? process.env.SCAD_CACHE_DIR ?? "data/cache"
    this.ttlMs = options.ttlMs ?? ttlFromEnv()
  }

  get enabled(): boolean {
    return process.env.CACHE_ENABLED !== "0"
  }

  get location(): string {
    return this.dir
  }

  private keyPath(key: string): string {
    const hash = createHash("sha1").update(key).digest("hex")
    return join(this.dir, `${hash}.json`)
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.enabled) return null
    try {
      const raw = await readFile(this.keyPath(key), "utf8")
      const entry = JSON.parse(raw) as CacheEntry
      const ttl = entry.ttlMs ?? this.ttlMs
      if (ttl !== undefined && Date.now() - entry.savedAt > ttl) return null
      return entry.value as T
    } catch {
      return null
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.enabled) return
    await mkdir(this.dir, { recursive: true })
    const entry: CacheEntry = { savedAt: Date.now(), ttlMs: this.ttlMs, value }
    await writeFile(this.keyPath(key), JSON.stringify(entry), "utf8")
  }

  async clear(): Promise<void> {
    const entries = await readdir(this.dir).catch(() => [] as string[])
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => rm(join(this.dir, basename(name)), { force: true })),
    )
  }
}

function ttlFromEnv(): number | undefined {
  const raw = process.env.CACHE_TTL
  if (raw === undefined || raw === "") return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/** Default cache directory used by provider factories. */
export function defaultCacheDir(): string {
  return process.env.SCAD_CACHE_DIR ?? "data/cache"
}
