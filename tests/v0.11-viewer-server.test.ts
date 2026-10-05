import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
import { initProject } from "../src/storage/project-store.js"
let root: string, viewer: ViewerServer, token: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-viewer-http-"))
  await initProject(root, "demo", "Question", "Demo")
  await writeFile(join(root, "demo", "memory", ".env"), "SECRET_PROVIDER_KEY=never-expose")
  viewer = await startViewer({ dataDir: root, port: 0 })
  const response = await fetch(viewer.url)
  token = (await response.text()).match(/name="scad-session" content="([a-f0-9]+)"/)![1]!
})
afterEach(async () => {
  await viewer.close()
  await rm(root, { force: true, recursive: true })
})
const headers = () => ({ Authorization: `Bearer ${token}` })
describe("v0.11 local viewer API", () => {
  it("binds loopback, serves protected HTML and reads projects without exposing secrets", async () => {
    expect(viewer.server.address()).toMatchObject({ address: "127.0.0.1" })
    const page = await fetch(viewer.url)
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(page.headers.get("access-control-allow-origin")).toBeNull()
    const list = await fetch(`${viewer.url}/api/projects`, { headers: headers() })
    expect(await list.json()).toEqual([
      { id: "demo", title: "Demo", question: "Question", status: "VALID" },
    ])
    const project = await fetch(`${viewer.url}/api/projects/demo`, { headers: headers() })
    const body = await project.text()
    expect(body).toContain('"mode":"READ_ONLY"')
    expect(body).not.toContain("SECRET_PROVIDER_KEY")
    expect(body).not.toContain("never-expose")
  })
  it.each([undefined, "Bearer wrong"])(
    "requires the local capability for API access: %s",
    async (authorization) => {
      const response = await fetch(`${viewer.url}/api/projects`, {
        headers: authorization ? { Authorization: authorization } : {},
      })
      expect(response.status).toBe(401)
    },
  )
  it("rejects an external Origin and cross-site requests even with a capability", async () => {
    const response = await fetch(`${viewer.url}/api/projects`, {
      headers: { ...headers(), Origin: "https://evil.example" },
    })
    expect(response.status).toBe(403)
    const site = await fetch(`${viewer.url}/api/projects`, {
      headers: { ...headers(), "Sec-Fetch-Site": "cross-site" },
    })
    expect(site.status).toBe(403)
  })
  it("rejects untrusted Host values to prevent rebinding", async () => {
    const result = await new Promise<number>((resolve) => {
      const req = request(viewer.url, { headers: { Host: "evil.example" } }, (response) => {
        response.resume()
        resolve(response.statusCode!)
      })
      req.end()
    })
    expect(result).toBe(403)
  })
  it.each(["POST", "PUT", "PATCH"])(
    "refuses unsupported mutating HTTP method %s",
    async (method) => {
      const response = await fetch(`${viewer.url}/api/projects/demo`, {
        method,
        headers: headers(),
      })
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET")
    },
  )
  it("refuses arbitrary paths, unknown commands and encoded traversal", async () => {
    for (const path of ["/.env", "/api/files?path=.env", "/api/projects/demo/revise"])
      expect((await fetch(`${viewer.url}${path}`, { headers: headers() })).status).toBe(404)
    expect(
      (await fetch(`${viewer.url}/api/projects/demo%2F..%2Fdemo`, { headers: headers() })).status,
    ).toBe(400)
  })
  it("validates trace subjects and reports missing nodes explicitly", async () => {
    expect(
      (await fetch(`${viewer.url}/api/projects/demo/trace`, { headers: headers() })).status,
    ).toBe(400)
    const response = await fetch(`${viewer.url}/api/projects/demo/trace?id=CLM_MISSING`, {
      headers: headers(),
    })
    expect((await response.json()).nodes[0]).toMatchObject({ id: "CLM_MISSING", status: "MISSING" })
  })
})
