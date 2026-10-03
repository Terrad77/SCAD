import { z } from "zod"
import type { MemoryStore } from "../memory/json-memory.js"
import { ScopedMemory } from "../memory/scoped-memory.js"
import type { ApprovalGate } from "../pipeline.js"
import { ApprovalLedger, contentSignature, dependencySignature } from "./approval.js"
import {
  EPISTEMIC_PIPELINE_KEYS,
  REASONING_ARTIFACT_KEYS,
  PRODUCTION_WRITE_KEYS,
} from "./write-scope.js"
import { ReasoningContextSchema, ProductionManifestSchema } from "./schemas.js"
import {
  NarrativeSchema,
  VisualOutputSchema,
  SelfCheckOutputSchema,
  type ResearchBundle,
  type Hypothesis,
  type HypothesisVerification,
} from "../schemas.js"
import { verifyContextIntegrity } from "./signature.js"
import { guardNarrative, guardVisual } from "./guards.js"
import { ProductionEngine } from "../../agents/production/production-engine.js"
import { buildReasoningContext } from "../../agents/production/reasoning-context.js"
import type { EpistemicPreparationResult } from "../../agents/production/epistemic-prep.js"
import type { ReasoningContext } from "./types.js"

export const REVISION_STAGES = ["reasoningContext", "narrative", "visual", "selfCheck"] as const
export type RevisionStage = (typeof REVISION_STAGES)[number]
export const REVISION_KEY = "production-revisions"
const PROTECTED = [...EPISTEMIC_PIPELINE_KEYS, ...REASONING_ARTIFACT_KEYS, "epistemicPreparation"]
const SnapshotSchema = z.object({
  reasoningContext: ReasoningContextSchema,
  narrative: NarrativeSchema.nullable(),
  visual: VisualOutputSchema.nullable(),
  selfCheck: SelfCheckOutputSchema.nullable(),
  production: ProductionManifestSchema.nullable(),
})
export type ProductionSnapshot = z.infer<typeof SnapshotSchema>
const PlanSchema = z.object({
  id: z.string(),
  requested: z.enum(REVISION_STAGES).nullable(),
  start: z.enum(REVISION_STAGES).nullable(),
  stages: z.array(z.enum(REVISION_STAGES)),
  baselineSignature: z.string(),
  protectedSignature: z.string(),
  targetContextSignature: z.string(),
  reasons: z.array(z.string()),
  autoRegenerate: z.literal(false),
})
export const RevisionPlanSchema = PlanSchema
export type RevisionPlan = z.infer<typeof PlanSchema>
const RevisionSchema = z.object({
  id: z.string(),
  plan: PlanSchema,
  status: z.enum(["DRAFT", "REJECTED", "PUBLISHING", "COMPLETED"]),
  baseline: SnapshotSchema,
  candidate: SnapshotSchema,
  generated: z.array(z.enum(REVISION_STAGES)),
  generationSignatures: z.record(z.string()),
  completed: z.array(z.enum(REVISION_STAGES)),
  published: z.array(
    z.enum(["reasoningContext", "narrative", "visual", "selfCheck", "production"]),
  ),
})
export type ProductionRevision = z.infer<typeof RevisionSchema>
const JournalSchema = z.object({ version: z.literal(1), revisions: z.array(RevisionSchema) })
type Journal = z.infer<typeof JournalSchema>

export type RevisionGenerator = (
  stage: RevisionStage,
  candidate: ProductionSnapshot,
) => Promise<unknown>

/** Governed drafts. No epistemic stage is executed by this engine. Single writer per project. */
export class ProductionRevisionEngine {
  private readonly production: MemoryStore
  private readonly journalStore: MemoryStore
  private readonly ledger: ApprovalLedger

  constructor(private readonly memory: MemoryStore) {
    this.production = new ScopedMemory(memory, new Set(PRODUCTION_WRITE_KEYS))
    this.journalStore = new ScopedMemory(memory, new Set([REVISION_KEY]))
    this.ledger = new ApprovalLedger(memory)
  }

  private async read<T>(key: string): Promise<T | null> {
    const raw = await this.memory.readRaw(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  }

  private async journal(): Promise<Journal> {
    const stored = await this.read<{ body: unknown; signature: string }>(REVISION_KEY)
    if (stored === null) return { version: 1, revisions: [] }
    if (contentSignature(stored.body) !== stored.signature)
      throw new Error("Corrupt production revision journal")
    JournalSchema.parse(stored.body)
    return stored.body as Journal
  }

  private async save(journal: Journal): Promise<void> {
    await this.journalStore.save(REVISION_KEY, {
      body: journal,
      signature: contentSignature(journal),
    })
  }

  async history(): Promise<ProductionRevision[]> {
    return (await this.journal()).revisions
  }

  private async protectedSignature(): Promise<string> {
    const inputs: Record<string, unknown> = {}
    for (const key of PROTECTED) inputs[key] = await this.memory.readRaw(key)
    return contentSignature(inputs)
  }

  private async snapshot(): Promise<ProductionSnapshot> {
    const context = await this.read("reasoningContext")
    ReasoningContextSchema.parse(context)
    // Corrupt context can be explicitly replaced, but is never consumed for generation.
    const snapshot = {
      reasoningContext: context,
      narrative: await this.read("narrative"),
      visual: await this.read("visual"),
      selfCheck: await this.read("selfCheck"),
      production: await this.read("production"),
    }
    SnapshotSchema.parse(snapshot)
    return snapshot as ProductionSnapshot
  }

  private async liveContext(persisted: ReasoningContext): Promise<ReasoningContext> {
    const research = await this.read<ResearchBundle>("research")
    if (research === null) throw new Error("Research is required; revisions cannot run research")
    const hypotheses = await this.read<{
      hypotheses: Hypothesis[]
      verifications?: HypothesisVerification[]
    }>("hypotheses")
    const prep = await this.read<EpistemicPreparationResult>("epistemicPreparation")
    return buildReasoningContext({
      project: persisted.project,
      question: persisted.question,
      referenceDate: persisted.referenceDate,
      research,
      hypotheses: hypotheses?.hypotheses ?? null,
      verifications: hypotheses?.verifications ?? null,
      ...(prep?.inputs?.limits === undefined ? {} : { intelligenceLimits: prep.inputs.limits }),
      memory: new ScopedMemory(this.memory, new Set()),
    })
  }

  /** Preview only: no journal, approval, provider call or output write. */
  async plan(requested?: RevisionStage): Promise<RevisionPlan> {
    const before = await this.protectedSignature()
    const baseline = await this.snapshot()
    const live = await this.liveContext(baseline.reasoningContext)
    const stale = await new ProductionEngine(new ScopedMemory(this.memory, new Set())).staleness(
      baseline.reasoningContext,
    )
    const reasons = stale.artifacts
      .filter((a) => a.status !== "CURRENT")
      .map((a) => `${a.artifact}: ${a.status}/${a.reason ?? "unverified"}`)
    const contextChanged =
      !verifyContextIntegrity(baseline.reasoningContext).valid ||
      contentSignature(live) !== contentSignature(baseline.reasoningContext)
    if (contextChanged)
      reasons.unshift(
        "reasoningContext: current epistemic/reasoning inputs differ or context is corrupt",
      )
    let index = contextChanged ? 0 : REVISION_STAGES.length
    for (const artifact of stale.artifacts) {
      if (artifact.status !== "CURRENT")
        index = Math.min(index, REVISION_STAGES.indexOf(artifact.artifact as RevisionStage))
    }
    if (requested !== undefined) {
      index = Math.min(index, REVISION_STAGES.indexOf(requested))
      reasons.push(`Explicit request: ${requested}`)
    }
    if (
      before !== (await this.protectedSignature()) ||
      contentSignature(baseline) !== contentSignature(await this.snapshot())
    )
      throw new Error("Inputs changed during planning; make a new plan")
    const body = {
      requested: requested ?? null,
      start: REVISION_STAGES[index] ?? null,
      stages: REVISION_STAGES.slice(index),
      baselineSignature: contentSignature(baseline),
      protectedSignature: before,
      targetContextSignature: live.contextSignature,
      reasons,
      autoRegenerate: false as const,
    }
    return { id: `PLAN_${contentSignature(body)}`, ...body }
  }

  async apply(
    plan: RevisionPlan,
    generate: RevisionGenerator,
    approvals: ApprovalGate,
  ): Promise<ProductionRevision> {
    PlanSchema.parse(plan)
    const journal = await this.journal()
    let revision = journal.revisions.find((r) => r.plan.id === plan.id && r.status !== "REJECTED")
    if (revision && contentSignature(revision.plan) !== contentSignature(plan))
      throw new Error("Stored plan differs; resume the original plan")
    if (revision?.status === "COMPLETED") return revision
    if (revision === undefined) {
      if (journal.revisions.some((r) => r.status === "DRAFT" || r.status === "PUBLISHING"))
        throw new Error("A revision is pending; resume or reject it first")
      if (contentSignature(await this.plan(plan.requested ?? undefined)) !== contentSignature(plan))
        throw new Error("Plan changed; review a new plan")
      if (plan.stages.length === 0)
        throw new Error("Nothing to revise; choose a production stage explicitly")
      const baseline = await this.snapshot()
      revision = {
        id: `REV_${String(journal.revisions.length + 1).padStart(4, "0")}`,
        plan,
        status: "DRAFT",
        baseline,
        candidate: structuredClone(baseline),
        generated: [],
        generationSignatures: {},
        completed: [],
        published: [],
      }
      journal.revisions.push(revision)
      await this.save(journal)
    }
    await this.assertInputs(revision)
    if (revision.status === "PUBLISHING") return this.publish(journal, revision)
    for (const stage of plan.stages) {
      await this.assertInputs(revision)
      const proposalStage = `${revision.id}.${stage}`
      if (
        !revision.generated.includes(stage) ||
        revision.generationSignatures[stage] !== this.dependencies(revision, stage)
      ) {
        const result =
          stage === "reasoningContext"
            ? await this.liveContext(revision.baseline.reasoningContext)
            : await generate(stage, structuredClone(revision.candidate))
        this.setArtifact(revision.candidate, stage, result)
        if (revision.candidate.reasoningContext.contextSignature !== plan.targetContextSignature)
          throw new Error("Context no longer matches reviewed plan")
        if (!revision.generated.includes(stage)) revision.generated.push(stage)
        revision.generationSignatures[stage] = this.dependencies(revision, stage)
        await this.save(journal)
      }
      while (true) {
        const artifact = revision.candidate[stage]
        const proposal = {
          stage: proposalStage,
          artifactSignature: contentSignature(artifact),
          dependencySignature: this.dependencies(revision, stage),
        }
        if (await this.ledger.isApproved(proposal)) break
        const decision = await approvals.review(`revision.${stage}`, {
          revisionId: revision.id,
          artifact,
          diff: revisionDiff(revision),
        })
        await this.assertInputs(revision)
        if (decision.regenerate) {
          const result =
            stage === "reasoningContext"
              ? await this.liveContext(revision.baseline.reasoningContext)
              : await generate(stage, structuredClone(revision.candidate))
          this.setArtifact(revision.candidate, stage, result)
          revision.generationSignatures[stage] = this.dependencies(revision, stage)
          await this.save(journal)
          continue
        }
        if (!decision.approved) {
          revision.status = "REJECTED"
          await this.save(journal)
          throw new Error(`Revision ${revision.id} rejected at ${stage}`)
        }
        if (decision.authority !== "human")
          throw new Error("Production revisions require explicit human approval")
        if (decision.replacement !== undefined) {
          if (stage === "reasoningContext" || stage === "selfCheck")
            throw new Error("Context and audit cannot be manually replaced; regenerate instead")
          this.setArtifact(revision.candidate, stage, decision.replacement)
          await this.save(journal)
          // Re-open review on the persisted, guarded edit. The editor's input
          // is not consent to unseen guard corrections or a different artifact.
          if (
            contentSignature(artifact) !== contentSignature(revision.candidate[stage]) ||
            contentSignature(decision.replacement) !== contentSignature(revision.candidate[stage])
          )
            continue
        }
        await this.ledger.record({
          ...proposal,
          artifactSignature: contentSignature(revision.candidate[stage]),
          authority: "human",
          modified: decision.replacement !== undefined,
          decidedAt: new Date().toISOString(),
        })
        break
      }
      if (!revision.completed.includes(stage)) revision.completed.push(stage)
      await this.save(journal)
    }
    const { reasoningContext, narrative, visual, selfCheck } = revision.candidate
    if (!narrative || !visual || !selfCheck) throw new Error("Revision is incomplete")
    revision.candidate.production = new ProductionEngine(this.production).buildManifest({
      context: reasoningContext,
      narrative,
      visual,
      selfCheck,
    })
    if (revision.candidate.production.staleness.artifacts.some((a) => a.status !== "CURRENT"))
      throw new Error("Revision dependencies are not current")
    await this.save(journal)
    const final = {
      stage: `${revision.id}.final`,
      artifactSignature: contentSignature(revision.candidate),
      dependencySignature: contentSignature(plan),
    }
    if (!(await this.ledger.isApproved(final))) {
      const decision = await approvals.review("revision.final", {
        revisionId: revision.id,
        candidate: revision.candidate,
        diff: revisionDiff(revision),
      })
      await this.assertInputs(revision)
      if (!decision.approved) {
        revision.status = "REJECTED"
        await this.save(journal)
        throw new Error(`Revision ${revision.id} rejected at final review`)
      }
      if (decision.authority !== "human" || decision.replacement !== undefined)
        throw new Error("Final revision requires human approval without replacement")
      await this.ledger.record({
        ...final,
        authority: "human",
        modified: false,
        decidedAt: new Date().toISOString(),
      })
    }
    revision.status = "PUBLISHING"
    await this.save(journal)
    return this.publish(journal, revision)
  }

  async resume(generate: RevisionGenerator, approvals: ApprovalGate): Promise<ProductionRevision> {
    const pending = (await this.journal()).revisions.find(
      (r) => r.status === "DRAFT" || r.status === "PUBLISHING",
    )
    if (!pending) throw new Error("No pending production revision")
    return this.apply(pending.plan, generate, approvals)
  }

  async reject(): Promise<void> {
    const journal = await this.journal()
    const pending = journal.revisions.find((r) => r.status === "DRAFT")
    if (!pending) throw new Error("No draft to reject; a publishing revision must be resumed")
    pending.status = "REJECTED"
    await this.save(journal)
  }

  private dependencies(revision: ProductionRevision, stage: RevisionStage): string {
    const dependencies: Record<string, unknown> = { plan: revision.plan }
    for (const upstream of REVISION_STAGES.slice(0, REVISION_STAGES.indexOf(stage)))
      dependencies[upstream] = revision.candidate[upstream]
    return dependencySignature(dependencies)
  }

  private setArtifact(candidate: ProductionSnapshot, stage: RevisionStage, value: unknown): void {
    switch (stage) {
      case "reasoningContext": {
        ReasoningContextSchema.parse(value)
        const context = value as ProductionSnapshot["reasoningContext"]
        if (!verifyContextIntegrity(context).valid) throw new Error("Invalid context signature")
        candidate.reasoningContext = context
        break
      }
      case "narrative":
        candidate.narrative = guardNarrative(
          NarrativeSchema.parse(value),
          candidate.reasoningContext,
        ).artifact
        break
      case "visual": {
        if (!candidate.narrative) throw new Error("Narrative required")
        candidate.visual = guardVisual(
          VisualOutputSchema.parse(value),
          candidate.narrative,
          candidate.reasoningContext,
        ).artifact
        break
      }
      case "selfCheck": {
        const report = SelfCheckOutputSchema.parse(value)
        if (!candidate.narrative || !candidate.visual)
          throw new Error("Production artifacts required for audit")
        candidate.selfCheck = {
          ...report,
          production: new ProductionEngine(this.production).audit({
            context: candidate.reasoningContext,
            narrative: candidate.narrative,
            visual: candidate.visual,
          }),
        }
        break
      }
    }
  }

  private async assertInputs(revision: ProductionRevision): Promise<void> {
    if ((await this.protectedSignature()) !== revision.plan.protectedSignature)
      throw new Error("Epistemic/reasoning inputs changed; reject draft and review a new plan")
    const current = await this.snapshot()
    for (const key of PRODUCTION_WRITE_KEYS) {
      const actual = contentSignature(current[key])
      const baseline = contentSignature(revision.baseline[key])
      const candidate = contentSignature(revision.candidate[key])
      if (
        revision.status === "PUBLISHING"
          ? actual !== baseline && actual !== candidate
          : actual !== baseline
      )
        throw new Error(`Production ${key} changed outside this revision`)
    }
  }

  private async publish(
    journal: Journal,
    revision: ProductionRevision,
  ): Promise<ProductionRevision> {
    const final = {
      stage: `${revision.id}.final`,
      artifactSignature: contentSignature(revision.candidate),
      dependencySignature: contentSignature(revision.plan),
    }
    if (!(await this.ledger.isApproved(final)))
      throw new Error("Final approval missing or changed; cannot publish")
    for (const key of PRODUCTION_WRITE_KEYS) {
      await this.assertInputs(revision)
      if (revision.candidate[key] === null) throw new Error(`Missing ${key}`)
      if (
        !revision.published.includes(key) ||
        contentSignature(await this.read(key)) !== contentSignature(revision.candidate[key])
      ) {
        await this.production.save(key, revision.candidate[key])
        if (!revision.published.includes(key)) revision.published.push(key)
        await this.save(journal)
      }
    }
    await this.assertInputs(revision)
    if (contentSignature(await this.snapshot()) !== contentSignature(revision.candidate))
      throw new Error("Published bundle differs from approved revision")
    revision.status = "COMPLETED"
    await this.save(journal)
    return revision
  }
}

export interface RevisionDifference {
  artifact: string
  path: string
  before: unknown
  after: unknown
}
/** Structural diff includes prose, labels, references and provenance; no semantic claims. */
export function revisionDiff(
  revision: Pick<ProductionRevision, "baseline" | "candidate">,
): RevisionDifference[] {
  const differences: RevisionDifference[] = []
  const walk = (artifact: string, path: string, before: unknown, after: unknown): void => {
    if (contentSignature(before ?? null) === contentSignature(after ?? null)) return
    if (before && after && typeof before === "object" && typeof after === "object") {
      const left = before as Record<string, unknown>,
        right = after as Record<string, unknown>
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
        walk(
          artifact,
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          left[key],
          right[key],
        )
    } else differences.push({ artifact, path, before: before ?? null, after: after ?? null })
  }
  for (const artifact of PRODUCTION_WRITE_KEYS)
    walk(artifact, "", revision.baseline[artifact], revision.candidate[artifact])
  return differences
}

/** Legacy writers must not replace the inputs or expose a partially published bundle. */
export async function assertNoPendingProductionRevision(memory: MemoryStore): Promise<void> {
  const history = await new ProductionRevisionEngine(memory).history()
  if (history.some((r) => r.status === "DRAFT" || r.status === "PUBLISHING"))
    throw new Error(
      "Production revision pending; resume or reject it before running another pipeline",
    )
}
