import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectReader } from "../src/application/project-reader.js"
import { buildProjectExport } from "../src/application/project-export.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"

let root: string
let reader: ProjectReader
let server: ViewerServer | undefined
const narrative = {
  title: "An unresolved question",
  logline: "What might happen?",
  thesis: "Uncertainty remains.",
  sections: [
    {
      id: "SEC_1",
      heading: "Possibilities",
      sentences: [
        {
          id: "SNT_1",
          text: "This might be possible.",
          knowledge: "SPECULATION",
          claimIds: ["CLM_1"],
          hypothesisIds: ["HYP_1"],
          uncertaintyIds: ["UNC_1"],
          contradictionIds: ["CON_1"],
          constraintTreatments: [
            {
              constraintId: "CST_1",
              subjectIds: ["UNC_1"],
              treatment: "acknowledge-uncertainty",
              explanation: "The uncertainty remains open.",
            },
          ],
        },
      ],
    },
  ],
  retainedUnknownField: { value: "must not strip" },
}
const raw = JSON.stringify(narrative, null, 4) + "\n"
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-export-"))
  await mkdir(join(root, "film", "memory"), { recursive: true })
  await writeFile(
    join(root, "film", "project.json"),
    JSON.stringify({ project: "film", title: "Film", question: "Why?" }),
  )
  await writeFile(join(root, "film", "memory", "narrative.json"), raw)
  reader = new ProjectReader(root)
})
afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true })
})
describe("version-bound local review exports", () => {
  it("retains original file contents, missing states and UNKNOWN without writing files", async () => {
    const view = await reader.read("film")
    const download = await reader.export("film", view.readVersion, "snapshot")
    const exported = JSON.parse(download.content)
    expect(exported.schema).toBe("scad.review-export.v1")
    expect(exported.rawFiles.narrative).toBe(raw)
    expect(exported.files.research.status).toBe("MISSING")
    expect(exported.savedAuditVerdict).toBe("UNKNOWN")
    expect(exported.production.freshness).toBeNull()
    expect(exported.notice).toContain("Not a backup")
    expect(exported.rawFiles.approved).toBeUndefined()
    expect(await readdir(join(root, "film"))).toEqual(["memory", "project.json"])
    expect(await readFile(join(root, "film", "memory", "narrative.json"), "utf8")).toBe(raw)
  })
  it("preserves knowledge and explicit references in Markdown with a snapshot qualification", async () => {
    const view = await reader.read("film")
    const file = await reader.export("film", view.readVersion, "script")
    expect(file.filename).toBe("scad-film-script.md")
    for (const text of [
      "[SPECULATION]",
      "CLM_1",
      "HYP_1",
      "UNC_1",
      "CON_1",
      "CST_1",
      view.readVersion,
      "Saved audit: UNKNOWN",
      "Freshness: UNKNOWN",
    ])
      expect(file.content).toContain(text)
  })
  it("refuses stale versions and unsupported requests", async () => {
    const view = await reader.read("film")
    await writeFile(join(root, "film", "memory", "narrative.json"), raw + " ")
    await expect(reader.export("film", view.readVersion, "snapshot")).rejects.toMatchObject({
      code: "VIEW_CHANGED",
    })
    await expect(reader.export("film", "", "snapshot")).rejects.toMatchObject({ status: 400 })
    await expect(reader.export("film", view.readVersion, "../../.env")).rejects.toMatchObject({
      status: 400,
    })
    await expect(reader.export("..", view.readVersion, "snapshot")).rejects.toMatchObject({
      status: 400,
    })
  })
  it("fails closed on corruption and missing scripts while allowing an empty review snapshot", async () => {
    await writeFile(join(root, "film", "memory", "claims.json"), "{")
    let view = await reader.read("film")
    await expect(reader.export("film", view.readVersion, "snapshot")).rejects.toMatchObject({
      code: "EXPORT_INVALID",
    })
    await rm(join(root, "film", "memory", "claims.json"))
    await rm(join(root, "film", "memory", "narrative.json"))
    view = await reader.read("film")
    await expect(reader.export("film", view.readVersion, "script")).rejects.toMatchObject({
      code: "SCRIPT_MISSING",
    })
    expect(
      JSON.parse((await reader.export("film", view.readVersion, "snapshot")).content).rawFiles
        .narrative,
    ).toBeNull()
  })
  it("refuses incoherent publication and preserves a saved FAIL independently of consent", async () => {
    const view = await reader.read("film")
    expect(() =>
      buildProjectExport(
        { ...view, production: { ...view.production, publication: "PUBLISHING" } },
        {},
        "snapshot",
      ),
    ).toThrow("pending publication")
    await writeFile(
      join(root, "film", "memory", "selfCheck.json"),
      JSON.stringify({
        critical: [],
        warnings: [],
        info: [],
        production: {
          inputSignature: "input",
          contextSignature: "context",
          reasoningCycleId: null,
          verdict: "FAIL",
          checks: [],
          diagnostics: [],
          epistemicMutation: false,
        },
      }),
    )
    const withAudit = await reader.read("film")
    expect(
      JSON.parse((await reader.export("film", withAudit.readVersion, "snapshot")).content)
        .savedAuditVerdict,
    ).toBe("FAIL")
  })
  it("bounds captured material before encoding the download", async () => {
    await writeFile(
      join(root, "film", "memory", "narrative.json"),
      JSON.stringify({ ...narrative, retainedUnknownField: "x".repeat(12 * 1024 * 1024) }),
    )
    const view = await reader.read("film")
    await expect(reader.export("film", view.readVersion, "snapshot")).rejects.toMatchObject({
      code: "EXPORT_TOO_LARGE",
    })
  })
  it("protects exports with local session/origin and rejects changed snapshot HTTP requests", async () => {
    server = await startViewer({ dataDir: root, port: 0 })
    const token = (await (await fetch(server.url)).text()).match(
      /name="scad-session" content="([a-f0-9]+)"/,
    )![1]!
    const view = await reader.read("film")
    const url = server.url + "/api/projects/film/export?format=snapshot&version=" + view.readVersion
    expect((await fetch(url)).status).toBe(401)
    const headers = { Authorization: "Bearer " + token }
    expect(
      (await fetch(url, { headers: { ...headers, Origin: "https://evil.example" } })).status,
    ).toBe(403)
    expect((await fetch(url, { method: "POST", headers })).status).toBe(405)
    const response = await fetch(url, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(JSON.parse((await response.json()).content).rawFiles.narrative).toBe(raw)
    await writeFile(join(root, "film", "memory", "narrative.json"), raw + " ")
    expect((await fetch(url, { headers })).status).toBe(409)
  })
})
