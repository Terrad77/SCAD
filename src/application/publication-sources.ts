import {
  ProjectReader,
  SnapshotMemory,
  validatePipelineArtifact,
  ViewerError,
} from "./project-reader.js"
import { ProjectRuns } from "./project-runs.js"
import { ProductionRevisionEngine, type ProductionSnapshot } from "../core/production/revisions.js"
import {
  ApprovalLedger,
  contentSignature,
  dependencySignature,
} from "../core/production/approval.js"
import { ProductionEngine } from "../agents/production/production-engine.js"
import { PIPELINE_ORDER } from "../core/pipeline.js"
import { ResearchBundleSchema } from "../core/schemas.js"
import { contentChecks } from "../core/production/issues.js"
import type { PublicationSource } from "../core/publication.js"

export async function publicationSources(base: string, name: string) {
  const { view, files } = await new ProjectReader(base).publicationSnapshot(name)
  const memory = new SnapshotMemory(files)
  const sources: PublicationSource[] = []
  const notices: string[] = []
  if (
    Object.values(view.files).some(
      (file) => file.status === "CORRUPT" || file.status === "UNREADABLE",
    ) ||
    view.production.publication === "PUBLISHING"
  )
    return {
      view,
      sources,
      notices: ["Repair invalid files or finish incomplete publication before selecting a source."],
    }
  const researchResult = ResearchBundleSchema.safeParse(await memory.get("research"))
  if (!researchResult.success)
    return { view, sources, notices: ["A complete saved research bundle is required."] }
  const research = await memory.get<PublicationSource["research"]>("research")
  const ledger = new ApprovalLedger(memory)
  const add = async (id: string, label: string, snapshot: ProductionSnapshot, proof: unknown) => {
    if (!snapshot.narrative || !snapshot.visual || !snapshot.selfCheck || !snapshot.production)
      return
    if (
      snapshot.reasoningContext.project !== name ||
      snapshot.reasoningContext.question !== view.meta?.question ||
      research?.question !== snapshot.reasoningContext.question
    ) {
      notices.push(label + ": project/question identity does not match saved research.")
      return
    }
    const overlay = new SnapshotMemory({
      ...files,
      ...Object.fromEntries(
        Object.entries(snapshot).map(([key, value]) => [
          key,
          { raw: JSON.stringify(value), error: false },
        ]),
      ),
    })
    const engine = new ProductionEngine(overlay)
    const freshness = await engine.staleness(snapshot.reasoningContext)
    if (
      !freshness.artifacts.length ||
      freshness.artifacts.some((item) => item.status !== "CURRENT")
    ) {
      notices.push(label + ": dependencies are stale or unverified; source is unavailable.")
      return
    }
    const audit = engine.audit({
      context: snapshot.reasoningContext,
      narrative: snapshot.narrative,
      visual: snapshot.visual,
    })
    if (
      contentSignature(snapshot.production) !==
      contentSignature(
        engine.buildManifest({
          context: snapshot.reasoningContext,
          narrative: snapshot.narrative,
          visual: snapshot.visual,
          selfCheck: snapshot.selfCheck,
        }),
      )
    ) {
      notices.push(label + ": production manifest does not match the selected bundle.")
      return
    }
    if (
      !snapshot.selfCheck.production ||
      contentSignature(contentChecks(audit)) !==
        contentSignature(contentChecks(snapshot.selfCheck.production))
    ) {
      notices.push(label + ": saved content audit does not match.")
      return
    }
    const proofSignature = contentSignature(proof)
    sources.push({
      id,
      label,
      snapshot: {
        ...snapshot,
        narrative: snapshot.narrative,
        visual: snapshot.visual,
        selfCheck: snapshot.selfCheck,
        production: snapshot.production,
      },
      research: research!,
      proofSignature,
      dependencySignature: contentSignature({
        project: view.readVersion,
        approvals: files.approved.raw,
        proofSignature,
      }),
    })
  }
  const { run } = await new ProjectRuns(base).status(name)
  if (run?.state === "COMPLETED" && run.project === name) {
    const consumed: Record<string, unknown> = {}
    let valid = true
    for (const stage of PIPELINE_ORDER) {
      const artifact = await memory.get(stage)
      try {
        validatePipelineArtifact(stage, artifact)
      } catch {
        valid = false
        break
      }
      if (
        !(await ledger.isApproved({
          stage,
          artifactSignature: contentSignature(artifact),
          dependencySignature: dependencySignature(consumed),
        }))
      ) {
        valid = false
        break
      }
      consumed[stage] = artifact
    }
    if (valid) {
      const snapshot = {
        reasoningContext: consumed.reasoningContext,
        narrative: consumed.narrative,
        visual: consumed.visual,
        selfCheck: consumed.selfCheck,
        production: await memory.get("production"),
      } as ProductionSnapshot
      await add("run:" + run.id, "Completed run · " + run.startedAt, snapshot, {
        run,
        approved: await ledger.all(),
      })
    } else
      notices.push("The completed run lacks matching human stage approvals for current materials.")
  }
  const revisions = await new ProductionRevisionEngine(memory).history()
  for (const revision of revisions
    .filter((item) => item.status === "COMPLETED")
    .slice(-10)
    .reverse()) {
    if (
      await ledger.isApproved({
        stage: revision.id + ".final",
        artifactSignature: contentSignature(revision.candidate),
        dependencySignature: contentSignature(revision.plan),
      })
    )
      await add(
        "revision:" + revision.id,
        "Completed revision · " + revision.id,
        revision.candidate,
        { revision, approval: await ledger.get(revision.id + ".final") },
      )
    else notices.push(revision.id + ": completed revision approval cannot be verified.")
  }
  if (Buffer.byteLength(JSON.stringify(sources)) > 8 * 1024 * 1024)
    throw new ViewerError(
      413,
      "PUBLICATION_SOURCE_UNAVAILABLE",
      "Publication source choices exceed the 8 MB limit",
    )
  if (!sources.length)
    notices.push(
      "Complete and approve the production pipeline or a production revision before creating a package. Historical revisions need verifiable current research dependencies.",
    )
  return { view, sources, notices }
}
