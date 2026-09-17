import { runDocumentaryPipeline, renderScript } from "../src/core/documentary.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { DEMO_STAGE_RESPONSES } from "../src/providers/llm/mockFixtures.js"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { LLMRequest } from "../src/providers/llm/llm.js"

const provider = new MockLLMProvider((request: LLMRequest) => {
  const json = DEMO_STAGE_RESPONSES[request.meta?.stage ?? ""]
  return json ? { text: json } : null
})

const outDir = join(import.meta.dirname ?? process.cwd(), "..", "examples", "humanity-species")
mkdirSync(join(outDir, "output"), { recursive: true })

const result = await runDocumentaryPipeline({
  provider,
  memoryDir: outDir,
  question: "Can humanity become a new species?",
  title: "Species",
  force: true,
})

writeFileSync(join(outDir, "output", "script.md"), renderScript(result.narrative!), "utf-8")

console.log("✔ examples/humanity-species generated")
console.log(
  "  artifacts:",
  Object.keys(result).filter((k) => k !== "traceability"),
)
console.log("  shots:", result.visual?.shots.length)
console.log("  claims:", result.claims?.claims.length)
console.log("  fully traced:", result.traceability.summary.fullyTraced)
