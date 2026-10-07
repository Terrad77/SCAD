import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { canChangeProjectQuestion, ProjectReader, ViewerError } from "./project-reader.js"
import { withProjectWrite } from "./project-write-coordinator.js"

const InputSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(200),
    question: z.string().max(4000),
  })
  .strict()

async function safeDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ViewerError(403, "UNSAFE_PATH", "Project settings directory is unsafe")
}
async function safeRead(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink())
      throw new ViewerError(403, "UNSAFE_PATH", "Project settings file is unsafe")
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
/** Metadata-only command. Never rewrites evidence, approvals or generated artifacts. */
export async function updateProjectDetails(base: string, name: string, input: unknown) {
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success)
    throw new ViewerError(
      400,
      "INVALID_INPUT",
      "Enter valid project details and refresh before saving.",
    )
  const request = parsed.data
  return withProjectWrite(base, name, "settings", async () => {
    const reader = new ProjectReader(base)
    const snapshot = await reader.read(name)
    if (!snapshot.meta)
      throw new ViewerError(
        409,
        "INVALID_METADATA",
        "Project metadata must be repaired before editing.",
      )
    if (!["VALID", "MISSING"].includes(snapshot.files["production-revisions"]!.status))
      throw new ViewerError(
        409,
        "REVISION_UNVERIFIED",
        "The revision journal must be repaired before editing.",
      )
    if (snapshot.production.publication === "PUBLISHING")
      throw new ViewerError(409, "PUBLISHING", "Finish the pending publication before editing.")
    const root = await realpath(resolve(base)),
      project = join(root, name)
    const metadataPath = join(project, "project.json")
    const raw = await safeRead(metadataPath)
    if (!raw) throw new ViewerError(409, "INVALID_METADATA", "Project metadata is unavailable.")
    const metadata = JSON.parse(raw) as Record<string, unknown>
    const requestsRoot = join(root, ".scad-settings")
    await mkdir(requestsRoot, { recursive: true })
    await safeDirectory(requestsRoot)
    const key = createHash("sha256").update(name.normalize("NFC").toLowerCase()).digest("hex")
    const requests = join(requestsRoot, key)
    await mkdir(requests, { recursive: true })
    await safeDirectory(requests)
    const receipt = join(requests, request.requestId)
    let previous: string | null = null
    try {
      await safeDirectory(receipt)
      previous = await safeRead(join(receipt, "request.json"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const serialized = JSON.stringify({ project: name, ...request })
    if (previous !== null) {
      if (previous !== serialized)
        throw new ViewerError(
          409,
          "REQUEST_CONFLICT",
          "This save request has different content. Reload the project before editing again.",
        )
      if (
        metadata.settingsRequestId === request.requestId ||
        (await safeRead(join(receipt, "completed.json"))) === serialized
      )
        return { id: name, replayed: true }
    }
    if (snapshot.readVersion !== request.expectedVersion)
      throw new ViewerError(
        409,
        "SNAPSHOT_CHANGED",
        "Project changed since you opened it. Your draft is kept; reload the project before saving.",
      )
    if (request.question !== snapshot.meta.question) {
      if (!request.question.trim())
        throw new ViewerError(400, "QUESTION_REQUIRED", "Enter a research question.")
      if (!(await canChangeProjectQuestion(project)))
        throw new ViewerError(
          409,
          "QUESTION_LOCKED",
          "The research question is fixed once project materials exist. Create a new project for a different question.",
        )
    }
    if (previous === null) {
      try {
        await mkdir(receipt)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new ViewerError(
            409,
            "SAVE_INTERRUPTED",
            "An interrupted save needs recovery. Reload the project.",
          )
        throw error
      }
      await writeFile(join(receipt, "request.json"), serialized, { flag: "wx" })
    }
    const staged = join(receipt, "project.json")
    // Temp and destination are on the same local filesystem; all other metadata is preserved.
    await writeFile(
      staged,
      JSON.stringify(
        {
          ...metadata,
          title: request.title,
          question: request.question,
          settingsRequestId: request.requestId,
        },
        null,
        2,
      ) + "\n",
    )
    await rename(staged, metadataPath)
    await writeFile(join(receipt, "completed.json"), serialized, { flag: "wx" })
    return { id: name, replayed: false }
  })
}
