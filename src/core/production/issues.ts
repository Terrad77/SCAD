import { z } from "zod"
import type { MemoryStore } from "../memory/json-memory.js"
import { ScopedMemory } from "../memory/scoped-memory.js"
import { ApprovalLedger, contentSignature, dependencySignature } from "./approval.js"
import type { ApprovalGate } from "../pipeline.js"
import { NarrativeSchema, VisualOutputSchema, SelfCheckOutputSchema } from "../schemas.js"
import { ReasoningContextSchema, SelfCheckDiagnosticSchema } from "./schemas.js"
import { ProductionEngine } from "../../agents/production/production-engine.js"
import { auditProduction } from "./self-check-rules.js"
import {
  ProductionRevisionEngine,
  assertNoPendingProductionRevision,
  type RevisionGenerator,
  RevisionPlanSchema,
} from "./revisions.js"
import {
  readDecisions,
  appendDecision,
  readReasoningCycles,
  loadReasoningCursor,
} from "../../agents/reasoning/reasoning-repository.js"
import type { Narrative, VisualOutput } from "../types.js"
import type { ReasoningContext, ProductionCheckId, SelfCheckDiagnostic } from "./types.js"

export const ISSUE_KEY = "production-issues"
export const ISSUE_ACTIONS = ["fix", "research", "reasoning", "defer", "dismiss"] as const
export type IssueAction = (typeof ISSUE_ACTIONS)[number]
const OperationSchema = z
  .object({
    id: z.string(),
    action: z.enum(ISSUE_ACTIONS),
    note: z.string().min(1),
    status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]),
    plan: RevisionPlanSchema.nullable(),
    sourceCycleId: z.string().nullable(),
    referenceDate: z.string(),
    decisionId: z.string().nullable(),
    revisionId: z.string().nullable(),
    revisionOffset: z.number().int().nonnegative(),
  })
  .strict()
const IssueSchema = z
  .object({
    id: z.string(),
    snapshotSignature: z.string(),
    diagnostic: SelfCheckDiagnosticSchema,
    references: z
      .object({
        sentenceIds: z.array(z.string()),
        shotIds: z.array(z.string()),
        upstreamIds: z.array(z.string()),
      })
      .strict(),
    status: z.enum(["OPEN", "AWAITING_VERIFICATION", "DEFERRED", "DISMISSED", "RESOLVED"]),
    operations: z.array(OperationSchema),
    verificationSignature: z.string().nullable(),
  })
  .strict()
const BodySchema = z.object({ version: z.literal(1), issues: z.array(IssueSchema) }).strict()
const JournalSchema = z.object({ body: BodySchema, signature: z.string() }).strict()
export type ProductionIssue = z.infer<typeof IssueSchema>
type Body = z.infer<typeof BodySchema>
const CHECK: Record<SelfCheckDiagnostic["kind"], ProductionCheckId> = {
  "epistemic-integrity": "EPISTEMIC_INTEGRITY",
  traceability: "TRACEABILITY",
  "unsupported-statement": "UNSUPPORTED_STATEMENTS",
  "uncertainty-loss": "UNCERTAINTY_PRESERVATION",
  "contradiction-suppression": "CONTRADICTION_PRESERVATION",
  "hypothesis-inflation": "HYPOTHESIS_INTEGRITY",
  "hypothesis-inflation-ambiguous": "HYPOTHESIS_INTEGRITY",
  "scope-violation": "SCOPE_COMPLIANCE",
}
// Historical write observations cannot be reconstructed from an artifact snapshot.
// Independently compare all content checks; scope remains UNKNOWN on this read path.
function contentChecks(report: import("./types.js").SelfCheckProductionReport) {
  const { verdict: _verdict, ...rest } = report
  return {
    ...rest,
    checks: report.checks.filter((c) => c.id !== "SCOPE_COMPLIANCE"),
    diagnostics: report.diagnostics.filter((d) => d.kind !== "scope-violation"),
  }
}
function references(
  diagnostic: SelfCheckDiagnostic,
  context: ReasoningContext,
  narrative: Narrative,
  visual: VisualOutput,
) {
  const subjects = new Set(diagnostic.subjectIds)
  for (const uncertainty of context.uncertainties)
    if (subjects.has(uncertainty.uncertaintyId)) subjects.add(uncertainty.subjectId)
  const sentences = narrative.sections
    .flatMap((s) => s.sentences)
    .filter((s) =>
      [
        s.id,
        ...s.claimIds,
        ...(s.hypothesisIds ?? []),
        ...(s.uncertaintyIds ?? []),
        ...(s.contradictionIds ?? []),
        ...(s.constraintTreatments ?? []).flatMap((t) => [t.constraintId, ...t.subjectIds]),
      ].some((id) => subjects.has(id)),
    )
  const sentenceIds = sentences.map((s) => s.id)
  const shots = visual.shots.filter(
    (s) => subjects.has(s.id) || s.narrativeSentenceIds.some((id) => sentenceIds.includes(id)),
  )
  const upstreamIds = new Set([
    ...subjects,
    ...sentences.flatMap((s) => [
      ...s.claimIds,
      ...(s.hypothesisIds ?? []),
      ...(s.uncertaintyIds ?? []),
      ...(s.contradictionIds ?? []),
    ]),
  ])
  for (const constraint of context.constraints)
    if (constraint.subjectIds.some((id) => upstreamIds.has(id))) upstreamIds.add(constraint.id)
  for (const edge of context.traceRefs.claimTraceEdges)
    if (upstreamIds.has(edge.claimId))
      for (const id of [...edge.evidenceIds, ...edge.sourceIds]) upstreamIds.add(id)
  for (const id of [...sentenceIds, ...shots.map((s) => s.id)]) upstreamIds.delete(id)
  return { sentenceIds, shotIds: shots.map((s) => s.id), upstreamIds: [...upstreamIds].sort() }
}
function family(d: SelfCheckDiagnostic) {
  return contentSignature({ kind: d.kind, subjects: [...d.subjectIds].sort() })
}

/** Single-writer journal; diagnostics never enter the epistemic write scope. */
export class ProductionIssueEngine {
  private readonly journal: MemoryStore
  constructor(private readonly memory: MemoryStore) {
    this.journal = new ScopedMemory(memory, new Set([ISSUE_KEY]))
  }
  private async read(): Promise<Body> {
    const raw = await this.journal.readRaw(ISSUE_KEY)
    if (raw === null) return { version: 1, issues: [] }
    const parsed = JournalSchema.parse(JSON.parse(raw))
    if (contentSignature(parsed.body) !== parsed.signature)
      throw new Error("Issue journal signature mismatch")
    if (new Set(parsed.body.issues.map((i) => i.id)).size !== parsed.body.issues.length)
      throw new Error("Duplicate issue IDs")
    return parsed.body
  }
  private async save(body: Body) {
    BodySchema.parse(body)
    await this.journal.save(ISSUE_KEY, { body, signature: contentSignature(body) })
  }
  private async required<T>(key: string, schema: z.ZodType<T>): Promise<T> {
    const raw = await this.memory.readRaw(key)
    if (raw === null) throw new Error(`Missing ${key}; a current signed audit is required`)
    const value: unknown = JSON.parse(raw)
    schema.parse(value)
    // Validation must not strip fields from content covered by an existing signature.
    return value as T
  }
  private async current() {
    await assertNoPendingProductionRevision(this.memory)
    const context = (await this.required(
      "reasoningContext",
      ReasoningContextSchema,
    )) as ReasoningContext
    const narrative = (await this.required("narrative", NarrativeSchema)) as Narrative
    const visual = (await this.required("visual", VisualOutputSchema)) as VisualOutput
    const selfCheck = await this.required("selfCheck", SelfCheckOutputSchema)
    const stale = await new ProductionEngine(this.memory).staleness(context)
    if (stale.artifacts.some((a) => a.status !== "CURRENT"))
      throw new Error("Production is not CURRENT; revise and audit first")
    const report = auditProduction({ context, narrative, visual })
    if (
      !selfCheck.production ||
      contentSignature(contentChecks(report)) !==
        contentSignature(
          contentChecks(selfCheck.production as import("./types.js").SelfCheckProductionReport),
        )
    )
      throw new Error("Stored audit differs from independent audit")
    report.diagnostics.push(
      ...selfCheck.production.diagnostics.filter((d) => d.kind === "scope-violation"),
    )
    return {
      context,
      narrative,
      visual,
      report,
      signature: contentSignature({ context, narrative, visual, selfCheck }),
    }
  }
  async list() {
    return (await this.read()).issues
  }
  async inspect(id: string) {
    const issue = (await this.read()).issues.find((i) => i.id === id)
    if (!issue) throw new Error("Issue not found")
    try {
      const current = await this.current()
      return {
        issue,
        freshness: current.signature === issue.snapshotSignature ? "CURRENT" : "STALE",
        reason: null,
      }
    } catch (error) {
      return {
        issue,
        freshness: "UNVERIFIABLE",
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }
  async sync() {
    const current = await this.current()
    const body = await this.read()
    for (const diagnostic of current.report.diagnostics) {
      const id = `ISS_${contentSignature({ snapshot: current.signature, diagnostic })}`
      if (!body.issues.some((i) => i.id === id))
        body.issues.push({
          id,
          snapshotSignature: current.signature,
          diagnostic,
          references: references(diagnostic, current.context, current.narrative, current.visual),
          status: "OPEN",
          operations: [],
          verificationSignature: null,
        })
    }
    await this.save(body)
    return body.issues
  }
  private proposal(issue: ProductionIssue, operation: ProductionIssue["operations"][number]) {
    return {
      stage: operation.id,
      artifactSignature: contentSignature({
        issueId: issue.id,
        diagnostic: issue.diagnostic,
        references: issue.references,
        operation,
      }),
      dependencySignature: dependencySignature({
        snapshot: issue.snapshotSignature,
        plan: operation.plan,
      }),
    }
  }
  async decide(
    id: string,
    action: IssueAction,
    note: string,
    approvals: ApprovalGate,
    generate?: RevisionGenerator,
  ) {
    if (!ISSUE_ACTIONS.includes(action) || !note.trim())
      throw new Error("Explicit action and rationale required")
    const body = await this.read()
    const issue = body.issues.find((i) => i.id === id)
    if (!issue) throw new Error("Issue not found")
    const prior = issue.operations.at(-1)
    if (prior?.status === "PENDING") throw new Error("Pending issue action; resume it first")
    if (issue.status !== "OPEN" && issue.status !== "DEFERRED")
      throw new Error("Issue cannot receive another disposition")
    const current = await this.current()
    if (current.signature !== issue.snapshotSignature)
      throw new Error("Issue is stale; sync the current audit")
    if ((action === "research" || action === "reasoning") && !current.context.reasoningCycleId)
      throw new Error("A persisted reasoning cycle is required for handoff")
    if (action === "research" || action === "reasoning") {
      const cycles = await readReasoningCycles(this.memory)
      const { cursor } = await loadReasoningCursor(this.memory)
      const source = cycles.find((c) => c.cycleId === current.context.reasoningCycleId)
      if (!source || source.status !== "COMPLETED" || (cursor && cursor.status !== "STOPPED"))
        throw new Error("Reasoning handoff requires a sealed, stopped cycle")
    }
    const plan =
      action === "fix" ? await new ProductionRevisionEngine(this.memory).plan("narrative") : null
    const operation = {
      id: `IOP_${contentSignature({ issue: id, sequence: issue.operations.length, action, note, plan })}`,
      action,
      note,
      status: "PENDING" as const,
      plan,
      sourceCycleId: current.context.reasoningCycleId,
      referenceDate: current.context.referenceDate,
      decisionId: null,
      revisionId: null,
      revisionOffset: (await new ProductionRevisionEngine(this.memory).history()).length,
    }
    const decision = await approvals.review(
      "issue.decision",
      structuredClone({
        issue,
        operation,
        diagnosticIsEvidence: false,
      }),
    )
    if (
      !decision.approved ||
      decision.authority !== "human" ||
      decision.replacement !== undefined ||
      decision.regenerate
    )
      throw new Error("Unmodified explicit human approval required")
    // A reviewer or another writer may have changed the dependencies during review.
    if ((await this.current()).signature !== current.signature)
      throw new Error("Production changed during issue review")
    await new ApprovalLedger(this.memory).record({
      ...this.proposal(issue, operation),
      decidedAt: new Date().toISOString(),
      authority: "human",
      modified: false,
    })
    issue.operations.push(operation)
    await this.save(body) // durable authorization precedes every external effect
    return this.resume(id, approvals, generate)
  }
  async resume(id: string, approvals: ApprovalGate, generate?: RevisionGenerator) {
    const body = await this.read()
    const issue = body.issues.find((i) => i.id === id)
    if (!issue) throw new Error("Issue not found")
    const operation = issue.operations.at(-1)
    if (!operation || operation.status !== "PENDING") return issue
    if (!(await new ApprovalLedger(this.memory).isApproved(this.proposal(issue, operation))))
      throw new Error("Pending issue operation has no matching human approval")
    if (operation.action === "fix") {
      if (!generate) throw new Error("Revision generator required")
      const engine = new ProductionRevisionEngine(this.memory)
      const plan = operation.plan
      if (!plan) throw new Error("Fix operation has no revision plan")
      const history = await engine.history()
      const existing = history.slice(operation.revisionOffset).find((r) => r.plan.id === plan.id)
      let revision
      if (existing?.status === "COMPLETED") revision = existing
      else if (existing?.status === "DRAFT" || existing?.status === "PUBLISHING")
        revision = await engine.resume(generate, approvals)
      else if (existing) {
        operation.status = "CANCELLED"
        operation.revisionId = existing.id
        issue.status = "OPEN"
        await this.save(body)
        return issue
      } else {
        if ((await this.current()).signature !== issue.snapshotSignature)
          throw new Error("Issue is stale; pending action cannot execute")
        revision = await engine.apply(plan, generate, approvals)
      }
      operation.revisionId = revision.id
      issue.status = "AWAITING_VERIFICATION"
    } else {
      if (operation.action === "research" || operation.action === "reasoning") {
        const decisionId = `ISSUE_DEC_${operation.id}`
        const proposedAction = {
          origin: "production-issue",
          issueId: id,
          operationId: operation.id,
          snapshotSignature: issue.snapshotSignature,
          diagnostic: issue.diagnostic,
          diagnosticIsEvidence: false,
        }
        const record = {
          decisionId,
          kind:
            operation.action === "research"
              ? ("RESEARCH" as const)
              : ("REQUEST_HUMAN_INPUT" as const),
          subject: id,
          proposedAction,
          response: "approved" as const,
          responseDetail: operation.note,
          cycleId: operation.sourceCycleId!,
          stepId: operation.id,
          createdAt: operation.referenceDate,
        }
        const records = await readDecisions(this.memory)
        const existing = records.find((d) => d.decisionId === decisionId)
        if (existing && contentSignature(existing) !== contentSignature(record))
          throw new Error("Conflicting issue decision")
        if (!existing) {
          const current = await this.current()
          if (current.signature !== issue.snapshotSignature)
            throw new Error("Issue is stale; pending action cannot execute")
          const { cursor } = await loadReasoningCursor(this.memory)
          if (cursor && cursor.status !== "STOPPED")
            throw new Error("Reasoning is active; request cannot execute")
          await appendDecision(
            new ScopedMemory(this.memory, new Set(["decisions"])),
            records,
            record,
          )
        }
        operation.decisionId = decisionId
        issue.status = "AWAITING_VERIFICATION"
      } else {
        if ((await this.current()).signature !== issue.snapshotSignature)
          throw new Error("Issue is stale; pending action cannot execute")
        issue.status = operation.action === "defer" ? "DEFERRED" : "DISMISSED"
      }
    }
    operation.status = "COMPLETED"
    await this.save(body)
    return issue
  }
  async verify(id: string) {
    const body = await this.read()
    const issue = body.issues.find((i) => i.id === id)
    if (!issue) throw new Error("Issue not found")
    if (issue.status === "RESOLVED") return issue
    if (issue.status !== "AWAITING_VERIFICATION" || issue.operations.at(-1)?.status !== "COMPLETED")
      throw new Error("Complete an explicit fix or reasoning handoff first")
    const current = await this.current()
    const check = current.report.checks.find((c) => c.id === CHECK[issue.diagnostic.kind])
    if (
      current.signature === issue.snapshotSignature ||
      current.report.diagnostics.some((d) => family(d) === family(issue.diagnostic)) ||
      !check ||
      check.status !== "PASS"
    )
      throw new Error("Issue is not demonstrably resolved by the current audit")
    issue.status = "RESOLVED"
    issue.verificationSignature = current.signature
    await this.save(body)
    return issue
  }
}
