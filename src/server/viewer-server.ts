import { updateProjectDetails } from "../application/project-details.js"
import { createProject } from "../application/project-create.js"
import { ProjectTrash } from "../application/project-trash.js"
import { createServer, type Server, type IncomingMessage } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { ProjectReader, ViewerError } from "../application/project-reader.js"
import { viewerHtml } from "../ui/html.js"

async function readProjectBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
    throw new ViewerError(415, "JSON_REQUIRED", "Project operations require JSON")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > 32768) throw new ViewerError(413, "BODY_TOO_LARGE", "Project details are too large")
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw new ViewerError(400, "INVALID_JSON", "Project details contain invalid JSON")
  }
}
export interface ViewerServer {
  server: Server
  url: string
  close: () => Promise<void>
}
export async function startViewer(options: {
  dataDir: string
  port?: number
}): Promise<ViewerServer> {
  const port = options.port ?? 4311
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Viewer port must be an integer from 0 to 65535")
  const reader = new ProjectReader(options.dataDir),
    token = randomBytes(32).toString("hex")
  const trash = new ProjectTrash(options.dataDir)
  let authority = ""
  const server = createServer((req, res) => {
    const handle = async () => {
      res.setHeader("Cache-Control", "no-store")
      res.setHeader("X-Content-Type-Options", "nosniff")
      res.setHeader("Referrer-Policy", "no-referrer")
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      )
      if (
        req.headers.host !== authority ||
        (req.headers.origin && req.headers.origin !== `http://${authority}`) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new ViewerError(
          403,
          "ORIGIN_DENIED",
          "Access is only allowed from the local workspace",
        )
      if (!["GET", "DELETE", "POST"].includes(req.method ?? "")) {
        res.setHeader("Allow", "GET")
        throw new ViewerError(405, "READ_ONLY", "The workspace is read-only")
      }
      const url = new URL(req.url ?? "/", `http://${authority}`)
      if (
        req.method !== "GET" &&
        !(req.method === "POST" && url.pathname === "/api/projects") &&
        !(req.method === "POST" && /^\/api\/projects\/[^/]+\/settings$/.test(url.pathname)) &&
        !(req.method === "DELETE" && /^\/api\/projects\/[^/]+$/.test(url.pathname)) &&
        !(req.method === "POST" && /^\/api\/trash\/[a-f0-9-]{36}\/restore$/.test(url.pathname))
      ) {
        res.setHeader("Allow", "GET")
        throw new ViewerError(405, "READ_ONLY", "This operation is read-only")
      }
      if (url.pathname === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.end(viewerHtml(token))
        return
      }
      if (url.pathname === "/viewer.js") {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8")
        res.end(await readFile(new URL("../ui/viewer.js", import.meta.url)))
        return
      }
      if (!url.pathname.startsWith("/api/"))
        throw new ViewerError(404, "NOT_FOUND", "Page not found")
      const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
      if (
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        throw new ViewerError(401, "SESSION_REQUIRED", "Open the local workspace to access the API")
      const settings = /^\/api\/projects\/([^/]+)\/settings$/.exec(url.pathname)
      const deletion = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
      const restoration = /^\/api\/trash\/([a-f0-9-]{36})\/restore$/.exec(url.pathname)
      if (req.method !== "GET") {
        if (req.headers.origin !== `http://${authority}`)
          throw new ViewerError(
            403,
            "ORIGIN_REQUIRED",
            "Project operations require a local browser origin",
          )
        let result: unknown
        if (req.method === "POST" && url.pathname === "/api/projects") {
          result = await createProject(options.dataDir, await readProjectBody(req))
          res.statusCode = 201
        } else if (req.method === "POST" && settings) {
          let name: string
          try {
            name = decodeURIComponent(settings[1]!)
          } catch {
            throw new ViewerError(400, "INVALID_PROJECT", "Invalid project identifier")
          }
          result = await updateProjectDetails(options.dataDir, name, await readProjectBody(req))
        } else if (req.method === "DELETE" && deletion)
          result = await trash.remove(
            decodeURIComponent(deletion[1]!),
            url.searchParams.get("version") ?? "",
          )
        else if (req.method === "POST" && restoration) result = await trash.restore(restoration[1]!)
        else throw new ViewerError(405, "READ_ONLY", "This operation is read-only")
        res.setHeader("Content-Type", "application/json; charset=utf-8")
        res.end(JSON.stringify(result))
        return
      }
      if (url.pathname === "/api/trash") {
        res.setHeader("Content-Type", "application/json; charset=utf-8")
        res.end(JSON.stringify(await trash.list()))
        return
      }
      let value: unknown
      if (url.pathname === "/api/projects") value = await reader.list()
      else {
        const match = /^\/api\/projects\/([^/]+)(?:\/trace)?$/.exec(url.pathname)
        if (!match) throw new ViewerError(404, "NOT_FOUND", "Operation not found")
        let name: string
        try {
          name = decodeURIComponent(match[1]!)
        } catch {
          throw new ViewerError(400, "INVALID_PROJECT", "Invalid project identifier")
        }
        if (url.pathname.endsWith("/trace")) {
          const subject = url.searchParams.get("id")
          if (!subject || subject.length > 512)
            throw new ViewerError(400, "SUBJECT_REQUIRED", "A link identifier is required")
          value = await reader.trace(name, subject, url.searchParams.get("version") ?? undefined)
        } else value = await reader.read(name)
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8")
      res.end(JSON.stringify(value))
    }
    void handle().catch((error) => {
      if (res.headersSent) {
        res.end()
        return
      }
      res.statusCode = error instanceof ViewerError ? error.status : 500
      res.setHeader("Content-Type", "application/json; charset=utf-8")
      res.end(
        JSON.stringify({
          code: error instanceof ViewerError ? error.code : "READ_FAILED",
          error: error instanceof ViewerError ? error.message : "Unable to read project files",
        }),
      )
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Viewer address unavailable")
  authority = `127.0.0.1:${address.port}`
  return {
    server,
    url: `http://${authority}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
