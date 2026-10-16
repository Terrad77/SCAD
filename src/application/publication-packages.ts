import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { ProjectReader, ViewerError } from "./project-reader.js"
import { withProjectWrite } from "./project-write-coordinator.js"
import { publicationSources } from "./publication-sources.js"
import { renameWithRetry } from "../core/memory/atomic-replace.js"
import { contentSignature } from "../core/production/approval.js"
import { ReasoningContextSchema, ProductionManifestSchema } from "../core/production/schemas.js"
import {
  NarrativeSchema,
  VisualOutputSchema,
  SelfCheckOutputSchema,
  ResearchBundleSchema,
} from "../core/schemas.js"
import {
  PublicationDocumentSchema,
  inspectPublication,
  publicationContentSignature,
  publicationTraces,
  publicationFields,
} from "../core/publication.js"
import type { ProjectExport } from "./project-export.js"

const signature = z.string().regex(/^[a-f0-9]{64}$/)
const SourceSchema = z.object({
  id: z.string().min(1).max(150),
  label: z.string().max(300),
  proofSignature: signature,
  dependencySignature: signature,
  snapshot: z
    .object({
      reasoningContext: ReasoningContextSchema,
      narrative: NarrativeSchema,
      visual: VisualOutputSchema,
      selfCheck: SelfCheckOutputSchema,
      production: ProductionManifestSchema,
    })
    .passthrough(),
  research: ResearchBundleSchema,
})
const DecisionSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT"]),
    authority: z.literal("human"),
    reason: z.string().max(2000),
    decidedAt: z.string(),
    artifactSignature: signature,
    dependencySignature: signature,
  })
  .strict()
const VersionSchema = z
  .object({
    packageId: z.string().uuid(),
    revision: z.number().int().positive(),
    savedAt: z.string(),
    source: SourceSchema,
    document: PublicationDocumentSchema,
    signature,
    decision: DecisionSchema.optional(),
  })
  .strict()
export type PublicationVersion = z.infer<typeof VersionSchema>
const JournalSchema = z
  .object({
    version: z.literal(1),
    project: z.string(),
    versions: z.array(VersionSchema).max(100),
    requests: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            signature,
            packageId: z.string().uuid(),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
type Journal = z.infer<typeof JournalSchema>
const BaseRequest = {
  requestId: z.string().uuid(),
  expectedProjectVersion: signature,
  expectedJournalVersion: signature,
  packageId: z.string().uuid(),
}
export const PublicationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...BaseRequest,
      action: z.literal("CREATE"),
      sourceId: z.string().max(150),
      document: PublicationDocumentSchema,
    })
    .strict(),
  z
    .object({
      ...BaseRequest,
      action: z.literal("SAVE"),
      revision: z.number().int().positive(),
      document: PublicationDocumentSchema,
    })
    .strict(),
  z
    .object({
      ...BaseRequest,
      action: z.enum(["APPROVE", "REJECT"]),
      revision: z.number().int().positive(),
      artifactSignature: signature,
      dependencySignature: signature,
      reason: z.string().max(2000),
    })
    .strict(),
])
export type PublicationRequest = z.infer<typeof PublicationRequestSchema>
export type PublicationPackageView = PublicationVersion & {
  freshness: "CURRENT" | "STALE" | "UNVERIFIED"
  findings: ReturnType<typeof inspectPublication>
}
export type PublicationState = {
  projectVersion: string
  journalVersion: string
  verified: boolean
  sources: Awaited<ReturnType<typeof publicationSources>>["sources"]
  notices: string[]
  packages: PublicationPackageView[]
  history: Array<Pick<PublicationVersion, "packageId" | "revision" | "savedAt" | "decision">>
}

async function safeDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ViewerError(403, "UNSAFE_PATH", "Publication directory is unsafe")
}
async function journal(base: string, name: string): Promise<Journal> {
  const root = await realpath(resolve(base))
  const folder = join(root, name, "publication")
  try {
    await safeDirectory(folder)
    const path = join(folder, "journal.json")
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
      throw new ViewerError(
        409,
        "PUBLICATION_INVALID",
        "Publication journal is unsafe or too large",
      )
    const raw: unknown = JSON.parse(await readFile(path, "utf8"))
    const envelope = z.object({ body: z.unknown(), signature }).strict().parse(raw)
    JournalSchema.parse(envelope.body)
    const body = envelope.body as Journal
    if (body.project !== name || contentSignature(body) !== envelope.signature)
      throw Error("Invalid signature")
    const requests = new Set<string>()
    const versions = new Set<string>()
    for (const item of body.versions) {
      const key = item.packageId + ":" + item.revision
      if (
        versions.has(key) ||
        item.signature !== publicationContentSignature(item.source, item.document)
      )
        throw Error("Version mismatch")
      versions.add(key)
      if (
        item.decision &&
        (item.decision.artifactSignature !== item.signature ||
          item.decision.dependencySignature !== item.source.dependencySignature)
      )
        throw Error("Decision mismatch")
    }
    for (const receipt of body.requests) {
      if (requests.has(receipt.id) || !versions.has(receipt.packageId + ":" + receipt.revision))
        throw Error("Receipt mismatch")
      requests.add(receipt.id)
    }
    return body
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, project: name, versions: [], requests: [] }
    if (error instanceof ViewerError) throw error
    throw new ViewerError(
      409,
      "PUBLICATION_INVALID",
      "Publication journal failed validation; operator inspection is required",
    )
  }
}
async function persist(base: string, name: string, body: Journal) {
  if (body.versions.length > 100 || body.requests.length > 500)
    throw new ViewerError(
      413,
      "PUBLICATION_TOO_LARGE",
      "Publication history limit reached; operator archiving is required",
    )
  JournalSchema.parse(body)
  const serialized = JSON.stringify({ body, signature: contentSignature(body) }, null, 2) + "\n"
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
    throw new ViewerError(
      413,
      "PUBLICATION_TOO_LARGE",
      "Publication history exceeds the 16 MB limit",
    )
  const folder = join(await realpath(resolve(base)), name, "publication")
  await mkdir(folder, { recursive: true })
  await safeDirectory(folder)
  const temp = join(folder, randomUUID() + ".tmp")
  await writeFile(temp, serialized, { flag: "wx" })
  await renameWithRetry(temp, join(folder, "journal.json"))
}
function latest(body: Journal, id: string) {
  return body.versions.filter((item) => item.packageId === id).at(-1)
}
function qualify(
  item: PublicationVersion,
  sources: PublicationState["sources"],
  verified = true,
): PublicationPackageView {
  const current = sources.find((source) => source.id === item.source.id)
  return {
    ...item,
    freshness: !verified
      ? "UNVERIFIED"
      : current?.dependencySignature === item.source.dependencySignature &&
          current.proofSignature === item.source.proofSignature
        ? "CURRENT"
        : "STALE",
    findings: inspectPublication(item.source, item.document),
  }
}
export async function readPublication(base: string, name: string): Promise<PublicationState> {
  await new ProjectReader(base).read(name)
  const body = await journal(base, name)
  let projectVersion: string
  let sources: PublicationState["sources"] = []
  let notices: string[] = []
  let verified = true
  try {
    const state = await publicationSources(base, name)
    projectVersion = state.view.readVersion
    sources = state.sources
    notices = state.notices
  } catch (error) {
    if (error instanceof ViewerError && error.status === 404) throw error
    verified = false
    projectVersion = (await new ProjectReader(base).read(name)).readVersion
    notices = [
      "Source verification unavailable. Existing packages remain historical; creation and approval are blocked.",
    ]
  }
  return {
    projectVersion,
    journalVersion: contentSignature(body),
    verified,
    sources,
    notices,
    packages: [...new Set(body.versions.map((item) => item.packageId))].map((id) =>
      qualify(latest(body, id)!, sources, verified),
    ),
    history: body.versions.map(({ packageId, revision, savedAt, decision }) => ({
      packageId,
      revision,
      savedAt,
      ...(decision ? { decision } : {}),
    })),
  }
}
export async function changePublication(base: string, name: string, input: unknown) {
  const parsed = PublicationRequestSchema.safeParse(input)
  if (!parsed.success)
    throw new ViewerError(
      400,
      "INVALID_PUBLICATION",
      "Enter valid publication fields and refresh before saving",
    )
  const request = parsed.data
  return withProjectWrite(base, name, "publication-package", async () => {
    await new ProjectReader(base).read(name)
    const body = await journal(base, name)
    const requestSignature = contentSignature({ project: name, ...request })
    const replay = body.requests.find((item) => item.id === request.requestId)
    if (replay) {
      if (replay.signature !== requestSignature)
        throw new ViewerError(
          409,
          "REQUEST_CONFLICT",
          "Publication request identity conflicts with saved content",
        )
      return { packageId: replay.packageId, revision: replay.revision, replayed: true }
    }
    const state = await publicationSources(base, name)
    if (
      state.view.readVersion !== request.expectedProjectVersion ||
      contentSignature(body) !== request.expectedJournalVersion
    )
      throw new ViewerError(
        409,
        "PUBLICATION_CHANGED",
        "Project or publication package changed. Your draft is retained; reload before saving.",
      )
    const previous = latest(body, request.packageId)
    let result: PublicationVersion
    if (request.action === "CREATE" || request.action === "SAVE") {
      if (request.action === "CREATE" && previous)
        throw new ViewerError(409, "PACKAGE_EXISTS", "Package already exists")
      if (request.action === "SAVE" && (!previous || previous.revision !== request.revision))
        throw new ViewerError(409, "PUBLICATION_CHANGED", "Package revision changed")
      const source =
        request.action === "CREATE"
          ? state.sources.find((item) => item.id === request.sourceId)
          : previous?.source
      if (!source)
        throw new ViewerError(
          409,
          "SOURCE_UNAVAILABLE",
          "Select a completed, verified production source",
        )
      result = {
        packageId: request.packageId,
        revision: previous ? previous.revision + 1 : 1,
        savedAt: new Date().toISOString(),
        source,
        document: request.document,
        signature: publicationContentSignature(source, request.document),
      }
      body.versions.push(result)
    } else {
      if (
        !previous ||
        previous.revision !== request.revision ||
        previous.signature !== request.artifactSignature ||
        previous.source.dependencySignature !== request.dependencySignature
      )
        throw new ViewerError(
          409,
          "PUBLICATION_CHANGED",
          "Review the exact saved package before deciding",
        )
      if (previous.decision)
        throw new ViewerError(
          409,
          "DECISION_RECORDED",
          "This revision already has a decision. Save a new revision to reopen review.",
        )
      if (request.action === "REJECT" && !request.reason.trim())
        throw new ViewerError(400, "REASON_REQUIRED", "Enter a reason for rejection")
      if (request.action === "APPROVE") {
        const checked = qualify(previous, state.sources)
        if (
          checked.freshness !== "CURRENT" ||
          checked.findings.some((finding) => finding.status === "FAIL")
        )
          throw new ViewerError(
            409,
            "PACKAGE_NOT_READY",
            "Package is stale or has missing content/broken material links. Review its findings.",
          )
      }
      previous.decision = {
        action: request.action,
        authority: "human",
        reason: request.reason,
        decidedAt: new Date().toISOString(),
        artifactSignature: previous.signature,
        dependencySignature: previous.source.dependencySignature,
      }
      result = previous
    }
    const again = await publicationSources(base, name)
    if (
      again.view.readVersion !== state.view.readVersion ||
      contentSignature(again.sources) !== contentSignature(state.sources)
    )
      throw new ViewerError(
        409,
        "PUBLICATION_CHANGED",
        "Source changed during the operation; no package change was persisted",
      )
    body.requests.push({
      id: request.requestId,
      signature: requestSignature,
      packageId: result.packageId,
      revision: result.revision,
    })
    await persist(base, name, body)
    return { packageId: result.packageId, revision: result.revision, replayed: false }
  })
}
export async function exportPublication(
  base: string,
  name: string,
  id: string,
  revision: string,
  expected: string,
  format: string,
): Promise<ProjectExport> {
  if (
    !z.string().uuid().safeParse(id).success ||
    !/^[1-9][0-9]{0,2}$/.test(revision) ||
    !signature.safeParse(expected).success ||
    !["json", "md"].includes(format)
  )
    throw new ViewerError(400, "INVALID_EXPORT", "Select a valid publication revision and format")
  const state = await readPublication(base, name)
  if (state.journalVersion !== expected)
    throw new ViewerError(409, "PUBLICATION_CHANGED", "Package changed; reload before downloading")
  const body = await journal(base, name)
  if (contentSignature(body) !== expected)
    throw new ViewerError(409, "PUBLICATION_CHANGED", "Package changed during export")
  const item = body.versions.find(
    (item) => item.packageId === id && item.revision === Number(revision),
  )
  if (!item) throw new ViewerError(404, "PACKAGE_MISSING", "Publication version not found")
  const qualified = qualify(item, state.sources, state.verified)
  const traces = publicationTraces(item.source, item.document)
  const isLatest = latest(body, id)?.revision === item.revision
  const status =
    isLatest && qualified.freshness === "CURRENT" && item.decision?.action === "APPROVE"
      ? "APPROVED PACKAGING COPY"
      : "REVIEW COPY — NOT CURRENTLY APPROVED"
  const payload = {
    schema: "scad.publication-export.v1",
    isLatest,
    status,
    ...qualified,
    notice:
      "Packaging consent does not certify semantic support, resolve audit findings or authorize upload. Planned segments have no final timestamps.",
    traces,
  }
  const markdown = [
    "# Publication package — " + status,
    "",
    "Freshness: " + qualified.freshness,
    "Source: " + item.source.label,
    "Package revision: " + item.revision,
    "Source audit: " + (item.source.snapshot.selfCheck?.production?.verdict ?? "UNKNOWN"),
    "",
    payload.notice,
    "",
    "## Audience question",
    item.document.audienceQuestion,
    "",
    ...publicationFields(item.document).flatMap((field) => [
      "## " + field.label,
      field.value.text,
      "Script links: " + field.value.sentenceIds.join(", "),
      "",
    ]),
    "## Review findings",
    ...qualified.findings.map(
      (finding) => `- ${finding.status} · ${finding.code}: ${finding.detail}`,
    ),
    "",
    "## Material trace (saved knowledge labels and evidence/source links)",
    JSON.stringify(traces, null, 2),
    "",
    "## Saved epistemic qualifications (not resolved by packaging consent)",
    JSON.stringify(
      {
        hypotheses: item.source.snapshot.reasoningContext.activeHypotheses,
        uncertainties: item.source.snapshot.reasoningContext.uncertainties,
        contradictions: item.source.research.contradictions,
        constraints: item.source.snapshot.reasoningContext.constraints,
      },
      null,
      2,
    ),
  ].join("\n")
  return {
    filename: `scad-publication-${id}-v${revision}.${format}`,
    mime: format === "md" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8",
    content: format === "md" ? markdown : JSON.stringify(payload, null, 2) + "\n",
  }
}
