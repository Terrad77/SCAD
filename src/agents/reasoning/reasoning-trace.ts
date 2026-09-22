import type {
  HypothesisVersion,
  ReasoningAction,
  ReasoningState,
} from "../../core/reasoning/types.js"

/** A step-level projection of a reasoning execution, safe for logging or export. */
export interface ReasoningStepTrace {
  id: string
  actionKind: string
  target: string
  status: string
  stateChange: "SAME" | "CHANGED"
  writes: string[]
  notes: string[]
  producedVersionId?: string
  rejectedVersionId?: string
}

export interface ReasoningTrace {
  project: string
  cycleId: string
  referenceDate: string
  status: string
  stoppedBy: { stoppingKind: string; reason: string } | null
  stepCount: number
  changedSteps: number
  blockedSteps: number
  steps: ReasoningStepTrace[]
  hypotheses: HypothesisVersion[]
}

function actionTarget(action: ReasoningAction): string {
  switch (action.kind) {
    case "RESEARCH":
      return `${action.target.subject}|${action.target.id}`
    case "GENERATE_HYPOTHESIS":
      return action.targetHypothesis ?? "FIRST"
    case "REVISE_HYPOTHESIS":
    case "REJECT_HYPOTHESIS":
      return action.targetHypothesis
    case "REQUEST_HUMAN_INPUT":
      return action.target
    case "STOP":
      return action.stoppingKind
  }
}

export function buildReasoningTrace(
  state: ReasoningState,
  versions: HypothesisVersion[],
): ReasoningTrace {
  const steps: ReasoningStepTrace[] = state.steps.map((step) => {
    const producedVersionId =
      step.action.kind === "GENERATE_HYPOTHESIS" || step.action.kind === "REVISE_HYPOTHESIS"
        ? latestOfTarget(versions, step.action.targetHypothesis)?.versionId
        : undefined
    const rejectedVersionId =
      step.action.kind === "REJECT_HYPOTHESIS"
        ? latestOfTarget(versions, step.action.targetHypothesis)?.versionId
        : undefined
    return {
      id: step.id,
      actionKind: step.action.kind,
      target: actionTarget(step.action),
      status: step.status,
      stateChange: step.stateSignatureBefore === step.stateSignatureAfter ? "SAME" : "CHANGED",
      writes: step.writes,
      notes: step.notes,
      producedVersionId,
      rejectedVersionId,
    }
  })

  return {
    project: state.project,
    cycleId: state.cycleContext?.cycleId ?? "none",
    referenceDate: state.cycleContext?.referenceDate ?? "unknown",
    status: state.status,
    stoppedBy: state.lastStopping
      ? { stoppingKind: state.lastStopping.stoppingKind, reason: state.lastStopping.reason }
      : null,
    stepCount: steps.length,
    changedSteps: steps.filter((s) => s.stateChange === "CHANGED").length,
    blockedSteps: steps.filter((s) => s.status === "BLOCKED").length,
    steps,
    hypotheses: versions,
  }
}

export function renderReasoningTrace(state: ReasoningState, versions: HypothesisVersion[]): string {
  const trace = buildReasoningTrace(state, versions)
  const lines: string[] = [
    `Reasoning trace — ${trace.project} (cycle ${trace.cycleId}, ${trace.referenceDate})`,
    `Status: ${trace.status}${trace.stoppedBy ? ` — stopped ${trace.stoppedBy.stoppingKind}: ${trace.stoppedBy.reason}` : ""}`,
    `${trace.stepCount} steps, ${trace.changedSteps} changed state, ${trace.blockedSteps} blocked`,
  ]
  for (const step of trace.steps) {
    const change =
      step.status === "BLOCKED" ? "blocked" : step.stateChange === "CHANGED" ? "changed" : "no-op"
    const tail = step.producedVersionId
      ? ` → ${step.producedVersionId}`
      : step.rejectedVersionId
        ? ` → reject ${step.rejectedVersionId}`
        : ""
    lines.push(`  [${step.id}] ${step.actionKind} ${step.target} — ${change}${tail}`)
    for (const note of step.notes) lines.push(`      note: ${note}`)
  }
  for (const version of versions) {
    lines.push(
      `  v ${version.versionId} (${version.hypothesisId}#${version.version}) ${version.status} — ${version.statement.slice(0, 72)}${version.reason ? ` | ${version.reason}` : ""}`,
    )
  }
  return lines.join("\n")
}

function latestOfTarget(
  versions: HypothesisVersion[],
  target: string | null,
): HypothesisVersion | undefined {
  if (!target) return undefined
  return versions.filter((v) => v.hypothesisId === target).sort((a, b) => b.version - a.version)[0]
}
