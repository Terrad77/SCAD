import { describe, it, expect } from "vitest"
import { auditProduction } from "../src/core/production/self-check-rules.js"
import { guardNarrative } from "../src/core/production/guards.js"
import type { ProductionAuditInput } from "../src/core/production/self-check-rules.js"
import type { Narrative, VisualOutput } from "../src/core/schemas.js"
import type {
  ContextClaimTraceEdge,
  ContextClaimView,
  ReasoningContext,
} from "../src/core/production/types.js"

/**
 * v0.7 (M2) — the NEGATIVE traceability path.
 *
 * The positive fixtures elsewhere prove that a well-formed chain passes. That is
 * the easy half, and it is also the half that hides the defect: a checker built
 * on the same well-formed fixture cannot tell "verified" from "never looked at".
 * Everything here is therefore constructed from scratch — no shared `context()`
 * helper, no backed-edge fixture — precisely so these cases cannot inherit
 * correctness from the positive path.
 *
 * The property under test is NOT "an unsupported claim is caught". A claim's
 * epistemic status is a separate judgement, and a perfectly `FACT`/`SUPPORTED`
 * claim with a broken chain is exactly the case that must still fail:
 *
 *   1. chain empty / provenance unavailable  → UNKNOWN (unproven, not verified)
 *   2. chain names evidence the context lacks → FAIL   (demonstrated break)
 *   3. chain names a source the context lacks → FAIL   (demonstrated break)
 *   4. chain of real ids that does not support the claim → FAIL
 *   5. claim present, no edge, other edges present → FAIL
 */

const CLAIM_ID = "CLM_001"

const claim = (over: Partial<ContextClaimView> = {}): ContextClaimView => ({
  claimId: CLAIM_ID,
  // The epistemic status is deliberately healthy in every case below. A broken
  // provenance chain must be caught on its own account, not by borrowing a
  // claim status that happens to look bad.
  status: "SUPPORTED",
  knowledge: "FACT",
  confidence: 0.8,
  usable: true,
  requiresQualification: false,
  contradictionIds: [],
  gapIds: [],
  uncertaintyIds: [],
  ...over,
})

const edge = (over: Partial<ContextClaimTraceEdge> = {}): ContextClaimTraceEdge => ({
  claimId: CLAIM_ID,
  evidenceIds: ["EV_001"],
  sourceIds: ["SRC_001"],
  supported: true,
  ...over,
})

interface ContextOptions {
  claims?: ContextClaimView[]
  edges?: ContextClaimTraceEdge[]
  evidenceIds?: string[]
  sourceIds?: string[]
}

/**
 * A context carrying no `production` provenance, so the audit is judging the
 * chain on its own and cannot borrow a verdict from guard output.
 */
const contextWith = (options: ContextOptions = {}): ReasoningContext => {
  const evidenceIds = options.evidenceIds ?? ["EV_001"]
  const sourceIds = options.sourceIds ?? ["SRC_001"]
  return {
    version: 1,
    project: "traceability-negative",
    question: "How much Neanderthal DNA is in modern humans?",
    referenceDate: "2024-01-01T00:00:00.000Z",
    inputSignature: "input",
    contextSignature: "context",
    reasoningCycleId: null,
    constraints: [],
    epistemicSummary: {
      claimCount: 1,
      usableClaimCount: 1,
      qualifiedClaimCount: 0,
      unsupportedClaimCount: 0,
      hypothesisCount: 0,
      activeHypothesisCount: 0,
      contradictionCount: 0,
      openGapCount: 0,
      uncertaintyCount: 0,
      meanClaimConfidence: 0.8,
      completenessStatus: "COMPLETE",
      continueResearch: false,
    },
    claims: options.claims ?? [claim()],
    activeHypotheses: [],
    uncertainties: [],
    decision: {
      cycleId: null,
      sessionId: null,
      stepId: null,
      trigger: null,
      actionKind: "NONE",
      actionTarget: null,
      status: "NONE",
      stoppingKind: null,
      stoppingReason: null,
      humanInTheLoop: false,
      cycleCompleted: false,
    },
    traceRefs: {
      reasoningCycleId: null,
      reasoningSessionId: null,
      reasoningStepId: null,
      epistemicSignature: "epistemic",
      stateSignature: "state",
      intelligenceInputSignature: null,
      intelligenceFreshness: "recomputed",
      intelligenceBudget: null,
      claimIds: [CLAIM_ID],
      hypothesisVersionIds: [],
      contradictionIds: [],
      gapIds: [],
      uncertaintyIds: [],
      evidenceIds,
      sourceIds,
      claimTraceEdges: options.edges ?? [],
    },
  }
}

/** One FACT sentence citing the claim(s) — the subject of every case below. */
const narrativeCiting = (claimIds: string[] = [CLAIM_ID]): Narrative => ({
  title: "Neanderthal DNA",
  logline: "A documentary about admixture.",
  thesis: "Admixture is measurable.",
  sections: [
    {
      id: "SEC_001",
      heading: "Evidence",
      sentences: [
        {
          id: "SENT_001",
          text: "Modern human genomes carry Neanderthal DNA.",
          knowledge: "FACT",
          claimIds,
        },
      ],
    },
  ],
})

const noShots: VisualOutput = { shots: [] }

describe("independent audit boundaries", () => {
  it("detects a non-FACT label that still overstates SPECULATION", () => {
    const context = contextWith({ claims: [claim({ knowledge: "SPECULATION", usable: false })] })
    const draft = narrativeCiting()
    draft.sections[0]!.sentences[0]!.knowledge = "SCIENTIFIC_HYPOTHESIS"
    const report = auditProduction({ context, narrative: draft, visual: noShots })
    expect(report.checks.find((c) => c.id === "EPISTEMIC_INTEGRITY")?.status).toBe("FAIL")
    expect(guardNarrative(draft, context).artifact.sections[0]?.sentences[0]?.knowledge).toBe(
      "SPECULATION",
    )
  })

  it("keeps an unsupported FICTION claim at FICTION", () => {
    const context = contextWith({
      claims: [claim({ knowledge: "FICTION", status: "UNSUPPORTED", usable: false })],
    })
    expect(
      guardNarrative(narrativeCiting(), context).artifact.sections[0]?.sentences[0]?.knowledge,
    ).toBe("FICTION")
  })

  it("does not lose dangling claim references when the narrative is hedged", () => {
    const draft = narrativeCiting(["CLM_MISSING"])
    draft.sections[0]!.sentences[0]!.knowledge = "INTERPRETATION"
    const report = auditProduction({ context: contextWith(), narrative: draft, visual: noShots })
    expect(report.checks.find((c) => c.id === "TRACEABILITY")?.status).toBe("FAIL")
  })

  it("does not cover one evidence uncertainty by hedging a different claim", () => {
    const context = contextWith({
      claims: [claim(), claim({ claimId: "CLM_002" })],
      edges: [edge(), edge({ claimId: "CLM_002", evidenceIds: ["EV_002"] })],
      evidenceIds: ["EV_001", "EV_002"],
    })
    context.uncertainties = [
      {
        uncertaintyId: "UNC_001",
        kind: "LOW_QUALITY_EVIDENCE",
        subjectType: "evidence",
        subjectId: "EV_002",
        detail: "Evidence quality is uncertain.",
      },
    ]
    const draft = narrativeCiting()
    draft.sections[0]!.sentences[0]!.knowledge = "INTERPRETATION"
    const check = (value: Narrative) =>
      auditProduction({ context, narrative: value, visual: noShots }).checks.find(
        (c) => c.id === "UNCERTAINTY_PRESERVATION",
      )?.status
    expect(check(draft)).toBe("FAIL")
    draft.sections[0]!.sentences[0]!.claimIds = ["CLM_002"]
    expect(check(draft)).toBe("PASS")
  })

  it("reports global uncertainty coverage as unverifiable, not satisfied by unrelated prose", () => {
    const context = contextWith()
    context.uncertainties = [
      {
        uncertaintyId: "UNC_001",
        kind: "UNKNOWN",
        subjectType: "research",
        subjectId: "research",
        detail: "Research is incomplete.",
      },
    ]
    const draft = narrativeCiting([])
    draft.sections[0]!.sentences[0]!.knowledge = "INTERPRETATION"
    draft.sections[0]!.sentences[0]!.text = "A beautiful opening image."
    const report = auditProduction({
      context,
      narrative: draft,
      visual: noShots,
      writes: [{ artifact: "narrative", keys: ["narrative"] }],
    })
    expect(report.checks.find((c) => c.id === "UNCERTAINTY_PRESERVATION")).toMatchObject({
      status: "UNKNOWN",
      unknownReason: "unverifiable",
    })
    expect(report.verdict).toBe("UNKNOWN")
  })

  it("does not treat both contradiction references as proof of unresolved prose", () => {
    const context = contextWith({ claims: [claim(), claim({ claimId: "CLM_002" })] })
    context.constraints = [
      {
        id: "CTR_001",
        kind: "DO_NOT_RESOLVE_CONTRADICTION",
        severity: "critical",
        subjectIds: ["CTR_001", "CLM_001", "CLM_002"],
        source: "epistemic",
        rule: "Present both sides.",
      },
    ]
    const draft = narrativeCiting(["CLM_001", "CLM_002"])
    draft.sections[0]!.sentences[0]!.knowledge = "INTERPRETATION"
    const report = auditProduction({
      context,
      narrative: draft,
      visual: noShots,
      writes: [{ artifact: "narrative", keys: ["narrative"] }],
    })
    expect(report.checks.find((c) => c.id === "CONTRADICTION_PRESERVATION")).toMatchObject({
      status: "UNKNOWN",
      unknownReason: "unverifiable",
    })
    expect(report.verdict).toBe("UNKNOWN")
  })

  it("detects a verbatim hypothesis even if the sentence omits its supporting claim", () => {
    const context = contextWith({ edges: [edge()] })
    context.activeHypotheses = [
      {
        hypothesisId: "HYP_001",
        versionId: "HV_001",
        statement: "Isolation will create a new species.",
        verificationRationale: null,
        status: "ACTIVE",
        confidence: 0.3,
        verificationStatus: "INCONCLUSIVE",
        supportingClaimIds: ["CLM_002"],
        contradictingClaimIds: [],
        researchGapIds: [],
        isAlternative: false,
      },
    ]
    const draft = narrativeCiting()
    draft.sections[0]!.sentences[0]!.text = "Isolation will create a new species."
    const report = auditProduction({ context, narrative: draft, visual: noShots })
    expect(report.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")?.status).toBe("FAIL")
  })
})

const audit = (
  context: ReasoningContext,
  claimIds: string[] = [CLAIM_ID],
): ReturnType<typeof auditProduction> =>
  auditProduction({ context, narrative: narrativeCiting(claimIds), visual: noShots })

const traceCheck = (context: ReasoningContext, claimIds: string[] = [CLAIM_ID]) => {
  const report = audit(context, claimIds)
  const check = report.checks.find((c) => c.id === "TRACEABILITY")
  if (check === undefined) throw new Error("audit produced no TRACEABILITY check")
  return { check, report }
}

describe("M2 — provenance unavailable is UNKNOWN, never PASS", () => {
  it("reports UNKNOWN when the context carries no chain data at all", () => {
    // A v0.6-shaped context: FACT sentence, healthy claim, but no edges exist.
    const { check, report } = traceCheck(contextWith({ edges: [] }))

    expect(check.status).toBe("UNKNOWN")
    expect(check.status).not.toBe("PASS")
    expect(report.verdict).not.toBe("PASS")
  })

  it("says plainly that the chain is unproven rather than verified", () => {
    const { check } = traceCheck(contextWith({ edges: [] }))
    expect(check.detail).toMatch(/unproven|unverified|cannot be established/i)
  })

  it("still reports PASS when no FACT statement is made at all", () => {
    // No FACT sentence means there is no chain to verify — genuinely nothing to
    // assert, so PASS is honest here and must not be flattened into UNKNOWN.
    const context = contextWith({ edges: [] })
    const report = auditProduction({
      context,
      narrative: {
        title: "Interpretation",
        logline: "A documentary.",
        thesis: "A reading.",
        sections: [
          {
            id: "SEC_001",
            heading: "Reading",
            sentences: [
              {
                id: "SENT_001",
                text: "A beautiful opening image.",
                knowledge: "INTERPRETATION",
                claimIds: [],
              },
            ],
          },
        ],
      },
      visual: noShots,
    } satisfies ProductionAuditInput)

    const check = report.checks.find((c) => c.id === "TRACEABILITY")
    expect(check?.status).toBe("PASS")
  })
})

describe("M2 — demonstrated broken references are FAIL", () => {
  it("fails when the chain names evidence the context does not carry", () => {
    const { check, report } = traceCheck(
      contextWith({
        // The edge points at EV_404; the context only knows EV_001.
        edges: [edge({ evidenceIds: ["EV_404"] })],
        evidenceIds: ["EV_001"],
      }),
    )

    expect(check.status).toBe("FAIL")
    expect(check.detail).toMatch(/EV_404/)
    expect(report.verdict).toBe("FAIL")
  })

  it("fails when the chain names a source the context does not carry", () => {
    const { check, report } = traceCheck(
      contextWith({
        edges: [edge({ sourceIds: ["SRC_404"] })],
        sourceIds: ["SRC_001"],
      }),
    )

    expect(check.status).toBe("FAIL")
    expect(check.detail).toMatch(/SRC_404/)
    expect(report.verdict).toBe("FAIL")
  })

  it("fails when the chain is marked supported but records no evidence at all", () => {
    const { check } = traceCheck(contextWith({ edges: [edge({ evidenceIds: [] })] }))
    expect(check.status).toBe("FAIL")
    expect(check.detail).toMatch(/no evidence/i)
  })

  it("fails when the chain is marked supported but records no source", () => {
    const { check } = traceCheck(contextWith({ edges: [edge({ sourceIds: [] })] }))
    expect(check.status).toBe("FAIL")
    expect(check.detail).toMatch(/no source/i)
  })

  it("fails when the chain exists but is recorded as not supporting the claim", () => {
    const { check } = traceCheck(
      contextWith({
        // Existing, resolvable ids — but the edge itself says the relationship
        // does not hold. Counting ids would have passed this.
        edges: [edge({ supported: false })],
      }),
    )
    expect(check.status).toBe("FAIL")
    expect(check.detail).toMatch(/unsupported/i)
  })

  it("fails when the cited claim has no edge while other claims do", () => {
    const { check } = traceCheck(
      contextWith({
        claims: [claim(), claim({ claimId: "CLM_002" })],
        // Chain data exists, so its absence for CLM_001 is a real gap rather
        // than a context that simply predates edges.
        edges: [edge({ claimId: "CLM_002" })],
        evidenceIds: ["EV_001", "EV_002"],
      }),
    )
    expect(check.status).toBe("FAIL")
    expect(check.detail).toMatch(/CLM_001/)
  })

  it("fails on a partially broken chain, naming only the broken claim", () => {
    const { check } = traceCheck(
      contextWith({
        claims: [claim(), claim({ claimId: "CLM_002" })],
        edges: [
          edge(), // healthy
          edge({ claimId: "CLM_002", evidenceIds: ["EV_999"] }), // dangling
        ],
        evidenceIds: ["EV_001", "EV_002"],
      }),
      [CLAIM_ID, "CLM_002"],
    )
    expect(check.status).toBe("FAIL")
    expect(check.detail).toMatch(/CLM_002/)
    expect(check.detail).not.toMatch(/CLM_001/)
  })
})

describe("M2 — the healthy chain is the control, not the proof", () => {
  it("passes only when every cited claim resolves to real evidence and a source", () => {
    // Included so the negative cases cannot be satisfied by simply always
    // failing: the same builder, with a complete chain, must still PASS.
    const { check, report } = traceCheck(
      contextWith({
        edges: [edge()],
        evidenceIds: ["EV_001"],
        sourceIds: ["SRC_001"],
      }),
    )
    expect(check.status).toBe("PASS")
    expect(report.verdict).not.toBe("FAIL")
  })

  it("does not borrow a verdict from a claim's epistemic status", () => {
    // A well-supported claim with a broken chain and an UNSUPPORTED claim with a
    // good chain must produce the same traceability outcome: the check judges
    // provenance only, in both directions.
    const brokenForHealthy = traceCheck(
      contextWith({ claims: [claim()], edges: [edge({ sourceIds: ["SRC_404"] })] }),
    )
    const goodForUnsupported = traceCheck(
      contextWith({
        claims: [claim({ status: "UNSUPPORTED" })],
        edges: [edge()],
      }),
    )

    expect(brokenForHealthy.check.status).toBe("FAIL")
    expect(goodForUnsupported.check.status).toBe("PASS")
  })
})
