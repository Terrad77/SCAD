import { JsonMemoryStore } from "../core/memory/json-memory.js"
import { runDocumentaryPipeline, renderScript } from "../core/documentary.js"
import {
  exportArtifacts,
  initProject,
  projectDir,
  readMeta,
  projectExists,
  listProjects,
} from "../storage/project-store.js"
import { createLLMProvider } from "../providers/llm/factory.js"
import type { LLMInstance } from "../providers/llm/factory.js"

const DATA_DIR = process.env.SCAD_DATA_DIR ?? "data/projects"

export function log(text: string): void {
  console.log(`[scad] ${text}`)
}

export function providerFromEnv(): LLMInstance {
  return createLLMProvider({
    provider: process.env.LLM_PROVIDER ?? "opencode",
    opencodeModel: process.env.OPENCODE_MODEL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL,
  })
}

interface Parsed {
  name?: string
  question?: string
  title?: string
  force: boolean
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Parsed = { force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--force" || arg === "-f") flags.force = true
    else if (arg === "--question") flags.question = argv[++i]
    else if (arg === "--title") flags.title = argv[++i]
    else if (!flags.name) flags.name = arg
  }
  return flags
}

const STAGE_ORDER = [
  "research",
  "claims",
  "hypotheses",
  "factCheck",
  "narrative",
  "visual",
  "selfCheck",
] as const
const STAGE_ALIASES: Record<string, string> = {
  shots: "visual",
  check: "selfCheck",
  "fact-check": "factCheck",
  "self-check": "selfCheck",
}

async function outputArtifacts(
  dir: ReturnType<typeof projectDir>,
  result: Awaited<ReturnType<typeof runDocumentaryPipeline>>,
): Promise<number> {
  const extras: Record<string, string> = {}
  if (result.narrative) extras["script.md"] = renderScript(result.narrative)
  extras["traceability.json"] = JSON.stringify(result.traceability, null, 2)
  const files = await exportArtifacts(
    dir,
    {
      research: result.research,
      claims: result.claims,
      hypotheses: result.hypotheses,
      factCheck: result.factCheck,
      narrative: result.narrative,
      visual: result.visual,
      selfCheck: result.selfCheck,
    },
    extras,
  )
  log(`Wrote ${files.length} artifacts to ${dir.outputDir}`)
  return 0
}

export async function cmdInit(
  name: string | undefined,
  question: string,
  title: string,
): Promise<number> {
  if (!name) {
    console.error('Usage: scad init <project-name> [--question "..."] [--title "..."]')
    return 1
  }
  await initProject(DATA_DIR, name, question, title)
  log(`Initialized project "${name}" at ${projectDir(DATA_DIR, name).base}`)
  return 0
}

export async function cmdList(): Promise<number> {
  log(`Projects in ${DATA_DIR}:`)
  for (const name of await listProjects(DATA_DIR)) log(`  - ${name}`)
  return 0
}

export async function cmdDocumentary(
  name: string | undefined,
  question: string,
  title: string,
  force: boolean,
): Promise<number> {
  if (!name) {
    console.error("Usage: scad documentary <project-name> [--force]")
    return 1
  }
  if (!(await projectExists(DATA_DIR, name))) {
    await initProject(DATA_DIR, name, question, title)
  }
  const meta = await readMeta(DATA_DIR, name)
  const dir = projectDir(DATA_DIR, name)
  const result = await runDocumentaryPipeline({
    provider: providerFromEnv().provider,
    memoryDir: dir.memoryDir,
    question: meta?.question ?? question,
    title: meta?.title ?? title,
    force,
  })
  const sc = result.selfCheck
  log(
    `Self-check: ${sc?.critical.length ?? 0} critical, ${sc?.warnings.length ?? 0} warnings, ${sc?.info.length ?? 0} info`,
  )
  return outputArtifacts(dir, result)
}

export async function cmdStage(
  stage: string,
  name: string | undefined,
  force: boolean,
): Promise<number> {
  const canonical = STAGE_ALIASES[stage] ?? stage
  if (!STAGE_ORDER.includes(canonical as (typeof STAGE_ORDER)[number])) {
    console.error(`Unknown stage "${stage}".`)
    return 1
  }
  if (!name) {
    console.error(`Usage: scad ${stage} <project-name> [--force]`)
    return 1
  }
  if (!(await projectExists(DATA_DIR, name))) {
    console.error(`Project "${name}" not found. Run "scad init ${name}" first.`)
    return 1
  }
  const meta = await readMeta(DATA_DIR, name)
  const dir = projectDir(DATA_DIR, name)

  const existing = await hasStage(dir.memoryDir, canonical)
  if (existing && !force) {
    log(`Stage "${canonical}" is already complete. Use --force to rerun.`)
    return 0
  }

  const result = await runDocumentaryPipeline({
    provider: providerFromEnv().provider,
    memoryDir: dir.memoryDir,
    question: meta?.question ?? "",
    title: meta?.title ?? name,
    force: false,
  })
  log(`Stage "${canonical}" processed.`)
  return outputArtifacts(dir, result)
}

async function hasStage(memoryDir: string, stage: string): Promise<boolean> {
  const store = new JsonMemoryStore(memoryDir)
  return (await store.get(stage)) !== null
}
