import { describe, it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { runDocumentaryPipeline } from "../src/core/documentary.js"
import { AutoApprover } from "../src/core/pipeline.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import type { LLMProvider } from "../src/providers/llm/llm.js"
import { buildReasoningContext } from "../src/agents/production/reasoning-context.js"
import { buildIntelligenceEnvelope } from "../src/agents/reasoning/intelligence-envelope.js"
import { ResearchIntelligenceEngine } from "../src/agents/research/research-intelligence.js"
import { guardNarrative } from "../src/core/production/guards.js"
import { auditProduction } from "../src/core/production/self-check-rules.js"
import { detectProductionStaleness } from "../src/core/production/staleness.js"
import { makeResearchBundle } from "./fixtures.js"
import type { Narrative, ResearchBundle } from "../src/core/schemas.js"
import type { ReasoningContext } from "../src/core/production/types.js"

const REFERENCE = "2024-06-01T00:00:00.000Z"
const BUDGET = {
  maxSteps: 100,
  maxSources: 40,
  maxQueries: 40,
  maxFollowUpRounds: 5,
  maxIterations: 100,
}

async function contextFor(
  research: ResearchBundle,
  over: {
    hypotheses?: Parameters<typeof buildReasoningContext>[0]["hypotheses"]
  } = {},
): Promise<ReasoningContext> {
  const dir = await mkdtemp(join(tmpdir(), "repro-ctx-"))
  try {
    const memory = new JsonMemoryStore(dir)
    await memory.save("research", research)
    return await buildReasoningContext({
      project: "repro",
      question: research.question,
      research,
      hypotheses: over.hypotheses ?? [],
      verifications: [],
      referenceDate: REFERENCE,
      memory,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function narrativeWith(sentences: Narrative["sections"][number]["sentences"]): Narrative {
  return {
    title: "t",
    logline: "l",
    thesis: "th",
    sections: [{ id: "S1", heading: "h", sentences }],
  }
}

/** Deterministic provider: every stage falls back to its own offline path. */
function scriptedProvider(): LLMProvider {
  return new MockLLMProvider((request) => {
    const stage = request.meta?.stage ?? ""
    if (stage === "narrative") {
      return {
        text: JSON.stringify({
          title: "Purr",
          logline: "l",
          thesis: "th",
          sections: [
            {
              id: "SEC_001",
              heading: "Opening",
              sentences: [
                {
                  id: "SNT_001",
                  text: "Admixture is documented.",
                  knowledge: "FACT",
                  claimIds: ["CLM_001"],
                },
              ],
            },
          ],
        }),
      }
    }
    if (stage === "visual") {
      return {
        text: JSON.stringify({
          shots: [
            {
              id: "SHOT_001",
              duration: 6,
              narration: "Admixture is documented.",
              visualType: "AI_RECONSTRUCTION",
              description: "Two figures.",
              narrativeSentenceIds: ["SNT_001"],
            },
          ],
        }),
      }
    }
    return null
  })
}

/**
 * Regression suite for the v0.7 architecture review.
 *
 * Each case reproduces one review finding (B1, H1, H3–H6, M1, M2) end to end
 * through the real pipeline or the real production engines, then asserts the
 * behaviour that the finding demanded. These are deliberately black-box: they
 * exercise the same code paths the CLI does, so a regression re-opens the
 * finding rather than merely breaking a unit.
 */
describe("v0.7 architecture regressions", () => {
  it("B1: production-only resume replaces the v0.6 intelligence envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repro-b1-"))
    try {
      const store = new JsonMemoryStore(dir)
      const research = makeResearchBundle()
      // Seed a complete epistemic state so the production half can run offline.
      await store.save("research", research)
      await store.save("claims", { claims: research.claims })
      await store.save("hypotheses", { hypotheses: [] })
      await store.save("factCheck", { assessments: [] })
      const opts = {
        provider: scriptedProvider(),
        memoryDir: dir,
        project: "b1",
        question: research.question,
        title: "Purr",
        approvals: new AutoApprover(),
        referenceDate: REFERENCE,
      }
      const report = new ResearchIntelligenceEngine({
        research,
        verifications: [],
        referenceDate: REFERENCE,
      }).run()
      await store.save(
        "intelligence",
        buildIntelligenceEnvelope(
          { research, versions: [], referenceDate: REFERENCE, budget: BUDGET },
          report,
        ),
      )
      expect((await store.get<{ report?: unknown }>("intelligence"))!.report).toBeDefined()

      await runDocumentaryPipeline({ ...opts, forceStage: "reasoningContext" })
      const after = await store.get<{ report?: unknown }>("intelligence")
      console.log("B1 envelopeAfterProductionResume:", after?.report !== undefined)
      expect(after?.report).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("H1: stale intelligence envelope keeps a claim usable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repro-h1-"))
    try {
      const store = new JsonMemoryStore(dir)
      const withEvidence = makeResearchBundle()
      // Cache an envelope computed from the evidence-BEARING research.
      const fresh = new ResearchIntelligenceEngine({
        research: withEvidence,
        verifications: [],
        referenceDate: REFERENCE,
      }).run()
      await store.save(
        "intelligence",
        buildIntelligenceEnvelope(
          { research: withEvidence, versions: [], referenceDate: REFERENCE, budget: BUDGET },
          fresh,
        ),
      )
      // Current research has lost its evidence.
      const noEvidence = { ...withEvidence, evidence: [] } as ResearchBundle
      const ctx = await buildReasoningContext({
        project: "h1",
        question: noEvidence.question,
        research: noEvidence,
        hypotheses: [],
        verifications: [],
        referenceDate: REFERENCE,
        memory: store,
      })
      const claim = ctx.claims.find((c) => c.claimId === "CLM_001")
      console.log("H1 usable:", claim?.usable, "uncertainties:", ctx.uncertainties.length)
      expect(claim?.usable, "stale envelope must not keep an evidence-less claim usable").toBe(
        false,
      )
      expect(ctx.uncertainties.length, "lost evidence must surface as uncertainty").toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("H4: SPECULATION claim is inflated to SCIENTIFIC_HYPOTHESIS", async () => {
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      claims: [
        {
          claimId: "CLM_900",
          knowledge: "SPECULATION",
          status: "PARTIAL",
          confidence: 0.5,
          usable: false,
          requiresQualification: true,
          contradictionIds: [],
          gapIds: [],
          uncertaintyIds: [],
        },
      ],
    }
    const narrative = narrativeWith([
      { id: "SNT_900", text: "Cats may talk to owners.", knowledge: "FACT", claimIds: ["CLM_900"] },
    ])
    const guarded = guardNarrative(narrative, context)
    const audit = auditProduction({ context, narrative: guarded.artifact, visual: { shots: [] } })
    console.log(
      "H4 label:",
      guarded.artifact.sections[0]!.sentences[0]!.knowledge,
      "verdict:",
      audit.verdict,
    )
    expect(
      guarded.artifact.sections[0]!.sentences[0]!.knowledge,
      "SPECULATION must not inflate",
    ).toBe("SPECULATION")
    expect(audit.verdict, "an inflated label must not audit as PASS").not.toBe("PASS")
  })

  it("H5: a long rationale defeats verbatim hypothesis detection", async () => {
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      activeHypotheses: [
        {
          hypothesisId: "HYP_001",
          versionId: "HV_001",
          statement: "Neanderthal admixture is documented.",
          verificationRationale:
            "Independent controlled longitudinal studies remain unavailable and existing observations cannot establish causality or exclude selection bias.",
          status: "ACTIVE",
          confidence: 0.3,
          verificationStatus: "INCONCLUSIVE",
          supportingClaimIds: ["CLM_001"],
          contradictingClaimIds: [],
          researchGapIds: [],
          isAlternative: false,
        },
      ],
    }
    const narrative = narrativeWith([
      {
        id: "SNT_1",
        text: "Neanderthal admixture is documented.",
        knowledge: "FACT",
        claimIds: ["CLM_001"],
      },
    ])
    const guarded = guardNarrative(narrative, context)

    // The audit must be able to see the inflation ON ITS OWN, on the raw
    // artifact — not merely inherit the guard's correction. The H5 finding was
    // precisely that guard and audit shared one blind detector, so auditing the
    // already-guarded output would prove nothing.
    const rawAudit = auditProduction({ context, narrative, visual: { shots: [] } })
    const audit = auditProduction({
      context,
      narrative: guarded.artifact,
      visual: { shots: [] },
    })
    console.log(
      "H5 label:",
      guarded.artifact.sections[0]!.sentences[0]!.knowledge,
      "rawAudit:",
      rawAudit.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")?.status,
      "guardedAudit:",
      audit.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")?.status,
      "verdict:",
      rawAudit.verdict,
    )
    expect(
      guarded.artifact.sections[0]!.sentences[0]!.knowledge,
      "a verbatim restatement of an INCONCLUSIVE hypothesis must not stay FACT",
    ).toBe("SCIENTIFIC_HYPOTHESIS")
    expect(
      rawAudit.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")?.status,
      "the audit must independently detect hypothesis inflation",
    ).toBe("FAIL")
    expect(rawAudit.verdict, "an inflated hypothesis must not yield an overall PASS").not.toBe(
      "PASS",
    )
    expect(
      audit.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")?.status,
      "once the guard has weakened the label there is nothing left to fail",
    ).not.toBe("FAIL")
  })

  it("H5: a near-miss hypothesis resemblance is UNKNOWN, never a clean PASS", async () => {
    // The band just below the assertion threshold. A lexical detector cannot
    // prove the ABSENCE of semantic inflation here, so this must NOT be reported
    // as PASS — but it is equally not a demonstrated violation, so it must not be
    // a FAIL either. `assertedHypotheses` computed this band from the start; the
    // audit used to discard it and fall through to a clean PASS.
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      activeHypotheses: [
        {
          hypothesisId: "HYP_001",
          versionId: "HV_001",
          statement: "Neanderthal admixture contributed to immune gene variation in modern humans",
          verificationRationale: "Inconclusive.",
          status: "ACTIVE",
          confidence: 0.3,
          verificationStatus: "INCONCLUSIVE",
          supportingClaimIds: ["CLM_001"],
          contradictingClaimIds: [],
          researchGapIds: [],
          isAlternative: false,
        },
      ],
    }
    const nearMiss = narrativeWith([
      {
        id: "SNT_1",
        text: "Neanderthal admixture shaped immune gene patterns",
        knowledge: "FACT",
        claimIds: ["CLM_001"],
      },
    ])

    const report = auditProduction({
      context,
      narrative: nearMiss,
      visual: { shots: [] },
    })
    const check = report.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")

    expect(check?.status, "the ambiguous band must surface as UNKNOWN").toBe("UNKNOWN")
    expect(
      check?.unknownReason,
      "the band is a relevant constraint the audit could not settle, not a vacuous one",
    ).toBe("unverifiable")
    expect(
      report.verdict,
      "an unverifiable band must not be certified as an overall PASS",
    ).not.toBe("PASS")
    expect(
      report.diagnostics.some((d) => d.kind === "hypothesis-inflation-ambiguous"),
      "the band must be routed as a diagnostic for review",
    ).toBe(true)
  })

  it("H5: the ambiguous band withholds PASS even when every other check passes", async () => {
    // The aggregation defect this closes: `verdictOf` gated UNKNOWN on a static
    // id allowlist containing only TRACEABILITY, so a blocking H5 UNKNOWN was
    // aggregated into a clean overall PASS. Isolated here so the failure can
    // only be about aggregation — every other check is clean and recorded.
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      activeHypotheses: [
        {
          hypothesisId: "HYP_001",
          versionId: "HV_001",
          statement: "Neanderthal admixture contributed to immune gene variation in modern humans",
          verificationRationale: "Inconclusive.",
          status: "ACTIVE",
          confidence: 0.3,
          verificationStatus: "INCONCLUSIVE",
          supportingClaimIds: ["CLM_001"],
          contradictingClaimIds: [],
          researchGapIds: [],
          isAlternative: false,
        },
      ],
    }
    const report = auditProduction({
      context,
      narrative: narrativeWith([
        {
          id: "SNT_1",
          text: "Neanderthal admixture shaped immune gene patterns",
          knowledge: "FACT",
          claimIds: ["CLM_001"],
        },
      ]),
      visual: { shots: [] },
      // Recorded, in-scope writes: SCOPE_COMPLIANCE is therefore a real PASS and
      // cannot be what is holding the verdict back.
      writes: [
        { artifact: "reasoningContext", keys: ["reasoningContext"] },
        { artifact: "narrative", keys: ["narrative"] },
        { artifact: "visual", keys: ["visual"] },
        { artifact: "selfCheck", keys: ["selfCheck", "production"] },
      ],
    })

    const byId = (id: string) => report.checks.find((c) => c.id === id)
    expect(
      byId("SCOPE_COMPLIANCE")?.status,
      "scope compliance must be a clean PASS in this scenario",
    ).toBe("PASS")
    expect(byId("HYPOTHESIS_INTEGRITY")?.status, "the individual check must be UNKNOWN").toBe(
      "UNKNOWN",
    )
    expect(
      report.checks
        .filter((c) => c.id !== "HYPOTHESIS_INTEGRITY")
        .every(
          (c) =>
            c.status === "PASS" || (c.status === "UNKNOWN" && c.unknownReason === "not-applicable"),
        ),
      JSON.stringify(report.checks),
    ).toBe(true)
    expect(report.verdict, "the blocking UNKNOWN must propagate to the overall verdict").toBe(
      "UNKNOWN",
    )
    const failed = auditProduction({
      context,
      narrative: narrativeWith([
        {
          id: "SNT_1",
          text: "Neanderthal admixture shaped immune gene patterns",
          knowledge: "FACT",
          claimIds: ["CLM_001"],
        },
      ]),
      visual: { shots: [] },
      writes: [{ artifact: "narrative", keys: ["research"] }],
    })
    expect(failed.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")?.status).toBe("UNKNOWN")
    expect(failed.checks.find((c) => c.id === "SCOPE_COMPLIANCE")?.status).toBe("FAIL")
    expect(failed.verdict).toBe("FAIL")
  })

  it("H5: a sentence well below the band still passes cleanly", async () => {
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      activeHypotheses: [
        {
          hypothesisId: "HYP_001",
          versionId: "HV_001",
          statement: "Neanderthal admixture contributed to immune gene variation in modern humans",
          verificationRationale: "Inconclusive.",
          status: "ACTIVE",
          confidence: 0.3,
          verificationStatus: "INCONCLUSIVE",
          supportingClaimIds: ["CLM_001"],
          contradictingClaimIds: [],
          researchGapIds: [],
          isAlternative: false,
        },
      ],
    }
    const unrelated = narrativeWith([
      {
        id: "SNT_1",
        text: "Neanderthal DNA appears in modern genomes today",
        knowledge: "FACT",
        claimIds: ["CLM_001"],
      },
    ])

    const report = auditProduction({
      context,
      narrative: unrelated,
      visual: { shots: [] },
    })

    expect(
      report.checks.find((c) => c.id === "HYPOTHESIS_INTEGRITY")?.status,
      "an unrelated sentence must not be dragged into the band",
    ).toBe("PASS")
  })

  it("H6: an unresolved critical violation still yields PASS", async () => {
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      decision: { ...base.decision, stoppingKind: "STOP_INCONCLUSIVE" as const },
      constraints: [
        ...base.constraints,
        {
          id: "NO_DEFINITIVE_CONCLUSION#global",
          kind: "NO_DEFINITIVE_CONCLUSION" as const,
          severity: "critical" as const,
          rule: "No definitive conclusion.",
          subjectIds: [],
          source: "reasoning" as const,
        },
      ],
    }
    const narrative = narrativeWith([
      {
        id: "SNT_1",
        text: "In conclusion, this proves the answer definitively.",
        knowledge: "SCIENTIFIC_HYPOTHESIS",
        claimIds: ["CLM_001"],
      },
    ])
    const guarded = guardNarrative(narrative, context)
    const audit = auditProduction({ context, narrative: guarded.artifact, visual: { shots: [] } })
    const violation = guarded.provenance.violations.find(
      (v) => v.kind === "NO_DEFINITIVE_CONCLUSION",
    )
    console.log(
      "H6 violations:",
      guarded.provenance.violations.map((v) => v.kind),
      "verdict:",
      audit.verdict,
    )
    expect(violation, "the guard must record the definitive conclusion").toBeDefined()
    expect(violation!.severity, "it is a critical constraint").toBe("critical")
    expect(violation!.resolved, "no text was rewritten, so it is unresolved").toBe(false)
    expect(audit.verdict, "an unresolved critical violation must not yield PASS").not.toBe("PASS")
  })

  it("H3: dependency drift and identity-only change are reported stale", async () => {
    const sig = "a".repeat(64)
    const marker = (deps: Array<{ artifact: string; contentSignature: string }>) => ({
      version: 1 as const,
      contextVersion: 1,
      inputSignature: sig,
      contextSignature: "b".repeat(64),
      reasoningCycleId: "CYC_001",
      project: "p",
      question: "q",
      satisfiedConstraints: [],
      violations: [],
      normalizations: [],
      dependencies: deps,
    })
    // visual was built against a narrative whose content signature has moved on.
    const stale = detectProductionStaleness({
      currentInputSignature: sig,
      currentContextSignature: "b".repeat(64),
      dependencies: { reasoningContext: "b".repeat(64), narrative: "d".repeat(64) },
      artifacts: {
        narrative: marker([{ artifact: "reasoningContext", contentSignature: "b".repeat(64) }]),
        visual: marker([
          { artifact: "reasoningContext", contentSignature: "b".repeat(64) },
          { artifact: "narrative", contentSignature: "c".repeat(64) },
        ]),
        selfCheck: marker([
          { artifact: "reasoningContext", contentSignature: "b".repeat(64) },
          { artifact: "narrative", contentSignature: "c".repeat(64) },
        ]),
      },
    })
    const byName = Object.fromEntries(stale.artifacts.map((a) => [a.artifact, a.status]))
    console.log("H3 statuses:", JSON.stringify(byName))
    expect(byName.narrative).toBe("CURRENT")
    expect(byName.visual, "visual depends on a changed narrative").toBe("STALE")
    expect(byName.selfCheck, "selfCheck depends on a changed narrative").toBe("STALE")
  })

  it("M2: a FACT sentence with a known claim but no evidence chain passes", async () => {
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      traceRefs: { ...base.traceRefs, evidenceIds: [], sourceIds: [] },
    }
    const narrative = narrativeWith([
      { id: "SNT_1", text: "Admixture is documented.", knowledge: "FACT", claimIds: ["CLM_001"] },
    ])
    const audit = auditProduction({ context, narrative, visual: { shots: [] } })
    const check = audit.checks.find((c) => c.id === "TRACEABILITY")!
    console.log("M2 traceability:", check.status, "verdict:", audit.verdict)
    expect(
      check.status,
      "a FACT sentence on a claim with no evidence→source chain is not traceable",
    ).toBe("FAIL")
  })

  it("M1: one unrelated hedged sentence satisfies all uncertainties", async () => {
    const base = await contextFor(makeResearchBundle())
    const context: ReasoningContext = {
      ...base,
      uncertainties: [
        {
          uncertaintyId: "UNC_001",
          kind: "INSUFFICIENT_EVIDENCE" as const,
          subjectType: "claim" as const,
          subjectId: "CLM_001",
          detail: "d",
        },
      ],
    }
    const narrative = narrativeWith([
      {
        id: "SNT_1",
        text: "A beautiful opening image.",
        knowledge: "INTERPRETATION",
        claimIds: [],
      },
    ])
    const audit = auditProduction({ context, narrative, visual: { shots: [] } })
    const check = audit.checks.find((c) => c.id === "UNCERTAINTY_PRESERVATION")!
    console.log("M1 uncertaintyCheck:", check.status, "verdict:", audit.verdict)
    expect(
      check.status,
      "an unrelated hedged sentence must not satisfy a claim's uncertainty",
    ).not.toBe("PASS")
  })
})
