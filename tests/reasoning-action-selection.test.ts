import { describe, it, expect } from "vitest"
import { planReasoning, repeatKeyOf } from "../src/agents/reasoning/action-selection.js"
import { assessSituation, researchKeyOf } from "../src/agents/reasoning/situation-assessment.js"
import type {
  ContradictionSignal,
  GapSignal,
  LowQualitySignal,
  ReasoningSituation,
  ReasoningStep,
} from "../src/core/reasoning/types.js"
import type { HypothesisVerification, ResearchIntelligenceReport } from "../src/core/schemas.js"
import { importHypotheses, buildVersion } from "../src/core/reasoning/hypothesis-version.js"
import { alternativeReasonFor } from "../src/agents/reasoning/hypothesis-lifecycle.js"
import { makeClaim, makeHypothesis, makeResearchBundle } from "./fixtures.js"

const REFERENCE_DATE = "2024-01-01T00:00:00.000Z"

function makeVerification(over: Partial<HypothesisVerification> = {}): HypothesisVerification {
  return {
    hypothesisId: "HYP_001",
    status: "UNTESTED",
    confidence: 0.5,
    supportingEvidence: [],
    contradictingEvidence: [],
    researchGaps: [],
    rationale: "baseline",
    ...over,
  }
}

function makeSituation(over: Partial<ReasoningSituation> = {}): ReasoningSituation {
  return {
    question: "Can humanity become a new species?",
    researchCompleted: true,
    verifications: [],
    alternativeCounts: new Map(),
    isAlternative: new Set(),
    activeCount: 1,
    attemptedKeys: new Set(),
    researchAttemptedThisCycle: new Set(),
    cycleContext: {
      cycleId: "CYC_001",
      referenceDate: REFERENCE_DATE,
      budget: { maxSteps: 100, maxSources: 40, maxQueries: 40, maxFollowUpRounds: 5 },
      stateSignature: "SIG_BASE",
    },
    limitsExhausted: false,
    continueResearch: true,
    humanInTheLoop: false,
    stoppingReasons: [],
    openContradictions: [],
    gaps: [],
    lowQualityEvidence: [],
    ...over,
  }
}

function makeSignal(over: Partial<ContradictionSignal> = {}): ContradictionSignal {
  return {
    id: "CTR_001",
    claimA: "CLM_A",
    claimB: "CLM_B",
    analysis: "different sources disagree on timescale",
    gapId: null,
    subquestionId: "SUB_Q_001",
    evidenceId: "EV_001",
    query: "independent evidence on timescale",
    ...over,
  }
}

function makeGap(over: Partial<GapSignal> = {}): GapSignal {
  return { id: "GAP_001", importance: 0.9, query: "targeted query", ...over }
}

function makeLowQuality(over: Partial<LowQualitySignal> = {}): LowQualitySignal {
  return { id: "EV_001", overall: 0.4, query: "better evidence", ...over }
}

function makeStep(over: Partial<ReasoningStep> = {}): ReasoningStep {
  return {
    id: "STEP_001",
    cycleContext: { cycleId: "CYC_001", referenceDate: REFERENCE_DATE },
    action: { kind: "RESEARCH", target: { subject: "gap", id: "GAP_001", query: "q" } },
    status: "COMPLETED",
    stateSignatureBefore: "SIG_BASE",
    stateSignatureAfter: "SIG_AFTER",
    performedAt: REFERENCE_DATE,
    writes: ["research"],
    notes: [],
    ...over,
  }
}

describe("v0.5 action selection (planReasoning)", () => {
  it("A — takes the open HIGH contradiction first, preferring the related gap target", () => {
    const situation = makeSituation({ openContradictions: [makeSignal({ gapId: "GAP_001" })] })
    const plan = planReasoning(situation)
    expect(plan.terminating).toBe(false)
    expect(plan.action).toEqual({
      kind: "RESEARCH",
      target: { subject: "gap", id: "GAP_001", query: "independent evidence on timescale" },
    })
  })

  it("A — falls back to the sub-question target when no gap is linked", () => {
    const situation = makeSituation({ openContradictions: [makeSignal()] })
    const plan = planReasoning(situation)
    expect(plan.action).toMatchObject({ kind: "RESEARCH" })
    if (plan.action.kind === "RESEARCH") {
      expect(plan.action.target.subject).toBe("subquestion")
      expect(plan.action.target.id).toBe("SUB_Q_001")
    }
  })

  it("B — critical gaps outrank generate candidates (tier 2 before tier 3)", () => {
    const situation = makeSituation({
      gaps: [makeGap()],
      activeCount: 0,
      verifications: [],
    })
    const plan = planReasoning(situation)
    expect(plan.candidate?.tier).toBe(2)
    expect(plan.action.kind).toBe("RESEARCH")
  })

  it("C — generates the first hypothesis when research exists but no hypotheses do", () => {
    const situation = makeSituation({ activeCount: 0, gaps: [], openContradictions: [] })
    const plan = planReasoning(situation)
    expect(plan.action).toEqual({ kind: "GENERATE_HYPOTHESIS", targetHypothesis: null, basis: [] })
  })

  it("C — generates an alternative for an untested hypothesis with no alternatives yet", () => {
    const situation = makeSituation({
      activeCount: 1,
      verifications: [makeVerification({ hypothesisId: "HYP_001", status: "UNTESTED" })],
    })
    const plan = planReasoning(situation)
    expect(plan.candidate?.tier).toBe(3)
    expect(plan.action).toEqual({
      kind: "GENERATE_HYPOTHESIS",
      targetHypothesis: "HYP_001",
      basis: [],
    })
  })

  it("C — does not nest alternatives: a hypothesis already treated as an alternative is skipped", () => {
    const situation = makeSituation({
      verifications: [makeVerification({ hypothesisId: "HYP_002", status: "UNTESTED" })],
      isAlternative: new Set(["HYP_002"]),
      activeCount: 2,
    })
    const plan = planReasoning(situation)
    expect(plan.action.kind).not.toBe("GENERATE_HYPOTHESIS")
  })

  it("D — revises a partially supported hypothesis", () => {
    const situation = makeSituation({
      verifications: [makeVerification({ hypothesisId: "HYP_001", status: "PARTIALLY_SUPPORTED" })],
    })
    const plan = planReasoning(situation)
    expect(plan.candidate?.tier).toBe(4)
    expect(plan.action).toEqual({ kind: "REVISE_HYPOTHESIS", targetHypothesis: "HYP_001" })
  })

  it("D — revises a contradicted-but-supported hypothesis rather than rejecting it", () => {
    const situation = makeSituation({
      verifications: [
        makeVerification({
          hypothesisId: "HYP_001",
          status: "CONTRADICTED",
          supportingEvidence: ["EV_001"],
        }),
      ],
    })
    const plan = planReasoning(situation)
    expect(plan.action).toEqual({ kind: "REVISE_HYPOTHESIS", targetHypothesis: "HYP_001" })
  })

  it("E — non-critical gaps sit at tier 5", () => {
    const situation = makeSituation({
      gaps: [makeGap({ importance: 0.5 })],
      verifications: [makeVerification({ status: "SUPPORTED" })],
    })
    const plan = planReasoning(situation)
    expect(plan.candidate?.tier).toBe(5)
    expect(plan.action).toMatchObject({ kind: "RESEARCH" })
    if (plan.action.kind === "RESEARCH") {
      expect(plan.action.target.subject).toBe("gap")
      expect(plan.action.target.id).toBe("GAP_001")
    }
  })

  it("E — low-quality evidence researches the evidence item directly", () => {
    const situation = makeSituation({ lowQualityEvidence: [makeLowQuality()] })
    const plan = planReasoning(situation)
    if (plan.action.kind === "RESEARCH") {
      expect(plan.action.target.subject).toBe("evidence")
      expect(plan.action.target.id).toBe("EV_001")
    } else {
      throw new Error(`expected RESEARCH, got ${plan.action.kind}`)
    }
  })

  it("F — rejects a contradicted hypothesis with zero supporting evidence (tier 7 last)", () => {
    const situation = makeSituation({
      verifications: [makeVerification({ hypothesisId: "HYP_001", status: "CONTRADICTED" })],
      continueResearch: false,
    })
    const plan = planReasoning(situation)
    expect(plan.candidate?.tier).toBe(7)
    expect(plan.action).toEqual({ kind: "REJECT_HYPOTHESIS", targetHypothesis: "HYP_001" })
  })

  it("G — requests human adjudication only after the contradiction was researched this cycle", () => {
    const contradiction = makeSignal({ gapId: "GAP_001" })
    const researchKey = researchKeyOf("gap", "GAP_001")
    const situation = makeSituation({
      openContradictions: [contradiction],
      humanInTheLoop: true,
      attemptedKeys: new Set([researchKey]),
      researchAttemptedThisCycle: new Set([researchKey]),
    })
    const plan = planReasoning(situation)
    expect(plan.terminating).toBe(false)
    expect(plan.action.kind).toBe("REQUEST_HUMAN_INPUT")
    if (plan.action.kind === "REQUEST_HUMAN_INPUT") {
      expect(plan.action.target).toBe("CTR_001")
      expect(plan.action.question).toContain("CLM_A")
    }
  })

  it("G — without a researched contradiction there is nothing to ask about: no-op stop", () => {
    const situation = makeSituation({
      openContradictions: [makeSignal({ gapId: "GAP_001" })],
      humanInTheLoop: true,
      attemptedKeys: new Set([researchKeyOf("gap", "GAP_001")]),
      researchAttemptedThisCycle: new Set(),
    })
    const plan = planReasoning(situation)
    expect(plan.terminating).toBe(true)
    if (plan.action.kind === "STOP") {
      expect(plan.action.stoppingKind).toBe("STOP_NO_ACTION")
    }
  })

  it("H — loop guard: a candidate already attempted at the same signature is not repeated", () => {
    const situation = makeSituation({
      gaps: [makeGap()],
      attemptedKeys: new Set(["RESEARCH|gap|GAP_001"]),
      continueResearch: true,
    })
    const plan = planReasoning(situation)
    expect(plan.terminating).toBe(true)
    if (plan.action.kind === "STOP") {
      expect(plan.action.stoppingKind).toBe("STOP_NO_ACTION")
    }
  })

  it("H — an attempt at a different signature does not trip the loop guard", () => {
    const steps = [makeStep({ stateSignatureBefore: "OTHER_SIG" })]
    const research = makeResearchBundle({ gaps: [{ ...makeResearchGapFixture() }] })
    const situation = makeSituation({
      gaps: [makeGap()],
      attemptedKeys: assessAttempted(steps, "SIG_BASE"),
    })
    expect(situation.attemptedKeys.has("RESEARCH|gap|GAP_001")).toBe(false)
    expect(research.gaps).toHaveLength(1)
    const plan = planReasoning(situation)
    expect(plan.terminating).toBe(false)
    expect(plan.action.kind).toBe("RESEARCH")
  })

  it("I — limitsExhausted always stops with STOP_RESEARCH_LIMIT, whatever else is open", () => {
    const situation = makeSituation({
      limitsExhausted: true,
      stoppingReasons: ["max sources reached"],
      openContradictions: [makeSignal({ gapId: "GAP_001" })],
    })
    const plan = planReasoning(situation)
    expect(plan.terminating).toBe(true)
    if (plan.action.kind === "STOP") {
      expect(plan.action.stoppingKind).toBe("STOP_RESEARCH_LIMIT")
      expect(plan.action.reason).toBe("max sources reached")
    }
  })

  it("J — research finished and no open problems → STOP_CONFIDENT_ENOUGH", () => {
    const situation = makeSituation({ continueResearch: false })
    const plan = planReasoning(situation)
    if (plan.action.kind === "STOP") {
      expect(plan.action.stoppingKind).toBe("STOP_CONFIDENT_ENOUGH")
    }
  })

  it("J — research still wanted but every candidate needs a human → STOP_HUMAN_REQUIRED", () => {
    const researchKey = researchKeyOf("gap", "GAP_001")
    const situation = makeSituation({
      openContradictions: [makeSignal({ gapId: "GAP_001" })],
      humanInTheLoop: true,
      continueResearch: true,
      attemptedKeys: new Set([researchKey, "REQUEST_HUMAN_INPUT|CTR_001|"]),
      researchAttemptedThisCycle: new Set([researchKey]),
    })
    const plan = planReasoning(situation)
    if (plan.action.kind === "STOP") {
      expect(plan.action.stoppingKind).toBe("STOP_HUMAN_REQUIRED")
    }
  })

  it("J — no applicable candidate at all → STOP_INCONCLUSIVE", () => {
    const situation = makeSituation({
      activeCount: 0,
      researchCompleted: false,
      continueResearch: true,
    })
    const plan = planReasoning(situation)
    if (plan.action.kind === "STOP") {
      expect(plan.action.stoppingKind).toBe("STOP_INCONCLUSIVE")
    }
  })

  it("candidate order is stable: same situation → same plan (deterministic)", () => {
    const situation = makeSituation({
      gaps: [makeGap({ id: "GAP_002", importance: 0.9 }), makeGap()],
      lowQualityEvidence: [makeLowQuality()],
    })
    const a = planReasoning(situation)
    const b = planReasoning(situation)
    expect(JSON.stringify(a.action)).toBe(JSON.stringify(b.action))
    expect(a.candidate?.repeatKey).toBe(b.candidate?.repeatKey)
  })

  it("repeat keys are collision-free across kinds", () => {
    const researchKey = repeatKeyOf({
      kind: "RESEARCH",
      target: { subject: "gap", id: "GAP_001", query: "q" },
    })
    expect(researchKey).toBe("RESEARCH|gap|GAP_001")
    expect(repeatKeyOf({ kind: "GENERATE_HYPOTHESIS", targetHypothesis: null, basis: [] })).toBe(
      "GENERATE_HYPOTHESIS||",
    )
    expect(repeatKeyOf({ kind: "REVISE_HYPOTHESIS", targetHypothesis: "HYP_001" })).toBe(
      "REVISE_HYPOTHESIS|HYP_001|",
    )
    expect(repeatKeyOf({ kind: "STOP", stoppingKind: "STOP_INCONCLUSIVE", reason: "r" })).toBe(
      "STOP|STOP_INCONCLUSIVE",
    )
  })
})

describe("v0.5 situation assessment (assessSituation)", () => {
  function buildVersions() {
    const alternative = buildVersion(
      {
        ...makeHypothesis({
          id: "HYP_002",
          statement: "A competing explanation: cultural, not genetic, divergence.",
          supportingClaims: [],
          contradictingClaims: ["CLM_001"],
        }),
        supportingEvidence: [],
        contradictingEvidence: [],
        researchGaps: [],
      },
      1,
      "STEP_003",
      alternativeReasonFor("HYP_001"),
      { parentVersionId: "HYP_001_V1", hypothesisId: "HYP_002" },
    )
    return [importHypotheses([makeHypothesis()], "STEP_000")[0]!, alternative]
  }

  it("derives alternative counts and the isAlternative set from the version log", () => {
    const versions = buildVersions()
    const situation = assessSituation({
      question: "Can humanity become a new species?",
      research: makeResearchBundle(),
      intelligence: makeIntelligenceFixture(),
      versions,
      cycleSteps: [],
      stateSignatureBefore: "SIG_BASE",
      cycleContext: makeSituation().cycleContext,
    })
    expect(situation.activeCount).toBe(2)
    expect(situation.alternativeCounts.get("HYP_001")).toBe(1)
    expect(situation.alternativeCounts.get("HYP_002")).toBe(0)
    expect(situation.isAlternative.has("HYP_002")).toBe(true)
    expect(situation.isAlternative.has("HYP_001")).toBe(false)
    expect(situation.researchCompleted).toBe(true)
    expect(situation.verifications).toHaveLength(2)
  })

  it("collects research keys from the whole cycle but attempts only from the current signature", () => {
    const versions = importHypotheses([makeHypothesis()], "STEP_000")
    const research = makeResearchBundle({
      gaps: [makeResearchGapFixture()],
    })
    const steps = [
      makeStep({ stateSignatureBefore: "OTHER_SIG" }),
      makeStep({
        id: "STEP_002",
        action: {
          kind: "RESEARCH",
          target: { subject: "subquestion", id: "SUB_Q_001", query: "q" },
        },
        stateSignatureBefore: "SIG_BASE",
      }),
    ]
    const situation = assessSituation({
      question: research.question,
      research,
      intelligence: makeIntelligenceFixture(),
      versions,
      cycleSteps: steps,
      stateSignatureBefore: "SIG_BASE",
      cycleContext: makeSituation().cycleContext,
    })
    expect(situation.researchAttemptedThisCycle.has(researchKeyOf("gap", "GAP_001"))).toBe(true)
    expect(
      situation.researchAttemptedThisCycle.has(researchKeyOf("subquestion", "SUB_Q_001")),
    ).toBe(true)
    expect(situation.attemptedKeys.has(researchKeyOf("gap", "GAP_001"))).toBe(false)
    expect(situation.attemptedKeys.has(researchKeyOf("subquestion", "SUB_Q_001"))).toBe(true)
  })

  it("surfaces unresolved HIGH contradictions and critical gaps as signals", () => {
    const intelligence = makeIntelligenceFixture()
    intelligence.unresolvedContradictions = [
      {
        id: "CTR_001",
        claimA: "CLM_001",
        claimB: "CLM_002",
        severity: "HIGH",
        classification: "CONTRADICTION",
        explanation: "claims disagree on timescale",
      },
    ]
    const research = makeResearchBundle({
      claims: [
        makeClaim({ id: "CLM_001" }),
        makeClaim({ id: "CLM_002", statement: "Divergence requires longer isolation." }),
      ],
      gaps: [makeResearchGapFixture()],
    })
    const situation = assessSituation({
      question: research.question,
      research,
      intelligence,
      versions: importHypotheses([makeHypothesis()], "STEP_000"),
      cycleSteps: [],
      stateSignatureBefore: "SIG_BASE",
      cycleContext: makeSituation().cycleContext,
    })
    expect(situation.openContradictions).toHaveLength(1)
    expect(situation.openContradictions[0]!.id).toBe("CTR_001")
    expect(situation.gaps).toHaveLength(1)
    expect(situation.limitsExhausted).toBe(false)
  })
})

function makeResearchGapFixture() {
  return {
    id: "GAP_001",
    question: "How long does isolation need to last?",
    importance: 0.9,
    relatedClaims: ["CLM_001"],
    suggestedResearchQueries: ["isolation timescale for speciation"],
    subquestionId: "SUB_Q_001",
  }
}

function assessAttempted(steps: ReasoningStep[], signature: string): Set<string> {
  const assessed = assessSituation({
    question: "Can humanity become a new species?",
    research: makeResearchBundle({ gaps: [makeResearchGapFixture()] }),
    intelligence: makeIntelligenceFixture(),
    versions: importHypotheses([makeHypothesis()], "STEP_000"),
    cycleSteps: steps,
    stateSignatureBefore: signature,
    cycleContext: makeSituation().cycleContext,
  })
  return assessed.attemptedKeys
}

function makeIntelligenceFixture(): ResearchIntelligenceReport {
  return {
    question: "Can humanity become a new species?",
    questionId: "Q_001",
    generatedAt: REFERENCE_DATE,
    completeness: {
      score: 0.8,
      status: "MOSTLY_COMPLETE",
      dimensions: [],
      unresolvedGaps: [],
      unresolvedContradictions: [],
      recommendations: [],
    },
    claims: [],
    evidenceQuality: [
      {
        evidenceId: "EV_001",
        sourceId: "SRC_001",
        dimensions: {
          reliability: 0.7,
          strength: 0.7,
          directness: 0.8,
          specificity: 0.8,
          freshness: 0.5,
        },
        overall: 0.7,
        reasons: ["fixture"],
      },
    ],
    sourceIndependence: {
      relationships: [],
      totalSources: 2,
      independentSources: 2,
      dependentSources: 0,
      unknownSources: 0,
      independenceRatio: 1,
      reasons: ["fixture"],
    },
    contradictions: [],
    hypotheses: [],
    unresolvedGaps: [],
    unresolvedContradictions: [],
    uncertainties: [],
    continueResearch: true,
    stopping: { continueResearch: true, reasons: ["fixture"], limitsRespected: true },
    recommendations: [],
  }
}
