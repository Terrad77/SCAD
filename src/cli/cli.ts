import { withProjectWrite } from "../application/project-write-coordinator.js"
import {
  ProductionIssueEngine,
  ISSUE_ACTIONS,
  type IssueAction,
} from "../core/production/issues.js"
import {
  assertNoPendingProductionRevision,
  ProductionRevisionEngine,
  REVISION_STAGES,
  revisionDiff,
  type RevisionStage,
  type ProductionRevision,
} from "../core/production/revisions.js"
import { contentSignature } from "../core/production/approval.js"
import { createRevisionGenerator } from "../agents/production/revision-generator.js"
import { JsonMemoryStore } from "../core/memory/json-memory.js"
import { ScopedMemory } from "../core/memory/scoped-memory.js"
import { PRODUCTION_WRITE_KEYS } from "../core/production/write-scope.js"
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
import { createContentProvider } from "../providers/content/factory.js"
import { CachedContentProvider } from "../providers/content/cached-content-provider.js"
import type { ContentProvider } from "../providers/content/content-provider.js"
import { FileCache, defaultCacheDir } from "../providers/cache/file-cache.js"
import { renderResearchReport } from "../agents/research/research-report.js"
import { TraceService } from "../core/trace.js"
import { StructuredAgent, readPromptFile } from "../core/structured-agent.js"
import { ReasoningEngine } from "../agents/reasoning/reasoning-engine.js"
import { ProductionEngine } from "../agents/production/production-engine.js"
import { isIntelligenceEnvelope } from "../agents/reasoning/intelligence-envelope.js"
import type { Hypothesis, ResearchBundle, ResearchIntelligenceReport } from "../core/schemas.js"
import type { SelfCheckOutput } from "../core/schemas.js"
import type { ReasoningContext } from "../core/production/types.js"
import type { HypothesisVerification } from "../core/schemas.js"

const DATA_DIR = process.env.SCAD_DATA_DIR ?? "data/projects"

export function log(text: string): void {
  console.log(`[scad] ${text}`)
}

/** Reads the persisted intelligence verdict, unwrapping the v0.6 envelope. */
export async function readIntelligenceReport(
  store: JsonMemoryStore,
): Promise<ResearchIntelligenceReport | null> {
  const raw = await store.get<unknown>("intelligence")
  if (raw === null) return null
  if (isIntelligenceEnvelope(raw)) return raw.report
  return raw as ResearchIntelligenceReport
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export function researchFromEnv(): NonNullable<
  Parameters<typeof runDocumentaryPipeline>[0]["research"]
> {
  return {
    maxSubQuestions: envInt("RESEARCH_MAX_QUERIES", 10),
    maxSourcesPerQuery: envInt("RESEARCH_MAX_RESULTS", 8),
    maxFollowUpRounds: envInt("RESEARCH_MAX_FOLLOWUP_ROUNDS", 1),
    maxSources: envInt("RESEARCH_MAX_SOURCES", 40),
    maxContentBytes: envInt("RESEARCH_MAX_CONTENT", 8_000),
  }
}

/** Optional ISO date that roots all freshness/reproducibility calculations. */
export function referenceDateFromEnv(): string | undefined {
  const raw = process.env.SCAD_REFERENCE_DATE
  if (raw === undefined || raw === "") return undefined
  if (!Number.isFinite(Date.parse(raw))) {
    log(`Ignoring invalid SCAD_REFERENCE_DATE "${raw}" (expected an ISO date).`)
    return undefined
  }
  return new Date(raw).toISOString()
}

export function providerFromEnv(): LLMInstance {
  return createLLMProvider({
    provider: process.env.LLM_PROVIDER ?? "opencode",
    opencodeModel: process.env.OPENCODE_MODEL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL,
    openaiModel: process.env.OPENAI_MODEL,
    anthropicModel: process.env.ANTHROPIC_MODEL,
  })
}

export function searchProviderFromEnv(provider?: string): SearchProvider {
  return createSearchProvider({
    provider: provider ?? process.env.SEARCH_PROVIDER,
    cache: process.env.SCAD_SEARCH_CACHE !== "0",
    cacheDir: defaultCacheDir(),
  })
}

/** Real content fetching is cached to JSON; offline providers stay untouched. */
export function contentProviderFromEnv(): ContentProvider {
  const base = createContentProvider()
  if (base.name !== "http") return base
  if (process.env.CACHE_ENABLED === "0" || process.env.SCAD_SEARCH_CACHE === "0") return base
  const cache = new FileCache({ dir: `${defaultCacheDir()}/content` })
  return new CachedContentProvider(base, cache)
}

interface Parsed {
  name?: string
  question?: string
  title?: string
  provider?: string
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
    else if (arg === "--provider") flags.provider = argv[++i]
    else if (!flags.name) flags.name = arg
  }
  return flags
}

const STAGE_ORDER = [
  "research",
  "claims",
  "hypotheses",
  "factCheck",
  "epistemicPreparation",
  "reasoningContext",
  "narrative",
  "visual",
  "selfCheck",
] as const
const STAGE_ALIASES: Record<string, string> = {
  shots: "visual",
  check: "selfCheck",
  "fact-check": "factCheck",
  "self-check": "selfCheck",
  "epistemic-preparation": "epistemicPreparation",
  "intelligence-prep": "epistemicPreparation",
  "reasoning-context": "reasoningContext",
  context: "reasoningContext",
}

/** Stage subcommands accepted by `scad <stage> <project>` (aliases included). */
export const STAGE_COMMANDS = new Set([
  ...STAGE_ORDER,
  "shots",
  "check",
  "fact-check",
  "self-check",
  "epistemic-preparation",
  "intelligence-prep",
  "reasoning-context",
  "context",
])

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
  if (result.intelligence) {
    extras["intelligence.json"] = JSON.stringify(result.intelligence, null, 2)
  }
  // v0.7: the reasoning→production handoff and its manifest.
  if (result.reasoningContext) {
    extras["reasoning-context.json"] = JSON.stringify(result.reasoningContext, null, 2)
  }
  if (result.production) {
    extras["production.json"] = JSON.stringify(result.production, null, 2)
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

async function cmdInitUnlocked(
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

async function cmdDocumentaryUnlocked(
  name: string | undefined,
  question: string,
  title: string,
  force: boolean,
  interactive = false,
  provider?: string,
): Promise<number> {
  if (!name) {
    console.error(
      "Usage: scad documentary <project-name> [--force] [--interactive] [--provider <mock|brave>]",
    )
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
    project: name,
    question: meta?.question || question || name,
    title: meta?.title ?? title,
    force,
    approvals,
    search: searchProviderFromEnv(provider),
    content: contentProviderFromEnv(),
    referenceDate: referenceDateFromEnv(),
    research: researchFromEnv(),
  })
  const sc = result.selfCheck
  log(
    `Self-check: ${sc?.critical.length ?? 0} critical, ${sc?.warnings.length ?? 0} warnings, ${sc?.info.length ?? 0} info`,
  )
  if (sc?.production) {
    log(
      `Production audit (v0.7): ${sc.production.verdict} — ${sc.production.checks.filter((c) => c.status === "FAIL").length} FAIL, ${sc.production.checks.filter((c) => c.status === "WARN").length} WARN, ${sc.production.diagnostics.length} diagnostics (no epistemic mutation)`,
    )
  }
  if (result.staleness?.stale) {
    const stale = result.staleness.artifacts.filter((a) => a.status === "STALE")
    log(
      `Stale production artifacts: ${stale.length ? stale.map((a) => a.artifact).join(", ") : "(missing)"} — regeneration is never automatic; rerun with --force.`,
    )
  }
  return outputArtifacts(dir, result)
}

/**
 * v0.7 — `scad production <project>`: inspects the reasoning→production handoff.
 * Read-only: it never rebuilds the context and never regenerates the film.
 */
async function cmdProductionUnlocked(
  name: string | undefined,
  subcommand?: string,
): Promise<number> {
  if (!name) {
    console.error("Usage: scad production <project-name> [context|constraints|stale|audit]")
    return 1
  }
  if (subcommand && !PRODUCTION_SUBCOMMANDS.includes(subcommand)) {
    console.error(`Unknown production view "${subcommand}".`)
    return 1
  }
  if (!(await projectExists(DATA_DIR, name))) {
    console.error(`Project "${name}" not found. Run "scad documentary ${name}" first.`)
    return 1
  }
  const dir = projectDir(DATA_DIR, name)
  const store = new JsonMemoryStore(dir.memoryDir)
  if (
    (await new ProductionRevisionEngine(store).history()).some((r) => r.status === "PUBLISHING")
  ) {
    throw new Error(
      "Publication is incomplete; use production resume before inspecting current artifacts",
    )
  }
  const context = await store.get<ReasoningContext>("reasoningContext")
  if (!context) {
    log(
      `No reasoning context for "${name}". Run "scad documentary ${name}" (or "scad reasoningContext ${name}") first.`,
    )
    return 1
  }
  const selfCheck = await store.get<SelfCheckOutput>("selfCheck")
  // Scoped to the production keys, so this inspection view is physically
  // read-only: it cannot write an artifact even by accident.
  const engine = new ProductionEngine(
    new ScopedMemory(store, new Set(PRODUCTION_WRITE_KEYS), false),
  )
  // v0.7 (H2): staleness is ALWAYS recomputed from what is on disk right now.
  // Reading the manifest's own recorded verdict meant an upstream edit after the
  // run left the CLI reporting every artifact as CURRENT. The manifest stays
  // readable for `production.json`, but the verdict here is live.
  const staleness = await engine.staleness(context)

  if (subcommand === "context" || subcommand === undefined) {
    const s = context.epistemicSummary
    log(
      `Reasoning context for "${name}" (v${context.version}, cycle ${context.reasoningCycleId ?? "none"}):`,
    )
    log(
      `  decision: ${context.decision.actionKind}, ${context.decision.status}, ${context.decision.stoppingKind ?? "unresolved"}, completed ${context.decision.cycleCompleted}`,
    )
    log(
      `  claims: ${s.usableClaimCount}/${s.claimCount} usable, ${s.qualifiedClaimCount} qualified, ${s.unsupportedClaimCount} unsupported`,
    )
    log(
      `  hypotheses: ${s.activeHypothesisCount}/${s.hypothesisCount} active, ${s.contradictionCount} contradictions, ${s.openGapCount} gaps, ${s.uncertaintyCount} uncertainties`,
    )
    log(`  completeness: ${s.completenessStatus}, continueResearch: ${s.continueResearch}`)
    log(`  inputSignature: ${context.inputSignature.slice(0, 16)}…`)
    log(`  contextSignature: ${context.contextSignature.slice(0, 16)}…`)
  }
  if (subcommand === "constraints" || subcommand === undefined) {
    log(`  production constraints (${context.constraints.length}):`)
    for (const c of context.constraints) {
      log(
        `    [${c.severity}] ${c.kind}${c.subjectIds.length ? ` → ${c.subjectIds.slice(0, 3).join(", ")}` : ""}`,
      )
      log(`        ${c.rule}`)
    }
  }
  if (subcommand === "stale" || subcommand === undefined) {
    log(
      `  staleness (autoRegenerate: ${staleness.autoRegenerate}): ${staleness.stale ? "STALE" : "CURRENT"}`,
    )
    for (const a of staleness.artifacts) {
      const why =
        a.reason === null ? "" : ` (${a.reason}${a.dependency ? `: ${a.dependency}` : ""})`
      log(
        `    [${a.status}] ${a.artifact}${why}${a.reasoningCycleId ? ` (cycle ${a.reasoningCycleId})` : ""}`,
      )
    }
  }
  if (subcommand === "audit" || subcommand === undefined) {
    const report = selfCheck?.production
    if (!report) {
      log("  no production audit recorded (run the selfCheck stage).")
    } else {
      log(`  production audit: ${report.verdict} (epistemicMutation: ${report.epistemicMutation})`)
      if (report.narrativeReferences) log(JSON.stringify(report.narrativeReferences, null, 2))
      for (const c of report.checks) log(`    [${c.status}] ${c.id}: ${c.detail}`)
      for (const d of report.diagnostics) {
        log(`    ${d.severity} ${d.kind} → ${d.route}: ${d.detail}`)
      }
    }
  }
  return 0
}

async function cmdStageUnlocked(
  stage: string,
  name: string | undefined,
  force: boolean,
  provider?: string,
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
  await assertNoPendingProductionRevision(new JsonMemoryStore(dir.memoryDir))

  const existing = await hasStage(dir.memoryDir, canonical)
  if (existing && !force) {
    log(`Stage "${canonical}" is already complete. Use --force to rerun.`)
    return 0
  }

  const result = await runDocumentaryPipeline({
    provider: providerFromEnv().provider,
    memoryDir: dir.memoryDir,
    project: name,
    question: meta?.question ?? name,
    title: meta?.title ?? name,
    force: false,
    forceStage: force ? canonical : undefined,
    search: searchProviderFromEnv(provider),
    content: contentProviderFromEnv(),
    referenceDate: referenceDateFromEnv(),
    research: researchFromEnv(),
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

async function cmdSourcesUnlocked(name: string | undefined): Promise<number> {
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

async function cmdEvidenceUnlocked(name: string | undefined): Promise<number> {
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

async function cmdContradictionsUnlocked(name: string | undefined): Promise<number> {
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

async function cmdGapsUnlocked(name: string | undefined): Promise<number> {
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

async function cmdTraceUnlocked(name: string | undefined): Promise<number> {
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
  const intelligence = await readIntelligenceReport(store)
  const service = new TraceService(research, verifications, intelligence ?? undefined)
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

const INTELLIGENCE_SUBCOMMANDS = [
  "quality",
  "completeness",
  "verify",
  "contradictions",
  "uncertainty",
]

/** v0.7 — read-only views over the reasoning→production handoff. */
const PRODUCTION_SUBCOMMANDS = ["context", "constraints", "stale", "audit"]

async function cmdIntelligenceUnlocked(
  name: string | undefined,
  subcommand: string | undefined,
): Promise<number> {
  if (!name) {
    console.error(
      "Usage: scad intelligence <project-name> [quality|completeness|verify|contradictions|uncertainty]",
    )
    return 1
  }
  if (subcommand && !INTELLIGENCE_SUBCOMMANDS.includes(subcommand)) {
    console.error(`Unknown intelligence view "${subcommand}".`)
    return 1
  }
  const dir = projectDir(DATA_DIR, name)
  const store = new JsonMemoryStore(dir.memoryDir)
  const intelligence = await readIntelligenceReport(store)
  if (!intelligence) {
    log(`No intelligence report for "${name}". Run "scad documentary ${name}" first.`)
    return 1
  }
  await exportArtifacts(dir, {}, { "intelligence.json": JSON.stringify(intelligence, null, 2) })
  if (subcommand === "quality") {
    log(`Evidence quality for "${name}":`)
    for (const q of intelligence.evidenceQuality) {
      log(
        `  [${q.evidenceId}] overall ${q.overall.toFixed(2)} (reliability ${q.dimensions.reliability.toFixed(2)}, strength ${q.dimensions.strength.toFixed(2)}, directness ${q.dimensions.directness.toFixed(2)}, specificity ${q.dimensions.specificity.toFixed(2)}, freshness ${q.dimensions.freshness.toFixed(2)})`,
      )
    }
  } else if (subcommand === "completeness") {
    const c = intelligence.completeness
    log(
      `Completeness for "${name}": ${c.score.toFixed(2)} (${c.status}) — ${c.dimensions.map((d) => `${d.label} ${d.score.toFixed(2)}`).join(", ")}`,
    )
  } else if (subcommand === "verify") {
    log(`Hypothesis verification for "${name}" (${intelligence.hypotheses.length}):`)
    for (const v of intelligence.hypotheses) {
      log(
        `  [${v.hypothesisId}] ${v.status} (${v.confidence.toFixed(2)}) independentSources ${v.independentSourceCount} — ${v.rationale.slice(0, 80)}`,
      )
    }
  } else if (subcommand === "contradictions") {
    log(`Contradiction analyses for "${name}" (${intelligence.contradictions.length}):`)
    for (const a of intelligence.contradictions) {
      log(`  [${a.contradictionId}] ${a.analysis} — ${a.reasons.join("; ")}`)
    }
  } else if (subcommand === "uncertainty") {
    log(`Explicit uncertainty for "${name}" (${intelligence.uncertainties.length}):`)
    for (const u of intelligence.uncertainties) {
      log(`  [${u.id}] ${u.kind} — ${u.detail}`)
    }
  } else {
    log(
      `Intelligence for "${name}": completeness ${intelligence.completeness.score.toFixed(2)} (${intelligence.completeness.status}), ${intelligence.sourceIndependence.independentSources} independent / ${intelligence.sourceIndependence.dependentSources} dependent / ${intelligence.sourceIndependence.unknownSources} unknown sources, ${intelligence.unresolvedContradictions.length} unresolved contradictions, ${intelligence.unresolvedGaps.length} critical gaps, continueResearch ${intelligence.continueResearch}`,
    )
  }
  return 0
}

/**
 * v0.5 — Reasoning & Hypothesis Evolution: runs the decision–effect cycle over
 * the v0.4 research artifacts and exports the reasoning trace + version log.
 */
async function cmdReasonUnlocked(
  name: string | undefined,
  force: boolean,
  provider?: string,
  interactive = false,
): Promise<number> {
  if (!name) {
    console.error(
      "Usage: scad reason <project-name> [--force] [--interactive] [--provider <mock|brave>]",
    )
    return 1
  }
  if (!(await projectExists(DATA_DIR, name))) {
    console.error(`Project "${name}" not found. Run "scad documentary ${name}" first.`)
    return 1
  }
  const meta = await readMeta(DATA_DIR, name)
  const dir = projectDir(DATA_DIR, name)
  const memory = new JsonMemoryStore(dir.memoryDir)
  await assertNoPendingProductionRevision(memory)

  const research = await memory.get<ResearchBundle>("research")
  if (!research) {
    console.error(`No research for "${name}". Run "scad documentary ${name}" first.`)
    return 1
  }
  const hypotheses =
    (await memory.get<{ hypotheses?: Hypothesis[] }>("hypotheses"))?.hypotheses ?? []

  const approvals: ApprovalGate = interactive ? new HumanApprover(memory) : new AutoApprover()

  const agent = new StructuredAgent(providerFromEnv().provider, readPromptFile)
  const engine = new ReasoningEngine({
    project: name,
    // Like cmdDocumentary/cmdStage, fall through an empty meta question to the
    // research baseline; the persisted reasoning state must stay schema-round-trippable.
    question: meta?.question?.trim() || research.question || name,
    memory,
    agent,
    search: searchProviderFromEnv(provider),
    research,
    hypotheses,
    approvals,
    humanInTheLoop: interactive,
    referenceDate: referenceDateFromEnv(),
  })

  const state = await engine.run({ force })
  const stopped = state.lastStopping
  log(
    `Reasoning for "${name}": status ${state.status}, ${state.steps.length} steps, cycle ${state.cycleContext?.cycleId ?? "none"}`,
  )
  if (stopped) log(`Stopped: ${stopped.stoppingKind} — ${stopped.reason}`)

  const extras: Record<string, string> = {
    "reasoning.json": JSON.stringify({ version: 1, state }, null, 2),
  }
  const versions = (await memory.get<unknown[]>("hypothesis-versions")) ?? []
  if (versions.length > 0) {
    extras["hypothesis-versions.json"] = JSON.stringify(versions, null, 2)
  }
  const active = await memory.get<unknown>("hypotheses")
  if (active) extras["hypotheses.json"] = JSON.stringify(active, null, 2)
  const intelligence = await readIntelligenceReport(memory)
  if (intelligence) extras["intelligence.json"] = JSON.stringify(intelligence, null, 2)
  await exportArtifacts(dir, {}, extras)
  return 0
}

/** v0.8: plans are read-only; revise requires the exact reviewed plan ID and human checkpoints. */
async function cmdProductionRevisionUnlocked(
  name: string | undefined,
  action: string,
  argument?: string,
  requested?: string,
): Promise<number> {
  if (!name || !(await projectExists(DATA_DIR, name))) {
    console.error("Existing project required for production revisions")
    return 1
  }
  const dir = projectDir(DATA_DIR, name)
  const memory = new JsonMemoryStore(dir.memoryDir)
  const engine = new ProductionRevisionEngine(memory)
  const stage = action === "plan" ? argument : requested
  if (stage !== undefined && !REVISION_STAGES.includes(stage as RevisionStage)) {
    console.error(`Unknown revision stage "${stage}"`)
    return 1
  }
  if (action === "plan") {
    const plan = await engine.plan(stage as RevisionStage | undefined)
    log(JSON.stringify(plan, null, 2))
    log(
      `Apply exactly this plan: scad production ${name} revise ${plan.id}${stage ? ` ${stage}` : ""}`,
    )
    return 0
  }
  if (action === "history" || action === "diff") {
    const history = await engine.history()
    if (action === "history")
      log(
        JSON.stringify(
          history.map((r) => ({ id: r.id, status: r.status, plan: r.plan })),
          null,
          2,
        ),
      )
    else {
      const revision = argument ? history.find((r) => r.id === argument) : history.at(-1)
      if (!revision) {
        console.error("Revision not found")
        return 1
      }
      log(JSON.stringify(revisionDiff(revision), null, 2))
    }
    return 0
  }
  if (action === "reject") {
    await engine.reject()
    log("Draft rejected; current production preserved")
    return 0
  }
  if (action === "revise" && argument === undefined) {
    console.error("A reviewed plan ID is required")
    return 1
  }
  const readOnly = new ScopedMemory(memory, new Set())
  const generate = createRevisionGenerator(readOnly, providerFromEnv().provider)
  const approvals = new HumanApprover(memory)
  let revision
  if (action === "resume") {
    const history = await engine.history()
    if (history.some((r) => r.status === "DRAFT" || r.status === "PUBLISHING"))
      revision = await engine.resume(generate, approvals)
    else {
      const latest = history.at(-1)
      if (!latest || latest.status !== "COMPLETED") throw new Error("No revision to resume")
      revision = latest
    }
  } else if (action === "revise") {
    const plan = await engine.plan(stage as RevisionStage | undefined)
    if (argument !== plan.id) {
      console.error("Plan ID changed or missing; review production plan first")
      return 1
    }
    revision = await engine.apply(plan, generate, approvals)
  } else {
    console.error(`Unknown revision action ${action}`)
    return 1
  }
  log(`Production revision ${revision.id}: ${revision.status}`)
  // Export only a completed snapshot. Resume can retry exports without generating again.
  await exportCompletedRevision(name, revision)
  return 0
}

async function exportCompletedRevision(name: string, revision: ProductionRevision) {
  if (revision.status !== "COMPLETED") throw new Error("Completed revision required for export")
  const dir = projectDir(DATA_DIR, name)
  const c = revision.candidate
  const memory = new JsonMemoryStore(dir.memoryDir)
  for (const key of [
    "reasoningContext",
    "narrative",
    "visual",
    "selfCheck",
    "production",
  ] as const) {
    if (contentSignature(await memory.get(key)) !== contentSignature(c[key]))
      throw new Error("Revision snapshot is no longer canonical; export refused")
  }
  await exportArtifacts(
    dir,
    {
      reasoningContext: c.reasoningContext,
      narrative: c.narrative,
      visual: c.visual,
      selfCheck: c.selfCheck,
    },
    {
      "production.json": JSON.stringify(c.production, null, 2),
      "script.md": renderScript(c.narrative!),
      "production-revision.json": JSON.stringify(revision, null, 2),
    },
  )
  return 0
}

/** Explicit human workflow; read-only listing never synchronizes findings. */
async function cmdProductionIssuesUnlocked(
  name: string | undefined,
  action = "list",
  id?: string,
  choice?: string,
  note?: string,
): Promise<number> {
  if (!name || !(await projectExists(DATA_DIR, name))) throw new Error("Existing project required")
  const memory = new JsonMemoryStore(projectDir(DATA_DIR, name).memoryDir)
  const engine = new ProductionIssueEngine(memory)
  if (action === "list") {
    log(JSON.stringify(await engine.list(), null, 2))
    return 0
  }
  if (action === "sync") {
    log(JSON.stringify(await engine.sync(), null, 2))
    return 0
  }
  if (!id) throw new Error("Issue ID required")
  if (action === "show") {
    log(JSON.stringify(await engine.inspect(id), null, 2))
    return 0
  }
  if (action === "verify") {
    log(JSON.stringify(await engine.verify(id), null, 2))
    return 0
  }
  const approvals = new HumanApprover(memory)
  // Lazy provider construction: defer, dismiss and handoff need no LLM.
  const generate =
    choice === "fix" ||
    (action === "resume" &&
      (await engine.list()).find((i) => i.id === id)?.operations.at(-1)?.action === "fix")
      ? createRevisionGenerator(new ScopedMemory(memory, new Set()), providerFromEnv().provider)
      : undefined
  let result
  if (action === "resume") result = await engine.resume(id, approvals, generate)
  else if (action === "decide" && ISSUE_ACTIONS.includes(choice as IssueAction) && note)
    result = await engine.decide(id, choice as IssueAction, note, approvals, generate)
  else
    throw new Error(
      "Usage: production <project> issues [list|show ID|sync|verify ID|resume ID|decide ID fix|research|reasoning|defer|dismiss rationale]",
    )
  const operation = result.operations.at(-1)
  if (operation?.action === "fix" && operation.status === "COMPLETED" && operation.revisionId) {
    const revision = (await new ProductionRevisionEngine(memory).history()).find(
      (r) => r.id === operation.revisionId,
    )
    if (!revision) throw new Error("Linked revision missing")
    await exportCompletedRevision(name, revision)
  }
  log(JSON.stringify(result, null, 2))
  return 0
}

export async function cmdInit(...args: Parameters<typeof cmdInitUnlocked>): Promise<number> {
  const project = args[0]
  if (!project) return cmdInitUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdInit", () => cmdInitUnlocked(...args))
}

export async function cmdDocumentary(
  ...args: Parameters<typeof cmdDocumentaryUnlocked>
): Promise<number> {
  const project = args[0]
  if (!project) return cmdDocumentaryUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdDocumentary", () =>
    cmdDocumentaryUnlocked(...args),
  )
}

export async function cmdProduction(
  ...args: Parameters<typeof cmdProductionUnlocked>
): Promise<number> {
  return cmdProductionUnlocked(...args)
}

export async function cmdStage(...args: Parameters<typeof cmdStageUnlocked>): Promise<number> {
  const project = args[1]
  if (!project) return cmdStageUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdStage", () => cmdStageUnlocked(...args))
}

export async function cmdSources(...args: Parameters<typeof cmdSourcesUnlocked>): Promise<number> {
  return cmdSourcesUnlocked(...args)
}

export async function cmdEvidence(
  ...args: Parameters<typeof cmdEvidenceUnlocked>
): Promise<number> {
  return cmdEvidenceUnlocked(...args)
}

export async function cmdContradictions(
  ...args: Parameters<typeof cmdContradictionsUnlocked>
): Promise<number> {
  return cmdContradictionsUnlocked(...args)
}

export async function cmdGaps(...args: Parameters<typeof cmdGapsUnlocked>): Promise<number> {
  return cmdGapsUnlocked(...args)
}

export async function cmdTrace(...args: Parameters<typeof cmdTraceUnlocked>): Promise<number> {
  const project = args[0]
  if (!project) return cmdTraceUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdTrace", () => cmdTraceUnlocked(...args))
}

export async function cmdIntelligence(
  ...args: Parameters<typeof cmdIntelligenceUnlocked>
): Promise<number> {
  const project = args[0]
  if (!project) return cmdIntelligenceUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdIntelligence", () =>
    cmdIntelligenceUnlocked(...args),
  )
}

export async function cmdReason(...args: Parameters<typeof cmdReasonUnlocked>): Promise<number> {
  const project = args[0]
  if (!project) return cmdReasonUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdReason", () => cmdReasonUnlocked(...args))
}

export async function cmdProductionRevision(
  ...args: Parameters<typeof cmdProductionRevisionUnlocked>
): Promise<number> {
  const project = args[0]
  if (!project) return cmdProductionRevisionUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdProductionRevision", () =>
    cmdProductionRevisionUnlocked(...args),
  )
}

export async function cmdProductionIssues(
  ...args: Parameters<typeof cmdProductionIssuesUnlocked>
): Promise<number> {
  const project = args[0]
  if (!project) return cmdProductionIssuesUnlocked(...args)
  return withProjectWrite(DATA_DIR, project, "cli:cmdProductionIssues", () =>
    cmdProductionIssuesUnlocked(...args),
  )
}
