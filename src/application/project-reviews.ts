import { renameWithRetry } from "../core/memory/atomic-replace.js"
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { z } from "zod"
import {
  ApprovalLedger,
  contentSignature,
  dependencySignature,
} from "../core/production/approval.js"
import { JsonMemoryStore } from "../core/memory/json-memory.js"
import { PIPELINE_ORDER, type PipelineStage } from "../core/pipeline.js"
import { assertNoPendingProductionRevision } from "../core/production/revisions.js"
import { ProjectReader, ViewerError, validatePipelineArtifact } from "./project-reader.js"
import type { ProjectRun } from "./project-runs.js"
import { checkpointSummary } from "./checkpoint-summary.js"
import { verifyContextIntegrity } from "../core/production/signature.js"
import type { ReasoningContext } from "../core/production/types.js"
const signature = z.string().regex(/^[a-f0-9]{64}$/)
export const CheckpointSchema = z
  .object({
    artifactSignature: signature,
    dependencySignature: signature,
    inputSignature: signature,
  })
  .strict()
export const ReviewDecisionSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum(["APPROVE", "REJECT"]),
    reason: z.string(),
    decidedAt: z.string(),
  })
  .strict()
export const ReviewRequestSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    runId: z.string().uuid(),
    expectedVersion: signature,
    artifactSignature: signature,
    dependencySignature: signature,
    action: z.enum(["APPROVE", "REJECT"]),
    reason: z.string().trim().max(2000),
  })
  .strict()
  .refine((input) => input.action !== "REJECT" || input.reason.length > 0, {
    message: "A rejection reason is required",
  })
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>
export type CheckpointReview = {
  stage: PipelineStage
  runId: string
  version: string
  artifact: unknown
  upstream: Record<string, unknown>
  unchanged: boolean
  summary: string[]
  artifactSignature: string
  dependencySignature: string
  checkpointArtifactSignature: string | null
  current: boolean
  decidable: boolean
  explanation: string
  decision: z.infer<typeof ReviewDecisionSchema> | null
}
const ApprovalSchema = z
  .object({
    stage: z.string(),
    artifactSignature: signature,
    dependencySignature: signature,
    decidedAt: z.string(),
    authority: z.enum(["human", "auto"]),
    modified: z.boolean(),
    decisionId: z.string().uuid().optional(),
  })
  .passthrough()
const ReceiptSchema = z
  .object({
    request: ReviewRequestSchema,
    decision: ReviewDecisionSchema,
    approval: ApprovalSchema.nullable(),
  })
  .strict()
const ValidatedReceiptSchema = ReceiptSchema.refine(
  ({ request, decision, approval }) =>
    decision.requestId === request.requestId &&
    decision.action === request.action &&
    decision.reason === request.reason &&
    (request.action === "REJECT"
      ? approval === null
      : Boolean(
          approval &&
          PIPELINE_ORDER.some((stage) => stage === approval.stage) &&
          approval.authority === "human" &&
          !approval.modified &&
          approval.decisionId === request.requestId &&
          approval.decidedAt === decision.decidedAt &&
          approval.artifactSignature === request.artifactSignature &&
          approval.dependencySignature === request.dependencySignature,
        )),
  "Decision receipt content does not match its request",
)
async function file(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
      throw new Error("unsafe")
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new ViewerError(409, "REVIEW_UNAVAILABLE", "Review files require operator inspection")
  }
}
async function atomic(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp"
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: "wx" })
  await renameWithRetry(temp, path)
}
async function memory(base: string, name: string) {
  const root = await realpath(resolve(base)),
    project = join(root, name),
    path = join(project, "memory")
  for (const directory of [project, path]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new ViewerError(403, "UNSAFE_PATH", "Review directory is unsafe")
  }
  for (const entry of await readdir(path)) {
    const info = await lstat(join(path, entry))
    if (!info.isFile() || info.isSymbolicLink())
      throw new ViewerError(403, "UNSAFE_PATH", "Review artifact entry is unsafe")
  }
  return new JsonMemoryStore(path)
}
async function ledger(store: JsonMemoryStore) {
  const raw = await file(join(store.location, "approved.json"))
  try {
    if (raw !== null) z.record(ApprovalSchema).parse(JSON.parse(raw))
  } catch {
    throw new ViewerError(409, "APPROVALS_INVALID", "Repair the approval ledger before deciding")
  }
  return new ApprovalLedger(store)
}
function checkpointStage(run: ProjectRun): PipelineStage {
  const stage = PIPELINE_ORDER.find((stage) => stage === run.stage)
  if (!stage) throw new ViewerError(409, "REVIEW_NOT_AVAILABLE", "Unknown pipeline checkpoint")
  return stage
}
async function capturedArtifacts(store: JsonMemoryStore, stage: PipelineStage) {
  const raw: Record<string, string> = {},
    values: Record<string, unknown> = {}
  let bytes = 0
  for (const key of PIPELINE_ORDER.slice(0, PIPELINE_ORDER.indexOf(stage) + 1)) {
    const text = await file(join(store.location, key + ".json"))
    if (text === null)
      throw new ViewerError(409, "CANDIDATE_INVALID", "Missing checkpoint material: " + key)
    bytes += Buffer.byteLength(text)
    if (bytes > 32 * 1024 * 1024)
      throw new ViewerError(409, "REVIEW_TOO_LARGE", "Use CLI review for this large checkpoint")
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      throw new ViewerError(409, "CANDIDATE_INVALID", "Invalid checkpoint material: " + key)
    }
    validatePipelineArtifact(key, value)
    if (key === "reasoningContext" && !verifyContextIntegrity(value as ReasoningContext).valid)
      throw new ViewerError(
        409,
        "CONTEXT_INVALID",
        "Reasoning context integrity is invalid; rebuild it explicitly",
      )
    raw[key] = text
    values[key] = value
  }
  return { raw, values }
}
export async function readCheckpointReview(
  base: string,
  name: string,
  folder: string,
  run: ProjectRun,
): Promise<CheckpointReview> {
  if (run.project !== name || run.state !== "WAITING_REVIEW")
    throw new ViewerError(
      409,
      "REVIEW_NOT_AVAILABLE",
      "Only a paused pipeline checkpoint can be reviewed here",
    )
  const store = await memory(base, name)
  const stage = checkpointStage(run)
  const captured = await capturedArtifacts(store, stage)
  const artifact = captured.values[stage]
  const upstream = { ...captured.values }
  delete upstream[stage]
  const snapshot = await new ProjectReader(base).read(name)
  for (const [key, raw] of Object.entries(captured.raw))
    if ((await file(join(store.location, key + ".json"))) !== raw)
      throw new ViewerError(409, "SNAPSHOT_CHANGED", "Checkpoint changed during reading; reload")
  const artifactSignature = contentSignature(artifact),
    dependencies = dependencySignature(upstream)
  const approvals = await ledger(store)
  const consumed: Record<string, unknown> = {}
  let upstreamApproved = true
  for (const key of PIPELINE_ORDER.slice(0, PIPELINE_ORDER.indexOf(stage))) {
    upstreamApproved &&= await approvals.isApproved({
      stage: key,
      artifactSignature: contentSignature(upstream[key]),
      dependencySignature: dependencySignature(consumed),
    })
    consumed[key] = upstream[key]
  }
  const approved = await approvals.isApproved({
    stage,
    artifactSignature,
    dependencySignature: dependencies,
  })
  const matches = Boolean(
    upstreamApproved &&
    (stage !== "research" ||
      (artifact as { question: string }).question === snapshot.meta?.question) &&
    run.checkpoint &&
    run.checkpoint.artifactSignature === artifactSignature &&
    run.checkpoint.dependencySignature === dependencies &&
    run.checkpoint.inputSignature ===
      contentSignature({ title: snapshot.meta?.title, question: snapshot.meta?.question }),
  )
  const pending = await file(join(folder, run.id + ".decision.json"))
  const verified =
    ["VALID", "MISSING"].includes(snapshot.files["production-revisions"]!.status) &&
    snapshot.production.publication !== "PUBLISHING"
  return {
    stage,
    runId: run.id,
    version: snapshot.readVersion,
    artifact,
    summary: checkpointSummary(stage, artifact),
    upstream,
    unchanged: matches && verified,
    artifactSignature,
    dependencySignature: dependencies,
    checkpointArtifactSignature: run.checkpoint?.artifactSignature ?? null,
    current: matches && !run.decision && !approved && verified,
    decidable: matches && !run.decision && !approved && !pending && verified,
    explanation: run.decision
      ? matches
        ? "Decision recorded; execution remains stopped. This is a historical decision, not a current audit verdict."
        : "Research, checkpoint dependencies or project inputs changed after the recorded decision. That decision does not approve the displayed candidate."
      : !run.checkpoint
        ? "This older run has no structured checkpoint identity. Continue review through the interactive CLI."
        : !matches
          ? "The candidate or project inputs changed since this checkpoint. Browser approval is unavailable."
          : approved
            ? "This candidate already has a human approval. No new decision is required here."
            : pending
              ? "An interrupted decision requires recovery with its original request identity."
              : !verified
                ? "Finish or repair the production revision before deciding."
                : "Candidate, upstream human approvals, project inputs and this snapshot are checked before recording your decision.",
    decision: run.decision ?? null,
  }
}
/** Call only under shared project write ownership. */
export async function assertCheckpointResumable(
  base: string,
  name: string,
  folder: string,
  run: ProjectRun,
) {
  const review = await readCheckpointReview(base, name, folder, run)
  const stage = checkpointStage(run)
  const raw = await file(join(folder, run.id + ".decision.json"))
  let receipt: z.infer<typeof ReceiptSchema>
  try {
    receipt = ValidatedReceiptSchema.parse(JSON.parse(raw ?? "null"))
  } catch {
    throw new ViewerError(
      409,
      "RESUME_NOT_AVAILABLE",
      "A completed browser approval is required before resuming",
    )
  }
  const done = await file(join(folder, run.id + ".decision-done.json"))
  const store = await memory(base, name)
  const approvals = await ledger(store)
  const snapshot = await new ProjectReader(base).read(name)
  if (
    run.decision?.action !== "APPROVE" ||
    contentSignature(receipt.decision) !== contentSignature(run.decision) ||
    receipt.request.runId !== run.id ||
    done !== contentSignature(receipt) ||
    !receipt.approval ||
    receipt.approval.stage !== stage ||
    contentSignature(await approvals.get(stage)) !== contentSignature(receipt.approval) ||
    review.artifactSignature !== run.checkpoint?.artifactSignature ||
    review.dependencySignature !== run.checkpoint?.dependencySignature ||
    !review.unchanged ||
    !run.checkpoint ||
    run.checkpoint.inputSignature !==
      contentSignature({ title: snapshot.meta?.title, question: snapshot.meta?.question })
  )
    throw new ViewerError(
      409,
      "RESUME_NOT_AVAILABLE",
      "Checkpoint approval or inputs changed. Inspect the checkpoint before continuing",
    )
  await assertNoPendingProductionRevision(store)
}
export async function decideCheckpoint(
  base: string,
  name: string,
  folder: string,
  run: ProjectRun,
  request: ReviewRequest,
) {
  const stage = checkpointStage(run)
  if (request.runId !== run.id)
    throw new ViewerError(409, "CHECKPOINT_CHANGED", "Decision belongs to another checkpoint")
  const receiptPath = join(folder, run.id + ".decision.json"),
    donePath = join(folder, run.id + ".decision-done.json")
  const previous = await file(receiptPath)
  if (previous === null && (await file(donePath)) !== null)
    throw new ViewerError(
      409,
      "DECISION_INVALID",
      "Orphaned decision receipt requires operator inspection",
    )
  let receipt: z.infer<typeof ReceiptSchema> | null = null
  if (previous !== null) {
    try {
      receipt = ValidatedReceiptSchema.parse(JSON.parse(previous))
    } catch {
      throw new ViewerError(
        409,
        "DECISION_INVALID",
        "Decision receipt requires operator inspection",
      )
    }
    if (contentSignature(receipt.request) !== contentSignature(request))
      throw new ViewerError(
        409,
        "DECISION_CONFLICT",
        "A different decision request is already recorded for this checkpoint",
      )
    if (receipt.approval && receipt.approval.stage !== stage)
      throw new ViewerError(409, "DECISION_INVALID", "Decision receipt belongs to another stage")
    const done = await file(donePath)
    if (done !== null) {
      if (done !== contentSignature(receipt))
        throw new ViewerError(
          409,
          "DECISION_INVALID",
          "Decision receipt requires operator inspection",
        )
      return receipt.decision
    }
  }
  const store = await memory(base, name),
    approvals = await ledger(store)
  let applied = false
  if (receipt) {
    const saved = await approvals.get(stage)
    applied =
      receipt.approval !== null
        ? contentSignature(saved) === contentSignature(receipt.approval)
        : run.decision?.requestId === request.requestId
  }
  if (!applied) {
    if ((await file(join(folder, "latest.json"))) !== run.id)
      throw new ViewerError(409, "CHECKPOINT_CHANGED", "A newer run exists; reload the checkpoint")
    const review = await readCheckpointReview(base, name, folder, run)
    // A prepared receipt is allowed only for replay of this exact, still-current decision.
    if (!review.current || (!review.decidable && !receipt))
      throw new ViewerError(
        409,
        "CHECKPOINT_CHANGED",
        "Checkpoint changed or was already decided. Reload before deciding",
      )
    if (
      review.version !== request.expectedVersion ||
      review.artifactSignature !== request.artifactSignature ||
      review.dependencySignature !== request.dependencySignature
    )
      throw new ViewerError(
        409,
        "SNAPSHOT_CHANGED",
        "Project changed since review. Reload and inspect it again",
      )
    await assertNoPendingProductionRevision(store)
    if (!receipt) {
      const decision = {
        requestId: request.requestId,
        action: request.action,
        reason: request.reason,
        decidedAt: new Date().toISOString(),
      }
      const approval: z.infer<typeof ApprovalSchema> | null =
        request.action === "APPROVE"
          ? {
              stage,
              artifactSignature: review.artifactSignature,
              dependencySignature: review.dependencySignature,
              decidedAt: decision.decidedAt,
              authority: "human",
              modified: false,
              decisionId: request.requestId,
            }
          : null
      receipt = { request, decision, approval }
      await writeFile(receiptPath, JSON.stringify(receipt), { flag: "wx" })
    }
    if (receipt!.approval) await approvals.record(receipt!.approval)
  }
  const decision = receipt!.decision
  if (run.decision && contentSignature(run.decision) !== contentSignature(decision))
    throw new ViewerError(409, "DECISION_CONFLICT", "Checkpoint contains another decision")
  const updated = {
    ...run,
    decision,
    updatedAt: decision.decidedAt,
    events: [
      ...run.events,
      {
        at: decision.decidedAt,
        message:
          (stage === "research" ? "Research" : stage) +
          " decision: " +
          decision.action +
          ". Execution remains stopped.",
      },
    ].slice(-100),
  }
  if (!run.decision) await atomic(join(folder, run.id + ".json"), updated)
  await writeFile(donePath, contentSignature(receipt), { flag: "wx" })
  return decision
}
