import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Source } from "../src/core/schemas.js"
import { FileCache } from "../src/providers/cache/file-cache.js"
import { FileSearchCache } from "../src/providers/search/cached-search-provider.js"
import type { SearchResult } from "../src/providers/search/search-provider.js"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-cache-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("FileCache", () => {
  it("persists and reads back values", async () => {
    const cache = new FileCache({ dir })
    await cache.set("api:query", { nested: [1, 2, 3] })
    expect(await cache.get("api:query")).toEqual({ nested: [1, 2, 3] })
    expect(await cache.get("other")).toBeNull()
  })

  it("expires entries after the TTL", async () => {
    vi.useFakeTimers()
    try {
      const cache = new FileCache({ dir, ttlMs: 10 })
      await cache.set("key", "v")
      expect(await cache.get("key")).toBe("v")
      vi.advanceTimersByTime(30)
      expect(await cache.get("key")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("respects CACHE_ENABLED=0 at construction time", async () => {
    const previous = process.env.CACHE_ENABLED
    process.env.CACHE_ENABLED = "0"
    try {
      const cache = new FileCache({ dir })
      await cache.set("key", "v")
      expect(await cache.get("key")).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CACHE_ENABLED
      else process.env.CACHE_ENABLED = previous
    }
  })

  it("does not write cache files when disabled", async () => {
    const previous = process.env.CACHE_ENABLED
    process.env.CACHE_ENABLED = "0"
    try {
      const cache = new FileCache({ dir })
      await cache.set("key", "v")
      expect(await cache.get("key")).toBeNull()
      const entries = await readdir(dir).catch(() => [] as string[])
      expect(entries).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.CACHE_ENABLED
      else process.env.CACHE_ENABLED = previous
    }
  })
})

describe("FileSearchCache", () => {
  const results: SearchResult[] = [{ id: "1", title: "A", url: "https://a" }]

  it("namespaces cache entries per provider", async () => {
    const backing = new FileCache({ dir })
    const alpha = new FileSearchCache(backing, "brave")
    const beta = new FileSearchCache(backing, "google")
    await alpha.set("q:species", results)
    expect(await alpha.get("q:species")).toEqual(results)
    expect(await beta.get("q:species")).toBeNull()
  })

  it("rejects non-array payloads", async () => {
    const backing = new FileCache({ dir })
    await backing.set("search:q", { not: "results" })
    const cache = new FileSearchCache(backing, "search")
    expect(await cache.get("q")).toBeNull()
  })

  it("round-trips sources through JSON persistence", async () => {
    const backing = new FileCache({ dir })
    const cache = new FileSearchCache(backing)
    const sources: Source[] = [
      { id: "SRC_001", title: "Study", type: "PAPER", url: "https://study" },
    ]
    await cache.set("k", [sources[0]!])
    const restored = await cache.get("k")
    expect(restored?.[0]?.title).toBe("Study")
  })
})
