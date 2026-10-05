import { createServer, type Server } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { ProjectReader, ViewerError } from "../application/project-reader.js"
import { viewerHtml } from "../ui/html.js"

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
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET")
        throw new ViewerError(405, "READ_ONLY", "The workspace is read-only")
      }
      const url = new URL(req.url ?? "/", `http://${authority}`)
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
