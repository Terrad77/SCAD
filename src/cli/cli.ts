import { JsonMemoryStore } from "../core/memory/json-memory.js"
import { HumanApprover } from "../core/human-approval.js"
import { runDocumentaryPipeline, renderScript } from "../core/documentary.js"
import { AutoApprover } from "../core/pipeline.js"
import type { ApprovalGate } from "../core/pipeline.js"
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
import { createSearchProvider } from "../providers/search/factory.js"
import type { SearchProvider } from "../providers/search/search-provider.js"
import { renderResearchReport } from "../agents/research/research-report.js"
import { TraceService } from "../core/trace.js"
import type { ResearchBundle } from "../core/schemas.js"
import type { HypothesisVerification } from "../core/schemas.js"

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

export function searchProviderFromEnv(): SearchProvider {
  return createSearchProvider({
    provider: process.env.SEARCH_PROVIDER,
    cache: process.env.SCAD_SEARCH_CACHE !== "0",
  })
}

interface Parsed {
  name?: string
  question?: string
  title?: string
  force: boolean
  interactive: boolean
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Parsed = { force: false, interactive: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--force" || arg === "-f") flags.force = true
    else if (arg === "--interactive" || arg === "-i") flags.interactive = true
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
  if (result.hypothesisVerifications?.length) {
    extras["hypothesis-verifications.json"] = JSON.stringify(
      result.hypothesisVerifications,
      null,
      2,
    )
  }
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
  const researchFiles = await writeResearchExtras(
    dir,
    result.research as unknown as ResearchBundle | undefined,
  )
  log(`Wrote ${files.length + researchFiles} artifacts to ${dir.outputDir}`)
  return 0
}

/** Writes the Evidence & Research Engine JSON files + markdown report. */
async function writeResearchExtras(
  dir: ReturnType<typeof projectDir>,
  research: ResearchBundle | undefined,
): Promise<number> {
  if (!research || !research.claims) return 0
  const extras: Record<string, string> = {
    "research-report.md": renderResearchReport(research),
    "plan.json": JSON.stringify(research.plan, null, 2),
    "sources.json": JSON.stringify(research.sources, null, 2),
    "evidence.json": JSON.stringify(research.evidence, null, 2),
    "claims.json": JSON.stringify(research.claims, null, 2),
    "contradictions.json": JSON.stringify(research.contradictions, null, 2),
    "gaps.json": JSON.stringify(research.gaps, null, 2),
  }
  return (await exportArtifacts(dir, {}, extras)).length
}

async function readResearch(memoryDir: string): Promise<ResearchBundle | null> {
  const store = new JsonMemoryStore(memoryDir)
  return (await store.get<ResearchBundle>("research")) ?? null
}

async function readVerifications(memoryDir: string): Promise<HypothesisVerification[]> {
  const store = new JsonMemoryStore(memoryDir)
  const hypotheses = await store.get<{ verifications?: HypothesisVerification[] }>("hypotheses")
  return hypotheses?.verifications ?? []
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
  interactive = false,
): Promise<number> {
  if (!name) {
    console.error("Usage: scad documentary <project-name> [--force] [--interactive]")
    return 1
  }
  if (!(await projectExists(DATA_DIR, name))) {
    await initProject(DATA_DIR, name, question, title)
  }
  const meta = await readMeta(DATA_DIR, name)
  const dir = projectDir(DATA_DIR, name)
  const memory = new JsonMemoryStore(dir.memoryDir)
  const approvals: ApprovalGate = interactive ? new HumanApprover(memory) : new AutoApprover()
  const result = await runDocumentaryPipeline({
    provider: providerFromEnv().provider,
    memoryDir: dir.memoryDir,
    question: meta?.question || question || name,
    title: meta?.title ?? title,
    force,
    approvals,
    search: searchProviderFromEnv(),
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
    question: meta?.question ?? name,
    title: meta?.title ?? name,
    force: false,
    search: searchProviderFromEnv(),
  })
  log(`Stage "${canonical}" processed.`)
  return outputArtifacts(dir, result)
}

async function hasStage(memoryDir: string, stage: string): Promise<boolean> {
  const store = new JsonMemoryStore(memoryDir)
  return (await store.get(stage)) !== null
}

function requireProject(name: string | undefined): ReturnType<typeof projectDir> | null {
  if (!name) {
    console.error("Usage: scad <sources|evidence|gaps|trace> <project-name>")
    return null
  }
  return projectDir(DATA_DIR, name)
}

export async function cmdSources(name: string | undefined): Promise<number> {
  const dir = requireProject(name)
  if (!dir) return 1
  const research = await readResearch(dir.memoryDir)
  if (!research) {
    log(`No research for project "${name}". Run "scad research ${name}" first.`)
    return 1
  }
  log(`Sources for "${name}" (${research.sources.length}):`)
  for (const s of research.sources) {
    log(`  [${s.id}] ${s.title} (${s.type}) — reliability ${s.reliability?.toFixed(2) ?? "n/a"}`)
  }
  return 0
}

export async function cmdEvidence(name: string | undefined): Promise<number> {
  const dir = requireProject(name)
  if (!dir) return 1
  const research = await readResearch(dir.memoryDir)
  if (!research) {
    log(`No research for project "${name}". Run "scad research ${name}" first.`)
    return 1
  }
  log(`Evidence for "${name}" (${research.evidence.length}):`)
  for (const e of research.evidence) {
    log(`  [${e.id}] (source ${e.sourceId}) confidence ${e.confidence.toFixed(2)} — ${e.statement}`)
  }
  return 0
}

export async function cmdContradictions(name: string | undefined): Promise<number> {
  const dir = requireProject(name)
  if (!dir) return 1
  const research = await readResearch(dir.memoryDir)
  if (!research) {
    log(`No research for project "${name}". Run "scad research ${name}" first.`)
    return 1
  }
  log(`Contradictions for "${name}" (${research.contradictions.length}):`)
  for (const c of research.contradictions) {
    log(
      `  [${c.id}] ${c.claimA} vs ${c.claimB} — ${c.severity} (${c.classification}): ${c.explanation}`,
    )
  }
  return 0
}

export async function cmdGaps(name: string | undefined): Promise<number> {
  const dir = requireProject(name)
  if (!dir) return 1
  const research = await readResearch(dir.memoryDir)
  if (!research) {
    log(`No research for project "${name}". Run "scad research ${name}" first.`)
    return 1
  }
  log(`Research gaps for "${name}" (${research.gaps.length}):`)
  for (const g of research.gaps) {
    log(`  [${g.id}] importance ${g.importance.toFixed(2)} — ${g.question}`)
    for (const q of g.suggestedResearchQueries.slice(0, 1)) log(`      → ${q}`)
  }
  return 0
}

export async function cmdTrace(name: string | undefined): Promise<number> {
  const dir = requireProject(name)
  if (!dir) return 1
  const research = await readResearch(dir.memoryDir)
  if (!research) {
    log(`No research for project "${name}". Run "scad research ${name}" first.`)
    return 1
  }
  const store = new JsonMemoryStore(dir.memoryDir)
  const narrative = await store.get("narrative")
  const visual = await store.get("visual")
  if (!narrative || !visual) {
    log(`Narrative/visual not ready. Run "scad documentary ${name}" first.`)
    return 1
  }
  const verifications = await readVerifications(dir.memoryDir)
  const service = new TraceService(research, verifications)
  const report = service.report(
    narrative as Parameters<typeof renderScript>[0],
    (visual as { shots: Parameters<typeof service.report>[1] }).shots,
  )
  const s = report.summary
  log(
    `Traceability for "${name}": ${s.totalShots} shots, ${s.fullyTraced} fully traced, ${s.partiallyTraced} partial, ${s.untraced} untraced`,
  )
  await exportArtifacts(dir, {}, { "traceability.json": JSON.stringify(report, null, 2) })
  return 0
}
