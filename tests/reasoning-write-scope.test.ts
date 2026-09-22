import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import {
  ACTION_WRITE_SCOPE,
  ScopedMemory,
  WriteScopeViolationError,
  EPISTEMIC_WRITE_KEYS,
  CONTROL_WRITE_KEYS,
  readScopeFor,
} from "../src/core/memory/scoped-memory.js"
import { REASONING_ACTION_KINDS } from "../src/core/reasoning/types.js"

let dir: string
let memory: JsonMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-scope-"))
  memory = new JsonMemoryStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("v0.5 write-scope enforcement (ScopedMemory)", () => {
  it("declares the epistemic and control keys disjoint", () => {
    expect(EPISTEMIC_WRITE_KEYS.some((k) => CONTROL_WRITE_KEYS.includes(k as never))).toBe(false)
    expect(ACTION_WRITE_SCOPE.STOP).not.toContain(EPISTEMIC_WRITE_KEYS[0])
  })

  it("has a valid declared scope for every action kind", () => {
    for (const kind of REASONING_ACTION_KINDS) {
      expect(Array.isArray(ACTION_WRITE_SCOPE[kind])).toBe(true)
      expect(ACTION_WRITE_SCOPE[kind].length).toBeGreaterThan(0)
    }
  })

  it("RESEARCH may write research and intelligence but nothing else", async () => {
    const scoped = new ScopedMemory(memory, readScopeFor("RESEARCH"), true)
    await scoped.save("research", { sources: [] })
    await scoped.save("intelligence", { done: true })
    await expect(scoped.save("hypotheses", [])).rejects.toBeInstanceOf(WriteScopeViolationError)
    await expect(scoped.save("reasoning", {})).rejects.toBeInstanceOf(WriteScopeViolationError)
    await expect(scoped.remove("hypothesis-versions")).rejects.toBeInstanceOf(
      WriteScopeViolationError,
    )
  })

  it("hypothesis actions may touch the version log and pointers but never research", async () => {
    for (const kind of ["GENERATE_HYPOTHESIS", "REVISE_HYPOTHESIS", "REJECT_HYPOTHESIS"] as const) {
      const scoped = new ScopedMemory(memory, readScopeFor(kind), true)
      const allowed = ACTION_WRITE_SCOPE[kind]
      expect(allowed).toEqual(["hypotheses", "hypothesis-versions", "intelligence"])
      await scoped.save("hypotheses", [])
      await scoped.save("hypothesis-versions", [])
      await scoped.save("intelligence", {})
      await expect(scoped.save("research", {})).rejects.toBeInstanceOf(WriteScopeViolationError)
      await expect(scoped.save("reasoning", {})).rejects.toBeInstanceOf(WriteScopeViolationError)
    }
  })

  it("requesting human input and STOP may only write control state", async () => {
    for (const kind of ["REQUEST_HUMAN_INPUT", "STOP"] as const) {
      const scoped = new ScopedMemory(memory, readScopeFor(kind), true)
      await scoped.save("reasoning", {})
      await expect(scoped.save("intelligence", {})).rejects.toBeInstanceOf(WriteScopeViolationError)
      await expect(scoped.save("research", {})).rejects.toBeInstanceOf(WriteScopeViolationError)
    }
  })

  it("reads are never blocked by the envelope", async () => {
    await memory.save("hypotheses", [{ id: "HYP_001" }])
    const scoped = new ScopedMemory(memory, readScopeFor("RESEARCH"), true)
    expect(await scoped.get<{ id: string }[]>("hypotheses")).toEqual([{ id: "HYP_001" }])
  })

  it("enforce=false lets a read-only wrapper through without raising", async () => {
    const scoped = new ScopedMemory(memory, readScopeFor("RESEARCH"), false)
    await expect(scoped.save("reasoning", {})).resolves.toBeUndefined()
  })
})
