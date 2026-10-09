import { renameWithRetry } from "../core/memory/atomic-replace.js"
import {
  ResearchCheckpointSchema,
  ReviewDecisionSchema,
  ReviewRequestSchema,
  readResearchReview,
  decideResearch,
  assertResearchResumable,
} from "./project-reviews.js"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { runDocumentaryPipeline, type DocumentaryOptions } from "../core/documentary.js"
import { contentSignature, dependencySignature } from "../core/production/approval.js"
import { JsonMemoryStore } from "../core/memory/json-memory.js"
import { assertNoPendingProductionRevision } from "../core/production/revisions.js"
import { projectDir } from "../storage/project-store.js"
import {
  providerFromEnv,
  searchProviderFromEnv,
  contentProviderFromEnv,
  referenceDateFromEnv,
  researchFromEnv,
  outputArtifacts,
} from "../cli/cli.js"
import { ProjectReader, ViewerError } from "./project-reader.js"
import { validateProjectId, withProjectWrite } from "./project-write-coordinator.js"

const Request = z
  .object({
    requestId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const ResumeRequestSchema = Request.extend({ runId: z.string().uuid() }).strict()
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>
const Run = z
  .object({
    id: z.string().uuid(),
    project: z.string(),
    owner: z.string().uuid(),
    expectedVersion: z.string(),
    resumeOf: z.string().uuid().optional(),
    state: z.enum(["RUNNING", "WAITING_REVIEW", "COMPLETED", "FAILED"]),
    stage: z.string().nullable(),
    checkpoint: ResearchCheckpointSchema.optional(),
    decision: ReviewDecisionSchema.optional(),
    startedAt: z.string(),
    updatedAt: z.string(),
    events: z.array(z.object({ at: z.string(), message: z.string() })).max(100),
  })
  .strict()
export type ProjectRun = z.infer<typeof Run>
export type RunView = { run: ProjectRun | null; owned: boolean; provider: string }
export type RunExecutor = (
  options: Pick<
    DocumentaryOptions,
    "memoryDir" | "project" | "title" | "question" | "approvals" | "onStageStart"
  >,
) => Promise<void>
class CheckpointPending extends Error {}
async function execute(options: Parameters<RunExecutor>[0]) {
  const result = await runDocumentaryPipeline({
    ...options,
    provider: providerFromEnv().provider,
    search: searchProviderFromEnv(),
    content: contentProviderFromEnv(),
    referenceDate: referenceDateFromEnv(),
    research: researchFromEnv(),
  })
  await outputArtifacts(projectDir(resolve(options.memoryDir, "../.."), options.project!), result)
}
async function safeDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ViewerError(403, "UNSAFE_PATH", "Run journal directory is unsafe")
}
async function read(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new ViewerError(409, "RUN_JOURNAL_INVALID", "Run journal needs operator inspection")
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
async function atomic(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp"
  await writeFile(temp, typeof value === "string" ? value : JSON.stringify(value, null, 2), {
    flag: "wx",
  })
  await renameWithRetry(temp, path)
}
/** Owns jobs independently of browser requests. No machine approvals, force or automatic resume. */
export class ProjectRuns {
  private readonly owner = randomUUID()
  private readonly tasks = new Set<Promise<void>>()
  private readonly active = new Set<string>()
  private closing = false
  constructor(
    private readonly base: string,
    private readonly executor: RunExecutor = execute,
  ) {}
  private async folder(name: string, create = false) {
    validateProjectId(name)
    const root = await realpath(resolve(this.base))
    const journals = join(root, ".scad-runs")
    const folder = join(
      journals,
      createHash("sha256").update(name.normalize("NFC").toLowerCase()).digest("hex"),
    )
    if (create) await mkdir(journals, { recursive: true })
    try {
      await safeDirectory(journals)
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    if (create) await mkdir(folder, { recursive: true })
    try {
      await safeDirectory(folder)
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    return folder
  }
  private async load(folder: string, id: string): Promise<ProjectRun> {
    if (!z.string().uuid().safeParse(id).success)
      throw new ViewerError(409, "RUN_JOURNAL_INVALID", "Run journal needs operator inspection")
    const raw = await read(join(folder, id + ".json"))
    try {
      const run = Run.parse(JSON.parse(raw ?? "null"))
      if (run.id !== id) throw new Error("Run identity mismatch")
      return run
    } catch {
      throw new ViewerError(409, "RUN_JOURNAL_INVALID", "Run journal needs operator inspection")
    }
  }
  async status(name: string): Promise<RunView> {
    await new ProjectReader(this.base).read(name)
    const folder = await this.folder(name)
    const id = folder ? await read(join(folder, "latest.json")) : null
    const run = folder && id !== null ? await this.load(folder, id) : null
    return {
      run,
      owned: run?.owner === this.owner && this.active.has(run.id),
      provider: process.env.LLM_PROVIDER ?? "opencode",
    }
  }
  async start(name: string, input: unknown): Promise<ProjectRun> {
    return this.launch(name, input, false)
  }
  async resume(name: string, input: unknown): Promise<ProjectRun> {
    return this.launch(name, input, true)
  }
  private async launch(name: string, input: unknown, continuation: boolean): Promise<ProjectRun> {
    const parsed = (continuation ? ResumeRequestSchema : Request).safeParse(input)
    if (!parsed.success)
      throw new ViewerError(400, "INVALID_INPUT", "Refresh the project before starting a run")
    if (this.closing)
      throw new ViewerError(503, "SERVER_CLOSING", "The workspace server is stopping")
    const request = parsed.data
    const resumeOf = "runId" in request ? (request.runId as string) : undefined
    const matchesRequest = (saved: ProjectRun) =>
      saved.expectedVersion === request.expectedVersion &&
      saved.project === name &&
      saved.resumeOf === resumeOf
    const priorFolder = await this.folder(name)
    if (priorFolder && (await read(join(priorFolder, request.requestId + ".json"))) !== null) {
      const saved = await this.load(priorFolder, request.requestId)
      if (!matchesRequest(saved))
        throw new ViewerError(
          409,
          "REQUEST_CONFLICT",
          "Run request identity conflicts with saved content",
        )
      return saved
    }
    let admit!: (run: ProjectRun) => void
    let decline!: (error: unknown) => void
    const admitted = new Promise<ProjectRun>((resolve, reject) => {
      admit = resolve
      decline = reject
    })
    const task = withProjectWrite(this.base, name, "pipeline", async () => {
      const snapshot = await new ProjectReader(this.base).read(name)
      const folder = (await this.folder(name, true))!
      const previous = await read(join(folder, request.requestId + ".json"))
      if (previous !== null) {
        const saved = await this.load(folder, request.requestId)
        if (!matchesRequest(saved))
          throw new ViewerError(
            409,
            "REQUEST_CONFLICT",
            "Run request identity conflicts with saved content",
          )
        admit(saved)
        return
      }
      const latestId = await read(join(folder, "latest.json"))
      if (latestId !== null) {
        const latest = await this.load(folder, latestId)
        if (resumeOf) {
          if (latest.id !== resumeOf)
            throw new ViewerError(
              409,
              "CHECKPOINT_CHANGED",
              "A newer run exists. Check run status before continuing",
            )
          await assertResearchResumable(this.base, name, folder, latest)
        } else if (["RUNNING", "WAITING_REVIEW"].includes(latest.state))
          throw new ViewerError(
            409,
            "RUN_NEEDS_ATTENTION",
            "The previous run requires review or operator recovery; no new run was started",
          )
      }
      if (resumeOf && latestId === null)
        throw new ViewerError(409, "RESUME_NOT_AVAILABLE", "No Research checkpoint is available")
      if (snapshot.readVersion !== request.expectedVersion)
        throw new ViewerError(409, "SNAPSHOT_CHANGED", "Project changed. Refresh before starting")
      if (!snapshot.meta?.question.trim())
        throw new ViewerError(409, "QUESTION_REQUIRED", "Save a research question before running")
      if (
        Object.values(snapshot.files).some((file) =>
          ["CORRUPT", "UNREADABLE"].includes(file.status),
        )
      )
        throw new ViewerError(
          409,
          "PROJECT_INVALID",
          "Repair unreadable or invalid project files before running",
        )
      const dir = projectDir(await realpath(resolve(this.base)), name)
      await safeDirectory(dir.memoryDir)
      await safeDirectory(dir.outputDir)
      for (const directory of [dir.memoryDir, dir.outputDir]) {
        for (const entry of await readdir(directory)) {
          const info = await lstat(join(directory, entry))
          if (!info.isFile() || info.isSymbolicLink())
            throw new ViewerError(403, "UNSAFE_PATH", "Project contains unsafe artifact entries")
        }
      }
      await assertNoPendingProductionRevision(new JsonMemoryStore(dir.memoryDir))
      const now = new Date().toISOString()
      const run: ProjectRun = {
        id: request.requestId,
        project: name,
        owner: this.owner,
        expectedVersion: request.expectedVersion,
        ...(resumeOf ? { resumeOf } : {}),
        state: "RUNNING",
        stage: null,
        startedAt: now,
        updatedAt: now,
        events: [
          {
            at: now,
            message: resumeOf
              ? "Explicit continuation of " + resumeOf + ". Human checkpoints remain required."
              : "Run started. Human checkpoints remain required.",
          },
        ],
      }
      const save = async (message: string) => {
        run.updatedAt = new Date().toISOString()
        run.events.push({ at: run.updatedAt, message })
        run.events = run.events.slice(-100)
        await atomic(join(folder, run.id + ".json"), run)
      }
      await atomic(join(folder, run.id + ".json"), run)
      await atomic(join(folder, "latest.json"), run.id)
      this.active.add(run.id)
      admit(structuredClone(run))
      try {
        await this.executor({
          memoryDir: dir.memoryDir,
          project: name,
          title: snapshot.meta.title,
          question: snapshot.meta.question,
          onStageStart: async (stage) => {
            run.stage = stage
            await save("Generating " + stage)
          },
          approvals: {
            review: async (stage, artifact) => {
              if (stage === "research")
                run.checkpoint = {
                  artifactSignature: contentSignature(artifact),
                  dependencySignature: dependencySignature({}),
                  inputSignature: contentSignature({
                    title: snapshot.meta!.title,
                    question: snapshot.meta!.question,
                  }),
                }
              run.stage = stage
              run.state = "WAITING_REVIEW"
              await save(
                "Saved candidate requires human review: " +
                  stage +
                  " · " +
                  contentSignature(artifact),
              )
              throw new CheckpointPending()
            },
          },
        })
        run.state = "COMPLETED"
        await save("Pipeline finished. Completion does not certify the audit verdict.")
      } catch (error) {
        if (error instanceof CheckpointPending) return

        run.state = "FAILED"
        await save(
          "Run failed. Inspect the project and server provider configuration before another run.",
        )
      }
    })
      .then(() => undefined)
      .catch((error) => {
        decline(error)
      })
    this.tasks.add(task)
    void task.finally(() => {
      this.tasks.delete(task)
      this.active.delete(request.requestId)
    })
    return admitted
  }
  async review(name: string) {
    const { run } = await this.status(name)
    const folder = await this.folder(name)
    if (!run || !folder)
      throw new ViewerError(
        409,
        "REVIEW_NOT_AVAILABLE",
        "No browser Research checkpoint is available",
      )
    return readResearchReview(this.base, name, folder, run)
  }
  async decide(name: string, input: unknown) {
    const parsed = ReviewRequestSchema.safeParse(input)
    if (!parsed.success)
      throw new ViewerError(
        400,
        "INVALID_DECISION",
        "Enter a valid decision and a reason for rejection",
      )
    if (this.closing)
      throw new ViewerError(503, "SERVER_CLOSING", "The workspace server is stopping")
    return withProjectWrite(this.base, name, "research-review", async () => {
      await new ProjectReader(this.base).read(name)
      const folder = await this.folder(name)
      if (!folder) throw new ViewerError(409, "REVIEW_NOT_AVAILABLE", "No checkpoint is available")
      const run = await this.load(folder, parsed.data.runId)
      if (run.project !== name)
        throw new ViewerError(409, "CHECKPOINT_CHANGED", "Checkpoint does not match the project")
      return decideResearch(this.base, name, folder, run, parsed.data)
    })
  }
  async close() {
    this.closing = true
    await Promise.all(this.tasks)
  }
}
