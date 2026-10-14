import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { ProjectRuns } from "../src/application/project-runs.js"
import { ProjectReader, validatePipelineArtifact } from "../src/application/project-reader.js"
import { initProject } from "../src/storage/project-store.js"
import { withProjectWrite } from "../src/application/project-write-coordinator.js"
import { PIPELINE_ORDER, type PipelineStage } from "../src/core/pipeline.js"
import { contentSignature, dependencySignature } from "../src/core/production/approval.js"
import { startViewer, type ViewerServer } from "../src/server/viewer-server.js"
import type { SelfCheckOutput } from "../src/core/schemas.js"
let root: string, jobs: ProjectRuns, server: ViewerServer | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scad-workflow-"))
  await initProject(root, "demo", "How does evolution work?", "Evolution")
  vi.stubEnv("LLM_PROVIDER", "mock")
  vi.stubEnv("SEARCH_PROVIDER", "mock")
  vi.stubEnv("CONTENT_PROVIDER", "noop")
  vi.stubEnv("SCAD_SEARCH_CACHE", "0")
  vi.stubEnv("SCAD_REFERENCE_DATE", "2026-10-13T00:00:00.000Z")
  jobs = new ProjectRuns(root)
  await jobs.start("demo", {
    requestId: randomUUID(),
    expectedVersion: (await new ProjectReader(root).read("demo")).readVersion,
  })
  await settled()
})
afterEach(async () => {
  await jobs.close()
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function settled() {
  await vi.waitFor(async () => expect((await jobs.status("demo")).run?.state).not.toBe("RUNNING"), {
    timeout: 10000,
  })
  await vi.waitFor(() => withProjectWrite(root, "demo", "test-ready", async () => {}))
}
async function decision(action: "APPROVE" | "REJECT" = "APPROVE") {
  const r = await jobs.review("demo")
  return {
    requestId: randomUUID(),
    runId: r.runId,
    expectedVersion: r.version,
    artifactSignature: r.artifactSignature,
    dependencySignature: r.dependencySignature,
    action,
    reason: "Test review",
  }
}
async function resume() {
  const r = await jobs.review("demo")
  await jobs.resume("demo", { requestId: randomUUID(), runId: r.runId, expectedVersion: r.version })
  await settled()
}
async function advance(stage: PipelineStage) {
  for (const key of PIPELINE_ORDER) {
    expect((await jobs.status("demo")).run).toMatchObject({ state: "WAITING_REVIEW", stage: key })
    if (key === stage) return
    await jobs.decide("demo", await decision())
    await resume()
  }
}
describe("complete governed browser workflow", () => {
  it("refuses malformed preparation before rendering its summary", () => {
    expect(() => validatePipelineArtifact("epistemicPreparation", { inputs: {} })).toThrow(
      "valid saved epistemicPreparation",
    )
  })
  it("reviews every real stage and exports only after the final explicit continuation", async () => {
    for (const [index, stage] of PIPELINE_ORDER.entries()) {
      const review = await jobs.review("demo")
      expect(review).toMatchObject({ stage, decidable: true, unchanged: true })
      expect(Object.keys(review.upstream)).toEqual(PIPELINE_ORDER.slice(0, index))
      expect(review.dependencySignature).toBe(dependencySignature(review.upstream))
      expect(review.artifactSignature).toBe(contentSignature(review.artifact))
      expect(review.summary.length).toBeGreaterThan(0)
      if (stage === "selfCheck") {
        const audit = review.artifact as SelfCheckOutput
        for (const check of audit.production!.checks)
          expect(
            review.summary.some((line) => line.includes(check.id + " · " + check.status)),
          ).toBe(true)
      }
      const protectedBytes = await Promise.all(
        PIPELINE_ORDER.slice(0, index + 1).map((key) =>
          readFile(join(root, "demo", "memory", key + ".json")),
        ),
      )
      await jobs.decide("demo", await decision())
      const ledger = JSON.parse(
        await readFile(join(root, "demo", "memory", "approved.json"), "utf8"),
      ) as Record<string, { authority: string }>
      expect(ledger[stage]?.authority).toBe("human")
      expect(await readdir(join(root, "demo", "output"))).toEqual([])
      await resume()
      for (const [i, key] of PIPELINE_ORDER.slice(0, index + 1).entries())
        expect(await readFile(join(root, "demo", "memory", key + ".json"))).toEqual(
          protectedBytes[i],
        )
    }
    expect((await jobs.status("demo")).run?.state).toBe("COMPLETED")
    expect(await readdir(join(root, "demo", "output"))).toContain("script.md")
    const audit = JSON.parse(
      await readFile(join(root, "demo", "memory", "selfCheck.json"), "utf8"),
    ) as { production: { verdict: string } }
    expect(["PASS", "WARN", "FAIL", "UNKNOWN"]).toContain(audit.production.verdict)
  }, 30000)
  it.each(["candidate", "upstream", "approval", "metadata"])(
    "refuses %s drift at a Claims checkpoint",
    async (kind) => {
      await advance("claims")
      const request = await decision()
      const name =
        kind === "candidate"
          ? "memory/claims.json"
          : kind === "upstream"
            ? "memory/research.json"
            : kind === "approval"
              ? "memory/approved.json"
              : "project.json"
      const path = join(root, "demo", name)
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
      if (kind === "approval") value.research = { authority: "auto" }
      else if (kind === "metadata") value.title = "Changed"
      else value.extra = "Changed signed content"
      await writeFile(path, JSON.stringify(value))
      await expect(jobs.decide("demo", request)).rejects.toMatchObject({ status: 409 })
    },
  )
  it("rejects downstream while keeping its candidate and forbidding Resume", async () => {
    await advance("narrative")
    const path = join(root, "demo", "memory", "narrative.json"),
      bytes = await readFile(path)
    await jobs.decide("demo", await decision("REJECT"))
    expect(await readFile(path)).toEqual(bytes)
    await expect(resume()).rejects.toMatchObject({ status: 409 })
    expect(await readdir(join(root, "demo", "memory"))).not.toContain("visual.json")
  }, 20000)
  it.each([false, true])(
    "reconciles a downstream interrupted decision, journal committed=%s",
    async (committed) => {
      await advance("claims")
      const input = await decision(),
        id = input.runId
      const first = await jobs.decide("demo", input)
      const folder = join(root, ".scad-runs", (await readdir(join(root, ".scad-runs")))[0]!)
      await rm(join(folder, id + ".decision-done.json"))
      if (!committed) {
        const path = join(folder, id + ".json"),
          saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        delete saved.decision
        saved.events = (saved.events as unknown[]).slice(0, -1)
        await writeFile(path, JSON.stringify(saved))
      }
      expect(await jobs.decide("demo", input)).toEqual(first)
      expect(
        (await jobs.status("demo")).run?.events.filter((e) => e.message.includes("claims decision"))
          .length,
      ).toBe(1)
    },
  )
  it("refuses receipts from another stage even with a recomputed digest", async () => {
    await advance("claims")
    const input = await decision()
    await jobs.decide("demo", input)
    const folder = join(root, ".scad-runs", (await readdir(join(root, ".scad-runs")))[0]!)
    const path = join(folder, input.runId + ".decision.json"),
      receipt = JSON.parse(await readFile(path, "utf8")) as { approval: { stage: string } }
    receipt.approval.stage = "research"
    await writeFile(path, JSON.stringify(receipt))
    await writeFile(join(folder, input.runId + ".decision-done.json"), contentSignature(receipt))
    await expect(jobs.decide("demo", input)).rejects.toMatchObject({ code: "DECISION_INVALID" })
    await expect(resume()).rejects.toMatchObject({ status: 409 })
  })
  it("exposes Claims via protected HTTP review and rejects foreign origin decisions", async () => {
    await advance("claims")
    server = await startViewer({ dataDir: root, port: 0 })
    const token = (await (await fetch(server.url)).text()).match(
      /name="scad-session" content="([a-f0-9]+)"/,
    )![1]!
    const url = server.url + "/api/projects/demo/review",
      auth = { Authorization: "Bearer " + token }
    expect((await fetch(url)).status).toBe(401)
    expect(await (await fetch(url, { headers: auth })).json()).toMatchObject({ stage: "claims" })
    const body = JSON.stringify(await decision())
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...auth, Origin: "https://evil.example", "Content-Type": "application/json" },
          body,
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...auth, Origin: server.url, "Content-Type": "application/json" },
          body,
        })
      ).status,
    ).toBe(200)
  })
})
