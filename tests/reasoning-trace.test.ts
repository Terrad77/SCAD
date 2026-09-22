import { describe, it, expect } from "vitest"
import {
  buildReasoningTrace,
  renderReasoningTrace,
} from "../src/agents/reasoning/reasoning-trace.js"
import type { ReasoningState, ReasoningStep } from "../src/core/reasoning/types.js"
import { importHypotheses } from "../src/core/reasoning/hypothesis-version.js"
import { makeHypothesis } from "./fixtures.js"

const REFERENCE_DATE = "2024-01-01T00:00:00.000Z"

function makeStep(over: Partial<ReasoningStep> = {}): ReasoningStep {
  return {
    id: "STEP_001",
    cycleContext: { cycleId: "CYC_001", referenceDate: REFERENCE_DATE },
    action: { kind: "RESEARCH", target: { subject: "gap", id: "GAP_001", query: "q" } },
    status: "COMPLETED",
    stateSignatureBefore: "A",
    stateSignatureAfter: "B",
    performedAt: REFERENCE_DATE,
    writes: ["research"],
    notes: [],
    ...over,
  }
}

function makeState(over: Partial<ReasoningState> = {}): ReasoningState {
  return {
    project: "humanity-2",
    question: "Can humanity become a new species?",
    cycleContext: {
      cycleId: "CYC_001",
      referenceDate: REFERENCE_DATE,
      budget: { maxSteps: 100, maxSources: 40, maxQueries: 40, maxFollowUpRounds: 5 },
      stateSignature: "A",
    },
    steps: [],
    lastStopping: null,
    status: "RUNNING",
    ...over,
  }
}

describe("v0.5 reasoning trace", () => {
  it("projects steps with change detection and target labels", () => {
    const state = makeState({
      steps: [
        makeStep({
          action: {
            kind: "GENERATE_HYPOTHESIS",
            targetHypothesis: "HYP_001",
            basis: [],
          },
        }),
        makeStep({
          id: "STEP_002",
          action: { kind: "RESEARCH", target: { subject: "evidence", id: "EV_001", query: "q" } },
          stateSignatureBefore: "B",
          stateSignatureAfter: "B",
        }),
      ],
    })
    const versions = importHypotheses([makeHypothesis()], "STEP_000")
    const trace = buildReasoningTrace(state, versions)
    expect(trace.cycleId).toBe("CYC_001")
    expect(trace.status).toBe("RUNNING")
    expect(trace.stepCount).toBe(2)
    expect(trace.steps[0]!.actionKind).toBe("GENERATE_HYPOTHESIS")
    expect(trace.steps[0]!.target).toBe("HYP_001")
    expect(trace.steps[0]!.stateChange).toBe("CHANGED")
    expect(trace.steps[1]!.actionKind).toBe("RESEARCH")
    expect(trace.steps[1]!.stateChange).toBe("SAME")
  })

  it("links produced/rejected version ids to hypothesis steps", () => {
    const state = makeState({
      steps: [
        makeStep({
          action: { kind: "REJECT_HYPOTHESIS", targetHypothesis: "HYP_001" },
          stateSignatureBefore: "A",
          stateSignatureAfter: "B",
        }),
      ],
    })
    const versions = [
      importHypotheses([makeHypothesis()], "STEP_000")[0]!,
      {
        ...importHypotheses([makeHypothesis()], "STEP_000")[0]!,
        versionId: "HYP_001_V2",
        version: 2,
        status: "REJECTED",
        reason: "rejected: contradicted",
        supersededByVersionId: undefined,
      },
    ]
    const trace = buildReasoningTrace(state, versions)
    expect(trace.steps[0]!.rejectedVersionId).toBe("HYP_001_V2")
    expect(trace.steps.some((s) => s.producedVersionId !== undefined)).toBe(false)
  })

  it("counts blocked steps and reports the stopping verdict", () => {
    const state = makeState({
      steps: [
        makeStep({ status: "BLOCKED", stateSignatureBefore: "A", stateSignatureAfter: "A" }),
        {
          ...makeStep({
            id: "STEP_002",
            action: {
              kind: "STOP",
              stoppingKind: "STOP_RESEARCH_LIMIT",
              reason: "max sources reached",
            },
            stateSignatureBefore: "A",
            stateSignatureAfter: "A",
            writes: ["reasoning"],
          }),
        },
      ],
      lastStopping: {
        stoppingKind: "STOP_RESEARCH_LIMIT",
        reason: "max sources reached",
        at: REFERENCE_DATE,
      },
      status: "STOPPED",
    })
    const trace = buildReasoningTrace(state, [])
    expect(trace.blockedSteps).toBe(1)
    expect(trace.stoppedBy).toEqual({
      stoppingKind: "STOP_RESEARCH_LIMIT",
      reason: "max sources reached",
    })
    const output = renderReasoningTrace(state, [])
    expect(output).toContain("STOP_RESEARCH_LIMIT")
    expect(output).toContain("1 blocked")
    expect(output).toContain("blocked")
  })

  it("renders a readable timeline with hypothesis versions", () => {
    const versions = importHypotheses([makeHypothesis()], "STEP_000")
    const state = makeState({
      steps: [
        {
          ...makeStep({
            action: {
              kind: "STOP",
              stoppingKind: "STOP_INCONCLUSIVE",
              reason: "no applicable candidate",
            },
            stateSignatureBefore: "A",
            stateSignatureAfter: "A",
            writes: ["reasoning"],
          }),
        },
      ],
      status: "STOPPED",
      lastStopping: {
        stoppingKind: "STOP_INCONCLUSIVE",
        reason: "no applicable candidate",
        at: REFERENCE_DATE,
      },
    })
    const output = renderReasoningTrace(state, versions)
    expect(output).toContain("humanity-2")
    expect(output).toContain("HYP_001#1")
    expect(output).toContain("STEP_001")
  })

  it("handles a state with no cycle context defensively", () => {
    const trace = buildReasoningTrace(makeState({ cycleContext: null }), [])
    expect(trace.cycleId).toBe("none")
    expect(trace.referenceDate).toBe("unknown")
  })
})
