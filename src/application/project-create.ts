import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { initProject } from "../storage/project-store.js"
import { ViewerError } from "./project-reader.js"
import { withProjectWrite } from "./project-write-coordinator.js"

const RequestSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    title: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(4000),
  })
  .strict()
async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
async function safeDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ViewerError(403, "UNSAFE_PATH", "Project creation directory is unsafe")
}
/** Request receipts survive Trash and restarts. Uncertain creation fails closed. */
export async function createProject(base: string, input: unknown) {
  const parsed = RequestSchema.safeParse(input)
  if (!parsed.success)
    throw new ViewerError(
      400,
      "INVALID_INPUT",
      "Enter a title (1–200 characters), a research question (1–4000 characters), and a valid request ID.",
    )
  const request = parsed.data
  const id = "project-" + request.requestId
  return withProjectWrite(base, id, "create", async () => {
    const root = await realpath(resolve(base))
    const receipts = join(root, ".scad-creates")
    await mkdir(receipts, { recursive: true })
    await safeDirectory(receipts)
    const receipt = join(receipts, request.requestId)
    const target = join(root, id)
    if (await exists(receipt)) {
      await safeDirectory(receipt)
      let saved: unknown
      try {
        saved = JSON.parse(await readFile(join(receipt, "request.json"), "utf8"))
      } catch {
        throw new ViewerError(
          409,
          "CREATE_INTERRUPTED",
          "An interrupted creation needs recovery. Refresh the workspace before trying again.",
        )
      }
      if (JSON.stringify(saved) !== JSON.stringify(request))
        throw new ViewerError(
          409,
          "REQUEST_CONFLICT",
          "This creation request has different content. Refresh the workspace before creating another project.",
        )
      if (await exists(target)) {
        await safeDirectory(target)
        try {
          const meta: unknown = JSON.parse(await readFile(join(target, "project.json"), "utf8"))
          if (
            meta &&
            typeof meta === "object" &&
            "creationRequestId" in meta &&
            meta.creationRequestId === request.requestId
          )
            return { id, replayed: true }
        } catch {
          /* Incomplete metadata is not proof of completion. */
        }
      }
      throw new ViewerError(
        409,
        "CREATE_UNAVAILABLE",
        "This request was already used or interrupted. Refresh the workspace and check Projects and Trash.",
      )
    }
    if (await exists(target))
      throw new ViewerError(409, "PROJECT_EXISTS", "A project with this identifier already exists.")
    await mkdir(receipt)
    await writeFile(join(receipt, "request.json"), JSON.stringify(request), { flag: "wx" })
    // Build CLI-compatible files outside the visible project list, then publish together.
    const staged = await initProject(receipt, id, request.question, request.title)
    const meta = JSON.parse(await readFile(join(staged.base, "project.json"), "utf8")) as Record<
      string,
      unknown
    >
    await writeFile(
      join(staged.base, "project.json"),
      JSON.stringify({ ...meta, creationRequestId: request.requestId }, null, 2) + "\n",
    )
    await rename(staged.base, target)
    return { id, replayed: false }
  })
}
