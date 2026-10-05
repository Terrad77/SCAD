import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { MemoryStore } from "../core/memory/json-memory.js"
import {
  ClaimsOutputSchema,
  FactCheckOutputSchema,
  HypothesesOutputSchema,
  HypothesisVerificationSchema,
  NarrativeSchema,
  ResearchBundleSchema,
  ResearchOutputSchema,
  SelfCheckOutputSchema,
  VisualOutputSchema,
  ResearchIntelligenceReportSchema,
  type Narrative,
  type VisualOutput,
  type ResearchBundle,
} from "../core/schemas.js"
import { ReasoningContextSchema, ProductionManifestSchema } from "../core/production/schemas.js"
import { HypothesisVersionSchema, IntelligenceEnvelopeSchema } from "../core/reasoning/schemas.js"
import {
  loadReasoningCursor,
  readReasoningCycles,
  readDecisions,
} from "../agents/reasoning/reasoning-repository.js"
import { ProductionEngine } from "../agents/production/production-engine.js"
import { ProductionIssueEngine, contentChecks } from "../core/production/issues.js"
import { ProductionRevisionEngine, revisionDiff } from "../core/production/revisions.js"
import { contentSignature } from "../core/production/approval.js"
import { auditProduction } from "../core/production/self-check-rules.js"
import type {
  ReasoningContext,
  ProductionStaleness,
  SelfCheckProductionReport,
} from "../core/production/types.js"
import { TraceService } from "../core/trace.js"

const KEYS = [
  "research",
  "claims",
  "hypotheses",
  "factCheck",
  "intelligence",
  "hypothesis-versions",
  "epistemicPreparation",
  "reasoning",
  "reasoning-history",
  "decisions",
  "reasoningContext",
  "narrative",
  "visual",
  "selfCheck",
  "production",
  "production-revisions",
  "production-issues",
] as const
type Key = (typeof KEYS)[number]
export type FileState = {
  status: "VALID" | "MISSING" | "CORRUPT" | "UNREADABLE"
  reason: string | null
}
type RawFile = { raw: string | null; error: boolean }
type Capture = Record<string, RawFile>
const MetaSchema = z.object({ project: z.string(), question: z.string(), title: z.string() })
const SCHEMAS: Partial<Record<Key, z.ZodTypeAny>> = {
  research: ResearchBundleSchema.or(ResearchOutputSchema.strict()),
  claims: ClaimsOutputSchema,
  hypotheses: HypothesesOutputSchema.extend({
    verifications: z.array(HypothesisVerificationSchema).optional(),
  }),
  factCheck: FactCheckOutputSchema,
  narrative: NarrativeSchema,
  visual: VisualOutputSchema,
  selfCheck: SelfCheckOutputSchema,
  reasoningContext: ReasoningContextSchema,
  production: ProductionManifestSchema,
  intelligence: IntelligenceEnvelopeSchema.or(ResearchIntelligenceReportSchema),
  "hypothesis-versions": z.array(HypothesisVersionSchema),
  epistemicPreparation: z
    .object({
      inputs: z
        .object({
          limits: z
            .object({
              maxSources: z.number().optional(),
              maxSubQuestions: z.number().optional(),
              maxFollowUpRounds: z.number().optional(),
            })
            .optional(),
        })
        .passthrough(),
    })
    .passthrough(),
}
export class ViewerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}
function version(files: Capture) {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex")
}
/** Immutable, physically read-only store for existing engines; never rereads disk. */
export class SnapshotMemory implements MemoryStore {
  constructor(private readonly files: Capture) {}
  async readRaw(key: string) {
    const entry = this.files[key]
    if (entry?.error) throw new Error("Unreadable snapshot artifact")
    return entry?.raw ?? null
  }
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.readRaw(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  }
  async keys() {
    return Object.keys(this.files).filter((k) => this.files[k]?.raw !== null)
  }
  async search(_query: string): Promise<unknown[]> {
    return []
  }
  async save(): Promise<void> {
    throw new Error("Viewer memory is read-only")
  }
  async remove(): Promise<void> {
    throw new Error("Viewer memory is read-only")
  }
}
export type TraceNode = {
  id: string
  kind: string
  status: "FOUND" | "MISSING" | "AMBIGUOUS" | "UNAVAILABLE"
  data: unknown
}
export type TraceGraph = {
  subjectId: string
  readVersion: string
  nodes: TraceNode[]
  edges: Array<{ from: string; to: string; relation: string; supported: boolean | null }>
  notices: string[]
}

export class ProjectReader {
  constructor(
    private readonly base: string,
    private readonly options: { attempts?: number; afterCapture?: () => Promise<void> } = {},
  ) {}
  private async root() {
    try {
      return await realpath(resolve(this.base))
    } catch (error) {
      if (missing(error)) throw new ViewerError(404, "ROOT_MISSING", "Project directory not found")
      throw new ViewerError(403, "ROOT_UNREADABLE", "Project directory is unavailable")
    }
  }
  private async directory(name: string) {
    if (
      !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u.test(name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ||
      name.endsWith(".") ||
      name.endsWith(" ")
    )
      throw new ViewerError(400, "INVALID_PROJECT", "Invalid project identifier")
    const root = await this.root(),
      path = join(root, name)
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(path)))
        throw new ViewerError(
          403,
          "UNSAFE_PATH",
          "Links and directories outside the project root are not supported",
        )
      return path
    } catch (error) {
      if (error instanceof ViewerError) throw error
      throw new ViewerError(
        missing(error) ? 404 : 403,
        "PROJECT_UNAVAILABLE",
        "Project is unavailable",
      )
    }
  }
  private async file(project: string, path: string): Promise<RawFile> {
    try {
      const parent = await lstat(join(path, ".."))
      if (parent.isSymbolicLink())
        throw new ViewerError(403, "UNSAFE_PATH", "Linked directories are not supported")
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() || !inside(project, await realpath(path)))
        throw new ViewerError(403, "UNSAFE_PATH", "File is outside the allowed project directory")
      if (info.size > 16 * 1024 * 1024)
        throw new ViewerError(413, "ARTIFACT_TOO_LARGE", "Artifact exceeds the 16 MB viewer limit")
      return { raw: await readFile(path, "utf8"), error: false }
    } catch (error) {
      if (error instanceof ViewerError) throw error
      return { raw: null, error: !missing(error) }
    }
  }
  private async capture(project: string): Promise<Capture> {
    const values = await Promise.all([
      this.file(project, join(project, "project.json")),
      ...KEYS.map((k) => this.file(project, join(project, "memory", `${k}.json`))),
    ])
    if (
      values.reduce((size, file) => size + Buffer.byteLength(file.raw ?? ""), 0) >
      64 * 1024 * 1024
    )
      throw new ViewerError(413, "SNAPSHOT_TOO_LARGE", "Snapshot exceeds the 64 MB viewer limit")
    return Object.fromEntries(["meta", ...KEYS].map((k, index) => [k, values[index]!]))
  }
  private async stable(name: string) {
    for (let attempt = 0; attempt < (this.options.attempts ?? 3); attempt++) {
      const project = await this.directory(name),
        files = await this.capture(project)
      await this.options.afterCapture?.()
      const again = await this.directory(name)
      if (project === again && version(files) === version(await this.capture(again))) return files
    }
    throw new ViewerError(
      409,
      "UNSTABLE_SNAPSHOT",
      "Project files changed while being read. Refresh the project later.",
    )
  }
  private parse<T>(
    files: Capture,
    key: string,
    schema: z.ZodType<T>,
    states: Record<string, FileState>,
  ): T | null {
    const entry = files[key]!
    if (entry.error) {
      states[key] = { status: "UNREADABLE", reason: "Unable to read the file" }
      return null
    }
    if (entry.raw === null) {
      states[key] = { status: "MISSING", reason: null }
      return null
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(entry.raw)
    } catch {
      states[key] = {
        status: "CORRUPT",
        reason: "Invalid JSON syntax: the file could not be parsed",
      }
      return null
    }
    const result = schema.safeParse(decoded)
    if (!result.success) {
      const location = result.error.issues[0]?.path.join(".") || "document root"
      states[key] = {
        status: "CORRUPT",
        reason: `Data does not match the current schema (field: ${location}). The format may be outdated or the structure invalid.`,
      }
      return null
    }
    states[key] = { status: "VALID", reason: null }
    return result.data
  }
  async list() {
    let root: string
    try {
      root = await this.root()
    } catch (error) {
      if (error instanceof ViewerError && error.code === "ROOT_MISSING") return []
      throw error
    }
    const entries = await readdir(root, { withFileTypes: true })
    const result: Array<{ id: string; title: string; question: string; status: string }> = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      try {
        const project = await this.directory(entry.name),
          raw = await this.file(project, join(project, "project.json"))
        if (raw.raw === null && !raw.error) {
          try {
            if (!(await lstat(join(project, "memory"))).isDirectory()) continue
          } catch {
            continue
          }
        }
        const states: Record<string, FileState> = {},
          meta = this.parse({ meta: raw }, "meta", MetaSchema, states)
        result.push({
          id: entry.name,
          title: meta?.title ?? entry.name,
          question: meta?.question ?? "",
          status: states.meta!.status,
        })
      } catch (error) {
        if (error instanceof ViewerError)
          result.push({ id: entry.name, title: entry.name, question: "", status: "UNAVAILABLE" })
        else throw error
      }
    }
    return result
  }
  async read(name: string) {
    const files = await this.stable(name),
      memory = new SnapshotMemory(files)
    const states: Record<string, FileState> = {}
    const meta = this.parse(files, "meta", MetaSchema, states)
    const values: Partial<Record<Key, unknown>> = {}
    for (const key of KEYS)
      values[key] = this.parse(files, key, SCHEMAS[key] ?? z.unknown(), states)
    const journal = async <T>(key: Key, read: () => Promise<T>, fallback: T): Promise<T> => {
      if (states[key]!.status !== "VALID") return fallback
      try {
        return await read()
      } catch {
        states[key] = { status: "CORRUPT", reason: "Journal failed schema or signature validation" }
        return fallback
      }
    }
    const revisions = await journal(
      "production-revisions",
      () => new ProductionRevisionEngine(memory).history(),
      [],
    )
    const issues = await journal(
      "production-issues",
      () => new ProductionIssueEngine(memory).list(),
      [],
    )
    const cycles = await journal("reasoning-history", () => readReasoningCycles(memory), [])
    await journal("decisions", () => readDecisions(memory), [])
    const loaded = await journal("reasoning", () => loadReasoningCursor(memory), {
      cursor: null,
      legacyState: null,
    })
    const context = values.reasoningContext as ReasoningContext | null
    const narrative = values.narrative as Narrative | null,
      visual = values.visual as VisualOutput | null
    const selfCheck = values.selfCheck as z.infer<typeof SelfCheckOutputSchema> | null
    const pending = revisions.find((r) => r.status === "DRAFT" || r.status === "PUBLISHING")
    const healthy = Object.values(states).every(
      (s) => s.status !== "CORRUPT" && s.status !== "UNREADABLE",
    )
    let freshness: ProductionStaleness | null = null,
      liveAudit: SelfCheckProductionReport | null = null
    let auditIntegrity: "MATCH" | "MISMATCH" | "UNVERIFIABLE" = "UNVERIFIABLE"
    let notice: string | null = null
    if (pending?.status === "PUBLISHING")
      notice = "Publication is incomplete. Current files may belong to different versions."
    else if (!healthy)
      notice = "Some files failed validation or are unavailable; freshness is unverified."
    else if (context) {
      try {
        // Engines consume original signed values, not schema-reconstructed display DTOs.
        freshness = await new ProductionEngine(memory).staleness(
          await memory.get<ReasoningContext>("reasoningContext"),
        )
        if (narrative && visual && freshness.artifacts.every((a) => a.status === "CURRENT")) {
          liveAudit = auditProduction({
            context: (await memory.get<ReasoningContext>("reasoningContext"))!,
            narrative: (await memory.get<import("../core/types.js").Narrative>("narrative"))!,
            visual: (await memory.get<import("../core/types.js").VisualOutput>("visual"))!,
          })
          if (selfCheck?.production)
            auditIntegrity =
              contentSignature(contentChecks(liveAudit)) ===
              contentSignature(contentChecks(selfCheck.production as SelfCheckProductionReport))
                ? "MATCH"
                : "MISMATCH"
        }
      } catch {
        freshness = null
        notice = "Unable to verify the freshness of the saved state."
      }
    }
    const snapshotSignature = contentSignature({
      context: await memory.get("reasoningContext").catch(() => null),
      narrative: await memory.get("narrative").catch(() => null),
      visual: await memory.get("visual").catch(() => null),
      selfCheck: await memory.get("selfCheck").catch(() => null),
    })
    const coherent = pending?.status !== "PUBLISHING"
    const readVersion = version(files)
    return {
      id: name,
      readVersion,
      meta,
      files: states,
      mode: "READ_ONLY" as const,
      production: { publication: pending?.status ?? "IDLE", freshness, auditIntegrity, notice },
      narrative: coherent ? narrative : null,
      visual: coherent ? visual : null,
      context: coherent ? context : null,
      claims: values.claims as z.infer<typeof ClaimsOutputSchema> | null,
      research: values.research as z.infer<typeof ResearchOutputSchema> | ResearchBundle | null,
      selfCheck: coherent ? selfCheck : null,
      liveAudit,
      reasoning: {
        status: loaded.cursor?.status ?? loaded.legacyState?.status ?? null,
        latestCycle: cycles.at(-1) ?? null,
      },
      issues: issues.map((issue) => ({
        ...issue,
        freshness:
          auditIntegrity === "MATCH" && !pending
            ? issue.snapshotSignature === snapshotSignature
              ? "CURRENT"
              : "STALE"
            : "UNVERIFIABLE",
      })),
      revisions: revisions.map((r) => ({
        id: r.id,
        status: r.status,
        plan: r.plan,
        diff: revisionDiff(r),
      })),
    }
  }
  async trace(name: string, subjectId: string, expectedVersion?: string): Promise<TraceGraph> {
    const view = await this.read(name)
    if (expectedVersion && expectedVersion !== view.readVersion)
      throw new ViewerError(
        409,
        "VIEW_CHANGED",
        "The project changed; refresh it before inspecting links",
      )
    if (view.production.publication === "PUBLISHING")
      throw new ViewerError(
        409,
        "PUBLISHING",
        "Current snapshot links are unavailable during publication",
      )
    const graph: TraceGraph = {
      subjectId,
      readVersion: view.readVersion,
      nodes: [],
      edges: [],
      notices: [],
    }
    const research = view.research && "evidence" in view.research ? view.research : null
    const service = research ? new TraceService(research) : null
    const claims = research?.claims ?? view.claims?.claims ?? []
    const sentences = view.narrative?.sections.flatMap((s) => s.sentences) ?? []
    const shots = view.visual?.shots ?? []
    const lookup = (id: string): { kind: string; values: unknown[] } => {
      const groups: Array<[string, Array<{ id: string }>]> = [
        ["sentence", sentences],
        ["shot", shots],
        ["claim", claims],
        ["evidence", research?.evidence ?? []],
        ["source", view.research?.sources ?? []],
      ]
      for (const [kind, items] of groups) {
        const values = items.filter((i) => i.id === id)
        if (values.length) return { kind, values }
      }
      const hypotheses = view.context?.activeHypotheses.filter((h) => h.hypothesisId === id) ?? []
      if (hypotheses.length) return { kind: "hypothesis", values: hypotheses }
      const uncertainties = view.context?.uncertainties.filter((u) => u.uncertaintyId === id) ?? []
      if (uncertainties.length) return { kind: "uncertainty", values: uncertainties }
      const constraints = view.context?.constraints.filter((c) => c.id === id) ?? []
      if (constraints.length) return { kind: "constraint", values: constraints }
      const contradictions = research?.contradictions.filter((c) => c.id === id) ?? []
      return { kind: contradictions.length ? "contradiction" : "reference", values: contradictions }
    }
    const visited = new Set<string>()
    const visit = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const { kind, values } = lookup(id)
      const unavailable =
        !research &&
        !values.length &&
        claims.some(
          (c) =>
            (c.evidenceIds ?? []).includes(id) ||
            (view.research === null && c.sources.includes(id)),
        )
      graph.nodes.push({
        id,
        kind,
        status:
          values.length === 1
            ? "FOUND"
            : values.length > 1
              ? "AMBIGUOUS"
              : unavailable
                ? "UNAVAILABLE"
                : "MISSING",
        data: values.length === 1 ? values[0] : null,
      })
      if (values.length !== 1) return
      const edge = (to: string, relation: string, supported: boolean | null = null) => {
        graph.edges.push({ from: id, to, relation, supported })
        visit(to)
      }
      if (kind === "sentence") {
        const sentence = sentences.find((s) => s.id === id)!
        for (const cid of sentence.claimIds) edge(cid, "claim-reference")
        for (const hid of sentence.hypothesisIds ?? []) edge(hid, "declared-hypothesis")
        for (const uid of sentence.uncertaintyIds ?? []) edge(uid, "declared-uncertainty")
        for (const cid of sentence.contradictionIds ?? []) edge(cid, "declared-contradiction")
        for (const treatment of sentence.constraintTreatments ?? [])
          edge(treatment.constraintId, "declared-treatment")
        for (const shot of shots.filter((s) => s.narrativeSentenceIds.includes(id)))
          edge(shot.id, "associated-shot")
      } else if (kind === "shot") {
        const shot = shots.find((s) => s.id === id)!
        for (const sid of shot.narrativeSentenceIds) edge(sid, "narration")
      } else if (kind === "claim") {
        const claim = claims.find((c) => c.id === id)!
        for (const eid of claim.evidenceIds ?? [])
          edge(
            eid,
            "evidence-reference",
            research
              ? (research.evidence.find((e) => e.id === eid)?.supportsClaims.includes(id) ?? false)
              : null,
          )
        for (const sid of claim.sources) edge(sid, "declared-source")
        if (!research)
          graph.notices.push(
            `Claim ${id} was found in a standalone file; its evidence support is unverified.`,
          )
      } else if (kind === "evidence") {
        const trace = service?.traceEvidence(id)
        if (trace) edge(trace.evidence.sourceId, "source")
      }
    }
    visit(subjectId)
    if (!research)
      graph.notices.push(
        "The complete research bundle is unavailable: claim support cannot be verified. Saved claims and references are shown separately.",
      )
    if (
      view.production.freshness?.artifacts.some((a) => a.status !== "CURRENT") ||
      !view.production.freshness
    )
      graph.notices.push("Links reflect saved files; production freshness is unverified.")
    graph.notices.push(
      "Explicit hypothesis, uncertainty and constraint references are declarations, not evidence.",
    )
    return graph
  }
}
export type ProjectView = Awaited<ReturnType<ProjectReader["read"]>>
