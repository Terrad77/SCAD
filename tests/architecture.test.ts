import { describe, it, expect } from "vitest"
import { readdir, readFile } from "node:fs/promises"
import { resolve, dirname, relative } from "node:path"

const SRC = resolve(process.cwd(), "src")

async function listTsFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)))
    else if (entry.name.endsWith(".ts")) files.push(full)
  }
  return files
}

const importRe = /\bimport\s+(type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g

/** Returns value imports (spec, importer, target) found in a file. */
async function valueImports(file: string): Promise<Array<[string, string]>> {
  const content = await readFile(file, "utf8")
  const found: Array<[string, string]> = []
  for (const match of content.matchAll(importRe)) {
    if (match[1] !== undefined) continue // type-only import
    const spec = match[2]
    if (spec.startsWith(".")) found.push([spec, resolve(dirname(file), spec)])
  }
  return found
}

describe("architecture boundaries", () => {
  it("only allows core to value-import providers/* from the shared http transport", async () => {
    const violations: string[] = []
    for (const file of await listTsFiles(resolve(SRC, "core"))) {
      for (const [spec, target] of await valueImports(file)) {
        const targetRel = relative(SRC, target).replace(/\\/g, "/")
        const importerRel = relative(SRC, file).replace(/\\/g, "/")
        if (!targetRel.startsWith("providers/")) continue
        if (targetRel === "providers/http.ts" && importerRel === "core/structured-agent.ts")
          continue
        if (targetRel === "providers/http.js" && importerRel === "core/structured-agent.ts")
          continue
        if (importerRel === "core/documentary.ts") continue
        violations.push(`${importerRel} imports ${spec} (${targetRel})`)
      }
    }
    expect(violations).toEqual([])
  })
})
