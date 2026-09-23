import { describe, it, expect, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { STAGE_COMMANDS } from "../src/cli/cli.js"
import { PIPELINE_ORDER } from "../src/core/pipeline.js"

describe("CLI stage commands", () => {
  it("registers every canonical stage and its aliases", () => {
    for (const stage of PIPELINE_ORDER) {
      expect(STAGE_COMMANDS.has(stage)).toBe(true)
    }
    for (const alias of ["shots", "check", "fact-check", "self-check"]) {
      expect(STAGE_COMMANDS.has(alias)).toBe(true)
    }
    expect(STAGE_COMMANDS.has("nonsense-stage")).toBe(false)
  })
})

describe("CLI reason — empty project question resume (v0.5 regression)", () => {
  it("falls back to the research question so the persisted state stays re-readable", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "scad-reason-empty-q-"))
    process.env.SCAD_DATA_DIR = baseDir
    process.env.LLM_PROVIDER = "mock"
    vi.resetModules()
    try {
      const { initProject } = await import("../src/storage/project-store.js")
      const { cmdReason } = await import("../src/cli/cli.js")
      const { JsonMemoryStore } = await import("../src/core/memory/json-memory.js")
      const { makeResearchBundle } = await import("./fixtures.js")

      // A project initialized without --question stores an empty meta question;
      // the research baseline is the authoritative question (per cmdDocumentary).
      const dir = await initProject(baseDir, "empty-q", "", "Empty Question")
      const memory = new JsonMemoryStore(dir.memoryDir)
      await memory.save("research", makeResearchBundle({ question: "empty-q" }))
      await memory.save("hypotheses", [])

      const code = await cmdReason("empty-q", true, "mock")
      expect(code).toBe(0)

      // The persisted state must not contain an empty question: it is read back
      // through ReasoningStateVersionSchema, which requires a non-empty one.
      const saved = await memory.get<{ state: { question: string; status: string } }>("reasoning")
      expect(saved?.state.question.length).toBeGreaterThan(0)
      expect(saved?.state.question).toBe("empty-q")
      expect(saved?.state.status).toBe("STOPPED")

      // Resume must not crash re-parsing the stored state (deterministic resume).
      const resumeCode = await cmdReason("empty-q", false, "mock")
      expect(resumeCode).toBe(0)
    } finally {
      delete process.env.SCAD_DATA_DIR
      delete process.env.LLM_PROVIDER
      vi.resetModules()
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})
