import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"

let dir: string
let store: JsonMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-memory-"))
  store = new JsonMemoryStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("JsonMemoryStore", () => {
  it("saves and gets a value", async () => {
    await store.save("research", { ok: true })
    expect(await store.get("research")).toEqual({ ok: true })
  })

  it("returns null for a missing key", async () => {
    expect(await store.get("missing")).toBeNull()
  })

  it("rejects unsafe keys (path traversal) instead of writing outside the store", async () => {
    for (const key of ["../escape", "a/../b", "nested/dir", "..\\escape", ".hidden"]) {
      await expect(store.save(key, { value: 1 })).rejects.toThrow(/unsafe/)
      expect(await store.get(key)).toBeNull()
    }
    await expect(store.get("../escape")).resolves.toBeNull()
  })

  it("removes a key", async () => {
    await store.save("claims", [1])
    await store.remove("claims")
    expect(await store.get("claims")).toBeNull()
  })

  it("lists keys", async () => {
    await store.save("a", 1)
    await store.save("b", 2)
    const keys = (await store.keys()).sort()
    expect(keys).toEqual(["a", "b"])
  })

  it("searches JSON content", async () => {
    await store.save("research", { title: "Stars and Species" })
    const hits = await store.search("species")
    expect(hits).toHaveLength(1)
  })
})
