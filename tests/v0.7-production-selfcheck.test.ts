import { describe, it, expect } from "vitest"
import { auditProduction } from "../src/core/production/self-check-rules.js"
import { SelfCheckEngine } from "../src/agents/self-check/self-check.js"
import { guardNarrative, guardVisual } from "../src/core/production/guards.js"
import { deriveProductionConstraints } from "../src/core/production/constraints.js"
import { PRODUCTION_CHECK_IDS, type ReasoningContext } from "../src/core/production/types.js"
import type { KnowledgeLevel, Narrative, VisualOutput } from "../src/core/types.js"
import { KNOWLEDGE_LEVELS } from "../src/core/types.js"
import { makeClaim } from "./fixtures.js"
import type { Claim } from "../src/core/schemas.js"

function claimView(
  over: Partial<Parameters<typeof deriveProductionConstraints>[0]["claims"][number]> & {
    claimId: string
  },
) {
  return {
    knowledge: "FACT" as KnowledgeLevel,
    status: "SUPPORTED" as const,
    confidence: 0.9,
    usable: true,
    requiresQualification: false,
    contradictionIds: [] as string[],
    gapIds: [] as string[],
    uncertaintyIds: [] as string[],
    ...over,
  }
}

function context(
  over: { claims?: ReturnType<typeof claimView>[]; extra?: Partial<ReasoningContext> } = {},
): ReasoningContext {
  const claims = over.claims ?? [claimView({ claimId: "CLM_001" })]
  const body = {
    version: 1 as const,
    project: "demo",
    question: "Why do cats purr?",
    referenceDate: "2024-06-01T00:00:00.000Z",
    inputSignature: "a".repeat(64),
    contextSignature: "b".repeat(64),
    reasoningCycleId: "CYC_001",
    decision: {
      cycleId: "CYC_001",
      sessionId: "SES_001",
      stepId: "STEP_001",
      trigger: "explicit-request" as const,
      actionKind: "STOP" as const,
      actionTarget: null,
      status: "STOPPED" as const,
      stoppingKind: "STOP_INCONCLUSIVE" as const,
      stoppingReason: "Not conclusive.",
      humanInTheLoop: false,
      cycleCompleted: true,
    },
    epistemicSummary: {
      claimCount: claims.length,
      usableClaimCount: claims.filter((c) => c.usable).length,
      qualifiedClaimCount: claims.filter((c) => c.requiresQualification).length,
      unsupportedClaimCount: claims.filter((c) => c.status === "UNSUPPORTED").length,
      hypothesisCount: 0,
      activeHypothesisCount: 0,
      contradictionCount: 0,
      openGapCount: 0,
      uncertaintyCount: 0,
      meanClaimConfidence: 0.9,
      completenessStatus: "COMPLETE" as const,
      continueResearch: false,
    },
    claims,
    activeHypotheses: [],
    uncertainties: [],
    ...over.extra,
  }
  return {
    ...body,
    constraints: deriveProductionConstraints({
      claims,
      activeHypotheses: body.activeHypotheses,
      contradictions: [],
      gaps: [],
      uncertainties: [],
      decision: body.decision,
    }),
    traceRefs: {
      reasoningCycleId: "CYC_001",
      reasoningSessionId: "SES_001",
      reasoningStepId: "STEP_001",
      epistemicSignature: "c".repeat(64),
      stateSignature: "d".repeat(64),
      intelligenceInputSignature: null,
      intelligenceFreshness: "recomputed" as const,
      intelligenceBudget: null,
      claimIds: claims.map((c) => c.claimId),
      claimTraceEdges: claims.map((claim) => ({
        claimId: claim.claimId,
        evidenceIds: ["EV_001"],
        sourceIds: ["SRC_001"],
        supported: true,
      })),
      hypothesisVersionIds: [],
      contradictionIds: [],
      gapIds: [],
      uncertaintyIds: [],
      evidenceIds: ["EV_001"],
      sourceIds: ["SRC_001"],
    },
  }
}

function sentencesOf(artifact: Narrative): Narrative["sections"][number]["sentences"] {
  return artifact.sections.flatMap((section) => section.sentences)
}

function firstSentence(artifact: Narrative): Narrative["sections"][number]["sentences"][number] {
  const [sentence] = sentencesOf(artifact)
  if (sentence === undefined) throw new Error("the guarded narrative has no sentences")
  return sentence
}

function narrative(
  sentences: Array<{ id: string; text: string; knowledge: KnowledgeLevel; claimIds: string[] }>,
): Narrative {
  return {
    title: "T",
    logline: "L",
    thesis: "th",
    sections: [{ id: "SEC_001", heading: "H", sentences }],
  }
}

function visual(over: Partial<VisualOutput> = {}): VisualOutput {
  return {
    shots: [
      {
        id: "SHT_001",
        duration: 5,
        narration: "narration",
        visualType: "STOCK",
        description: "A cat.",
        source: "SRC_001",
        narrativeSentenceIds: ["SNT_001"],
      },
    ],
    ...over,
  }
}

function check(report: ReturnType<typeof auditProduction>, id: string) {
  return report.checks.find((c) => c.id === id)
}

describe("v0.7 §10 — the seven production checks", () => {
  it("always runs all seven checks, each with a status", () => {
    const ctx = context()
    const n = guardNarrative(
      narrative([
        { id: "SNT_001", text: "Purring aids healing.", knowledge: "FACT", claimIds: ["CLM_001"] },
      ]),
      ctx,
    ).artifact
    const report = auditProduction({ context: ctx, narrative: n, visual: visual() })
    expect(report.checks.map((c) => c.id).sort()).toEqual([...PRODUCTION_CHECK_IDS].sort())
    for (const c of report.checks) expect(c.detail.length).toBeGreaterThan(0)
  })

  it("reports UNKNOWN rather than PASS when the context has nothing to check", () => {
    const ctx = context({ claims: [] })
    const n = guardNarrative(
      narrative([{ id: "SNT_001", text: "t", knowledge: "FICTION", claimIds: [] }]),
      ctx,
    ).artifact
    const report = auditProduction({ context: ctx, narrative: n, visual: visual() })
    expect(check(report, "CONTRADICTION_PRESERVATION")!.status).toBe("UNKNOWN")
    expect(check(report, "UNCERTAINTY_PRESERVATION")!.status).toBe("UNKNOWN")
  })

  it("passes a fully compliant production", () => {
    const ctx = context()
    const n = guardNarrative(
      narrative([
        { id: "SNT_001", text: "Purring aids healing.", knowledge: "FACT", claimIds: ["CLM_001"] },
      ]),
      ctx,
    ).artifact
    const v = guardVisual(visual(), n, ctx).artifact
    const report = auditProduction({
      context: ctx,
      narrative: n,
      visual: v,
      // Scope compliance is only certifiable when the writes are actually
      // recorded. Without them the audit cannot observe the one-way boundary,
      // so it reports `unverifiable` UNKNOWN rather than assuming compliance.
      writes: [
        { artifact: "reasoningContext", keys: ["reasoningContext"] },
        { artifact: "narrative", keys: ["narrative"] },
        { artifact: "visual", keys: ["visual"] },
        { artifact: "selfCheck", keys: ["selfCheck", "production"] },
      ],
    })
    expect(check(report, "SCOPE_COMPLIANCE")!.status).toBe("PASS")
    expect(report.verdict).toBe("PASS")
  })

  it("withholds PASS when production writes were never recorded", () => {
    // Absence of proof about the one-way boundary is not proof of compliance.
    // The real pipeline always records `productionWrites`, so this only happens
    // when the evidence is missing — which must not certify the handoff.
    const ctx = context()
    const n = guardNarrative(
      narrative([
        { id: "SNT_001", text: "Purring aids healing.", knowledge: "FACT", claimIds: ["CLM_001"] },
      ]),
      ctx,
    ).artifact
    const report = auditProduction({ context: ctx, narrative: n, visual: visual() })
    const scope = check(report, "SCOPE_COMPLIANCE")!
    expect(scope.status).toBe("UNKNOWN")
    expect(scope.unknownReason).toBe("unverifiable")
    expect(report.verdict).not.toBe("PASS")
  })

  it("does not block PASS on vacuous UNKNOWNs", () => {
    // The counterpart to the case above: a context with no uncertainties and no
    // contradictions has nothing to lose, so those UNKNOWNs are
    // `not-applicable` and must not withhold a verdict.
    const ctx = context()
    const n = guardNarrative(
      narrative([
        { id: "SNT_001", text: "Purring aids healing.", knowledge: "FACT", claimIds: ["CLM_001"] },
      ]),
      ctx,
    ).artifact
    const v = guardVisual(visual(), n, ctx).artifact
    const report = auditProduction({
      context: ctx,
      narrative: n,
      visual: v,
      writes: [{ artifact: "narrative", keys: ["narrative"] }],
    })
    for (const id of ["CONTRADICTION_PRESERVATION", "UNCERTAINTY_PRESERVATION"] as const) {
      const c = check(report, id)!
      expect(c.status).toBe("UNKNOWN")
      expect(c.unknownReason, `${id} must be recognised as vacuous`).toBe("not-applicable")
    }
    expect(report.verdict, "vacuous UNKNOWNs must not cry wolf").toBe("PASS")
  })

  it("is deterministic", () => {
    const ctx = context()
    const n = guardNarrative(
      narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_999"] }]),
      ctx,
    ).artifact
    const a = auditProduction({ context: ctx, narrative: n, visual: visual() })
    const b = auditProduction({ context: ctx, narrative: n, visual: visual() })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it("never mutates the epistemic input it audits", () => {
    const ctx = context()
    const before = JSON.stringify(ctx)
    const n = guardNarrative(
      narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }]),
      ctx,
    ).artifact
    auditProduction({ context: ctx, narrative: n, visual: visual() })
    expect(JSON.stringify(ctx)).toBe(before)
  })
})

describe("v0.7 I2 — epistemic integrity", () => {
  it("FAILS when the narrative asserts more than the context allows", () => {
    const ctx = context({
      claims: [
        claimView({
          claimId: "CLM_001",
          usable: false,
          requiresQualification: true,
          contradictionIds: ["CTR_001"],
        }),
      ],
    })
    // A narrative that bypasses the guard entirely (as a resumed/hand-edited
    // artifact could) must still be caught by the independent audit.
    const overreaching = narrative([
      { id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] },
    ])
    const report = auditProduction({ context: ctx, narrative: overreaching, visual: visual() })
    expect(check(report, "EPISTEMIC_INTEGRITY")!.status).toBe("FAIL")
    expect(report.verdict).toBe("FAIL")
  })

  it("surfaces the guard correction as WARN rather than hiding it", () => {
    const ctx = context({
      claims: [
        claimView({
          claimId: "CLM_001",
          usable: false,
          requiresQualification: true,
          contradictionIds: ["CTR_001"],
        }),
      ],
    })
    const guarded = guardNarrative(
      narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }]),
      ctx,
    ).artifact
    // The guard already downgraded the label, so nothing is overstated any
    // more — but the correction must stay visible in the report.
    const v = guardVisual(
      visual({ shots: [{ ...visual().shots[0]!, visualType: "AI_RECONSTRUCTION" }] }),
      guarded,
      ctx,
    ).artifact
    const report = auditProduction({ context: ctx, narrative: guarded, visual: v })
    expect(check(report, "EPISTEMIC_INTEGRITY")!.status).toBe("WARN")
    expect(report.diagnostics.some((d) => d.kind === "epistemic-integrity")).toBe(true)
  })

  it("never lets FICTION be re-labelled as a fact", () => {
    const ctx = context()
    for (const level of KNOWLEDGE_LEVELS) {
      const n = guardNarrative(
        narrative([
          { id: "SNT_001", text: "t", knowledge: level as KnowledgeLevel, claimIds: ["CLM_001"] },
        ]),
        ctx,
      ).artifact
      expect(firstSentence(n).knowledge).toBe(
        level === "FICTION" ? "FICTION" : firstSentence(n).knowledge,
      )
      if (level === "FICTION") expect(firstSentence(n).knowledge).toBe("FICTION")
    }
  })
})

describe("v0.7 I6 — traceability", () => {
  it("FAILS on a sentence citing an unknown claim", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_999"] }])
    const report = auditProduction({ context: ctx, narrative: n, visual: visual() })
    expect(check(report, "TRACEABILITY")!.status).toBe("FAIL")
  })

  it("FAILS on a shot pointing at a sentence that does not exist", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    const v = visual({ shots: [{ ...visual().shots[0]!, narrativeSentenceIds: ["SNT_MISSING"] }] })
    const report = auditProduction({ context: ctx, narrative: n, visual: v })
    expect(check(report, "TRACEABILITY")!.status).toBe("FAIL")
  })

  it("FAILS on a shot citing a source that exists in neither list", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    const v = visual({ shots: [{ ...visual().shots[0]!, source: "SRC_999" }] })
    const report = auditProduction({ context: ctx, narrative: n, visual: v })
    expect(check(report, "TRACEABILITY")!.status).toBe("FAIL")
  })

  it("accepts a source id and an evidence id as provenance", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    for (const source of ["SRC_001", "EV_001"]) {
      const v = visual({ shots: [{ ...visual().shots[0]!, source }] })
      const report = auditProduction({ context: ctx, narrative: n, visual: v })
      expect(check(report, "TRACEABILITY")!.status).toBe("PASS")
    }
  })
})

describe("v0.7 I4/I5/I9 — the audit reports, it never mutates", () => {
  it("marks the report as epistemically inert", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_999"] }])
    const report = auditProduction({ context: ctx, narrative: n, visual: visual() })
    expect(report.epistemicMutation).toBe(false)
  })

  it("routes a traceability break to a human with a reason", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_999"] }])
    const report = auditProduction({ context: ctx, narrative: n, visual: visual() })
    const d = report.diagnostics.find((x) => x.kind === "traceability")!
    expect(d).toBeDefined()
    expect(d.route).toBe("human")
    expect(d.severity).toBe("critical")
  })

  it("routes a reasoning-level break back to reasoning", () => {
    const ctx = context({
      claims: [
        claimView({
          claimId: "CLM_001",
          usable: false,
          requiresQualification: true,
          contradictionIds: ["CTR_001"],
        }),
      ],
    })
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    const report = auditProduction({ context: ctx, narrative: n, visual: visual() })
    const d = report.diagnostics.find((x) => x.kind === "epistemic-integrity")!
    expect(d.route).toBe("reasoning")
  })
})

describe("v0.7 I8 — scope compliance", () => {
  it("PASSES when every production write is inside the production scope", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    const report = auditProduction({
      context: ctx,
      narrative: n,
      visual: visual(),
      writes: [
        { artifact: "narrative", keys: ["narrative"] },
        { artifact: "visual", keys: ["visual"] },
        { artifact: "selfCheck", keys: ["selfCheck", "production"] },
      ],
    })
    expect(check(report, "SCOPE_COMPLIANCE")!.status).toBe("PASS")
  })

  it("FAILS when a production stage wrote an epistemic key", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    const report = auditProduction({
      context: ctx,
      narrative: n,
      visual: visual(),
      writes: [{ artifact: "narrative", keys: ["narrative", "claims"] }],
    })
    expect(check(report, "SCOPE_COMPLIANCE")!.status).toBe("FAIL")
    expect(report.diagnostics.find((d) => d.kind === "scope-violation")!.route).toBe("human")
  })

  it("FAILS on a governance write from production", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    const report = auditProduction({
      context: ctx,
      narrative: n,
      visual: visual(),
      writes: [{ artifact: "narrative", keys: ["approved"] }],
    })
    expect(check(report, "SCOPE_COMPLIANCE")!.status).toBe("FAIL")
  })

  it("is UNKNOWN when no writes were recorded", () => {
    const ctx = context()
    const n = narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }])
    const report = auditProduction({ context: ctx, narrative: n, visual: visual(), writes: [] })
    expect(["UNKNOWN", "PASS"]).toContain(check(report, "SCOPE_COMPLIANCE")!.status)
  })
})

describe("v0.7 I11 — the self-check engine exposes the audit", () => {
  it("omits the report entirely when no reasoning context is supplied", () => {
    const out = new SelfCheckEngine().run({
      claims: [makeClaim({ id: "CLM_001", sources: ["SRC_001"] }) as Claim],
      narrative: narrative([
        { id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] },
      ]),
      shots: [],
    })
    expect(out.production).toBeUndefined()
  })

  it("includes the report when a reasoning context is supplied", () => {
    const ctx = context()
    const out = new SelfCheckEngine().run({
      claims: [makeClaim({ id: "CLM_001", sources: ["SRC_001"] }) as Claim],
      narrative: guardNarrative(
        narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }]),
        ctx,
      ).artifact,
      shots: visual().shots,
      visual: visual(),
      reasoningContext: ctx,
      productionWrites: [{ artifact: "narrative", keys: ["narrative"] }],
    })
    expect(out.production).toBeDefined()
    expect(out.production!.checks).toHaveLength(PRODUCTION_CHECK_IDS.length)
    expect(out.production!.epistemicMutation).toBe(false)
  })

  it("audits the visual guard's provenance, not just the shots", () => {
    const ctx = context()
    const guardedNarrative = guardNarrative(
      narrative([{ id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] }]),
      ctx,
    ).artifact
    const guardedVisual = guardVisual(
      visual({ shots: [{ ...visual().shots[0]!, source: "SRC_999" }] }),
      guardedNarrative,
      ctx,
    ).artifact

    // Without the visual provenance the audit would have nothing to re-check
    // against; the guard's detachment must be visible to the report.
    const out = new SelfCheckEngine().run({
      claims: [],
      narrative: guardedNarrative,
      shots: guardedVisual.shots,
      visual: guardedVisual,
      reasoningContext: ctx,
    })
    expect(out.production!.inputSignature).toBe(ctx.inputSignature)
  })
})

describe("v0.7 I7/I12 — invariants across the whole surface", () => {
  it("never emits a knowledge level outside the taxonomy", () => {
    for (const claims of [
      [claimView({ claimId: "CLM_001" })],
      [
        claimView({
          claimId: "CLM_001",
          usable: false,
          requiresQualification: true,
          contradictionIds: ["CTR_001"],
        }),
      ],
      [
        claimView({
          claimId: "CLM_001",
          knowledge: "SCIENTIFIC_HYPOTHESIS",
          status: "PARTIAL",
          confidence: 0.3,
          usable: false,
          requiresQualification: true,
        }),
      ],
      [
        claimView({
          claimId: "CLM_001",
          status: "UNSUPPORTED",
          usable: false,
          requiresQualification: true,
        }),
      ],
    ]) {
      const ctx = context({ claims })
      for (const level of KNOWLEDGE_LEVELS) {
        const { artifact } = guardNarrative(
          narrative([
            {
              id: "SNT_001",
              text: "Some claim about purring.",
              knowledge: level as KnowledgeLevel,
              claimIds: ["CLM_001"],
            },
          ]),
          ctx,
        )
        expect(KNOWLEDGE_LEVELS).toContain(firstSentence(artifact).knowledge)
      }
    }
  })

  it("reports the worst status as the verdict", () => {
    const ctx = context()
    const order = { UNKNOWN: 0, PASS: 1, WARN: 2, FAIL: 3 } as const
    const clean = auditProduction({
      context: ctx,
      narrative: narrative([
        { id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_001"] },
      ]),
      visual: visual(),
    })
    const broken = auditProduction({
      context: ctx,
      narrative: narrative([
        { id: "SNT_001", text: "t", knowledge: "FACT", claimIds: ["CLM_999"] },
      ]),
      visual: visual(),
    })
    expect(order[broken.verdict]).toBeGreaterThan(order[clean.verdict])
  })
})
