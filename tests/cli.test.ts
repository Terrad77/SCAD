import { describe, it, expect } from "vitest"
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
