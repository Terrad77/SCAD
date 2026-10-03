import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { ScopedMemory } from "../src/core/memory/scoped-memory.js"
import { runDocumentaryPipeline } from "../src/core/documentary.js"
import { createLLMProvider } from "../src/providers/llm/factory.js"
import { createRevisionGenerator } from "../src/agents/production/revision-generator.js"
import {
  ProductionRevisionEngine,
  type RevisionGenerator,
} from "../src/core/production/revisions.js"
import { protectedKeys } from "../src/core/production/write-scope.js"
import { ReasoningEngine } from "../src/agents/reasoning/reasoning-engine.js"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { NoopSearchProvider } from "../src/providers/search/search-provider.js"
import type { ResearchBundle, Hypothesis } from "../src/core/schemas.js"
import { detectProductionStaleness } from "../src/core/production/staleness.js"
import { beforeEach, describe, expect, it } from "vitest"
import { buildReasoningContext } from "../src/agents/production/reasoning-context.js"
import { auditNarrativeReferences } from "../src/core/production/linkage.js"
import { guardNarrative, guardVisual } from "../src/core/production/guards.js"
import { auditProduction } from "../src/core/production/self-check-rules.js"
import { NarrativeSchema, type Narrative } from "../src/core/schemas.js"
import { NarrativeLinkageReportSchema } from "../src/core/production/linkage-schema.js"
import { artifactContentSignature } from "../src/core/production/signature.js"
import { renderScript } from "../src/core/documentary.js"
import { contextForPrompt } from "../src/agents/narrative/narrative.js"
import type { ReasoningContext } from "../src/core/production/types.js"
import {
  makeClaim,
  makeHypothesis,
  makeNarrative,
  makeResearchBundle,
  makeShot,
} from "./fixtures.js"

let context: ReasoningContext
beforeEach(async () => {
  const research = makeResearchBundle({
    claims: [makeClaim(), makeClaim({ id: "CLM_002" })],
    contradictions: [
      {
        id: "CTR_001",
        claimA: "CLM_001",
        claimB: "CLM_002",
        severity: "HIGH",
        classification: "CONTRADICTION",
        explanation: "Sources disagree",
      },
    ],
  })
  context = await buildReasoningContext({
    project: "links",
    question: research.question,
    research,
    hypotheses: [makeHypothesis()],
    referenceDate: "2024-06-01T00:00:00.000Z",
  })
})
function narrative(
  fields: Partial<Narrative["sections"][number]["sentences"][number]> = {},
): Narrative {
  const result = makeNarrative()
  result.sections[0]!.sentences = [
    {
      id: "SNT_001",
      text: "A different phrasing with no lexical overlap",
      knowledge: "SCIENTIFIC_HYPOTHESIS",
      claimIds: ["CLM_001"],
      ...fields,
    },
  ]
  return result
}

describe("explicit narrative references", () => {
  it("round-trips metadata through the narrative schema", () => {
    const n = narrative({
      hypothesisIds: ["HYP_001"],
      uncertaintyIds: [],
      contradictionIds: ["CTR_001"],
      constraintTreatments: [],
    })
    expect(NarrativeSchema.parse(n)).toEqual(n)
  })
  it("keeps legacy sentences unchanged and does not claim coverage", () => {
    const n = narrative()
    expect(NarrativeSchema.parse(n)).toEqual(n)
    const report = auditNarrativeReferences(n, context)
    expect(report.mode).toBe("legacy")
    expect(report.structuralStatus).toBe("UNKNOWN")
  })
  it("rejects duplicate reference IDs at the input boundary", () => {
    expect(
      NarrativeSchema.safeParse(narrative({ hypothesisIds: ["HYP_001", "HYP_001"] })).success,
    ).toBe(false)
  })
  it("preserves a paraphrased hypothesis identity independently of lexical overlap", () => {
    const report = auditNarrativeReferences(narrative({ hypothesisIds: ["HYP_001"] }), context)
    expect(report.references[0]).toMatchObject({ targetId: "HYP_001", status: "VALID" })
    expect(report.semanticStatus).toBe("UNKNOWN")
  })
  it("fails a dangling hypothesis even with a valid factual claim", () => {
    const report = auditNarrativeReferences(narrative({ hypothesisIds: ["HYP_MISSING"] }), context)
    expect(report.structuralStatus).toBe("FAIL")
    expect(report.references[0]?.status).toBe("INVALID")
  })
  it("downgrades an explicit unverified hypothesis without needing textual similarity", () => {
    const guarded = guardNarrative(
      narrative({ knowledge: "FACT", hypothesisIds: ["HYP_001"] }),
      context,
    )
    expect(guarded.artifact.sections[0]!.sentences[0]!.knowledge).not.toBe("FACT")
    expect(guarded.artifact.sections[0]!.sentences[0]!.hypothesisIds).toEqual(["HYP_001"])
  })
  it("permits explicit hypothesis classification without inventing a claim reference", () => {
    const guarded = guardNarrative(
      narrative({ knowledge: "SCIENTIFIC_HYPOTHESIS", claimIds: [], hypothesisIds: ["HYP_001"] }),
      context,
    )
    expect(guarded.artifact.sections[0]!.sentences[0]!.knowledge).toBe("SCIENTIFIC_HYPOTHESIS")
    expect(guarded.artifact.sections[0]!.sentences[0]!.claimIds).toEqual([])
  })
  it("does not accept an unrelated uncertainty subject", () => {
    const uncertainty = context.uncertainties.find((u) => u.subjectType === "claim")!
    expect(uncertainty).toBeDefined()
    const report = auditNarrativeReferences(
      narrative({ claimIds: ["CLM_UNRELATED"], uncertaintyIds: [uncertainty.uncertaintyId] }),
      context,
    )
    expect(report.structuralStatus).toBe("FAIL")
  })
  it("requires a contradiction side rather than only its ID", () => {
    expect(
      auditNarrativeReferences(narrative({ claimIds: [], contradictionIds: ["CTR_001"] }), context)
        .structuralStatus,
    ).toBe("FAIL")
    expect(
      auditNarrativeReferences(narrative({ contradictionIds: ["CTR_001"] }), context).references[0]
        ?.status,
    ).toBe("VALID")
  })
  it("keeps semantic uncertainty despite a correct constraint treatment", () => {
    const constraint = context.constraints.find((c) => c.kind === "QUALIFY_AS_HYPOTHESIS")!
    const n = narrative({
      hypothesisIds: ["HYP_001"],
      constraintTreatments: [
        {
          constraintId: constraint.id,
          subjectIds: constraint.subjectIds,
          treatment: "qualify-hypothesis",
          explanation: "This sentence qualifies the hypothesis",
        },
      ],
    })
    const report = auditNarrativeReferences(n, context)
    expect(report.constraints.find((c) => c.constraintId === constraint.id)).toMatchObject({
      status: "COVERED",
      semanticStatus: "UNKNOWN",
    })
    expect(NarrativeLinkageReportSchema.parse(report)).toEqual(report)
  })
  it("fails mismatched constraint kinds and subjects", () => {
    const c = context.constraints.find((c) => c.kind === "QUALIFY_AS_HYPOTHESIS")!
    expect(
      auditNarrativeReferences(
        narrative({
          hypothesisIds: ["HYP_001"],
          constraintTreatments: [
            {
              constraintId: c.id,
              subjectIds: ["OTHER"],
              treatment: "acknowledge-uncertainty",
              explanation: "Looks good",
            },
          ],
        }),
        context,
      ).structuralStatus,
    ).toBe("FAIL")
  })
  it("cannot satisfy human governance with sentence metadata", () => {
    const c = context.constraints.find((c) => c.kind === "REQUIRE_HUMAN_APPROVAL")!
    const report = auditNarrativeReferences(
      narrative({
        constraintTreatments: [
          {
            constraintId: c.id,
            subjectIds: [],
            treatment: "avoid-definitive-conclusion",
            explanation: "Approved",
          },
        ],
      }),
      context,
    )
    expect(report.structuralStatus).toBe("FAIL")
    expect(report.constraints.find((r) => r.constraintId === c.id)?.status).toBe("GOVERNANCE")
  })
  it("detects ambiguous sentence ownership", () => {
    const n = narrative({ hypothesisIds: ["HYP_001"] })
    n.sections[0]!.sentences.push({ ...n.sections[0]!.sentences[0]! })
    expect(
      auditNarrativeReferences(n, context).issues.some((i) =>
        i.detail.includes("Duplicate sentence"),
      ),
    ).toBe(true)
  })
  it("reference-only edits change content/dependency signatures", () => {
    expect(artifactContentSignature(narrative())).not.toBe(
      artifactContentSignature(narrative({ hypothesisIds: ["HYP_001"] })),
    )
  })
  it("exports explicit references in the human-readable script and prompt", () => {
    expect(renderScript(narrative({ hypothesisIds: ["HYP_001"] }))).toContain("hypothesis: HYP_001")
    expect(JSON.stringify(contextForPrompt(context))).toContain(
      context.activeHypotheses[0]!.statement,
    )
  })
  it("independently audits broken references after the guard and never mutates context", () => {
    const before = JSON.stringify(context)
    const n = guardNarrative(narrative({ hypothesisIds: ["HYP_MISSING"] }), context).artifact
    const visual = guardVisual({ shots: [makeShot()] }, n, context).artifact
    const report = auditProduction({
      context,
      narrative: n,
      visual,
      writes: [{ artifact: "narrative", keys: ["narrative"] }],
    })
    expect(report.checks.find((c) => c.id === "TRACEABILITY")?.status).toBe("FAIL")
    expect(report.verdict).toBe("FAIL")
    expect(report.narrativeReferences?.structuralStatus).toBe("FAIL")
    expect(JSON.stringify(context)).toBe(before)
  })
  it("valid metadata cannot turn unverified prose into overall PASS", () => {
    const n = guardNarrative(narrative({ hypothesisIds: ["HYP_001"] }), context).artifact
    const visual = guardVisual({ shots: [makeShot()] }, n, context).artifact
    const report = auditProduction({
      context,
      narrative: n,
      visual,
      writes: [{ artifact: "narrative", keys: ["narrative"] }],
    })
    expect(report.verdict).not.toBe("PASS")
    expect(report.narrativeReferences?.semanticStatus).toBe("UNKNOWN")
  })
})

describe("explicit references in governed production revisions", () => {
  it("persists reference metadata and independent reports through crash/resume without protected writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-v09-integration-"))
    const memory = new JsonMemoryStore(dir)
    const provider = createLLMProvider({ provider: "mock" }).provider
    try {
      await runDocumentaryPipeline({
        provider,
        memoryDir: dir,
        project: "links",
        question: "Can humanity become a new species?",
        title: "Demo",
        referenceDate: "2024-06-01T00:00:00.000Z",
      })
      const research = (await memory.get<ResearchBundle>("research"))!
      const hypotheses = (await memory.get<{ hypotheses: Hypothesis[] }>("hypotheses"))!
      await new ReasoningEngine({
        project: "links",
        question: research.question,
        memory,
        research,
        hypotheses: hypotheses.hypotheses,
        agent: new StructuredAgent(provider, readPromptFile),
        search: new NoopSearchProvider(),
        referenceDate: "2024-06-01T00:00:00.000Z",
        budget: { maxSteps: 1 },
      }).run()
      const protectedBefore = Object.fromEntries(
        await Promise.all(
          protectedKeys()
            .filter((k) => k !== "approved")
            .map(async (key) => [key, await memory.readRaw(key)]),
        ),
      )
      const raw = createRevisionGenerator(new ScopedMemory(memory, new Set()), provider)
      const generate: RevisionGenerator = async (stage, draft) => {
        const result = await raw(stage, draft)
        if (stage !== "narrative") return result
        const narrative = result as Narrative
        narrative.sections[0]!.sentences[0]!.hypothesisIds = [
          draft.reasoningContext.activeHypotheses[0]!.hypothesisId,
        ]
        narrative.sections[0]!.sentences[0]!.uncertaintyIds = []
        narrative.sections[0]!.sentences[0]!.contradictionIds = []
        narrative.sections[0]!.sentences[0]!.constraintTreatments = []
        return narrative
      }
      const engine = new ProductionRevisionEngine(memory)
      await expect(
        engine.apply(await engine.plan("narrative"), generate, {
          review: async (stage) => {
            if (stage === "revision.final") throw new Error("final crash")
            return { approved: true, authority: "human" }
          },
        }),
      ).rejects.toThrow("final crash")
      const resumed = await new ProductionRevisionEngine(memory).resume(
        async () => {
          throw new Error("No stage should regenerate")
        },
        { review: async () => ({ approved: true, authority: "human" }) },
      )
      const sentence = resumed.candidate.narrative!.sections[0]!.sentences[0]!
      expect(sentence.hypothesisIds).toHaveLength(1)
      const report = resumed.candidate.selfCheck!.production!.narrativeReferences!
      expect(report.mode).toBe("explicit")
      expect(report.semanticStatus).toBe("UNKNOWN")
      expect(resumed.candidate.selfCheck!.production!.verdict).not.toBe("PASS")
      expect(
        (await memory.get<Narrative>("narrative"))!.sections[0]!.sentences[0]!.hypothesisIds,
      ).toEqual(sentence.hypothesisIds)
      const after = Object.fromEntries(
        await Promise.all(
          protectedKeys()
            .filter((k) => k !== "approved")
            .map(async (key) => [key, await memory.readRaw(key)]),
        ),
      )
      expect(after).toEqual(protectedBefore)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it("a metadata-only edit stales dependent visual and audit artifacts", () => {
    const n = guardNarrative(narrative(), context).artifact
    const visual = guardVisual({ shots: [makeShot()] }, n, context).artifact
    const report = auditProduction({ context, narrative: n, visual })
    const edited = structuredClone(n)
    edited.sections[0]!.sentences[0]!.hypothesisIds = ["HYP_001"]
    const stale = detectProductionStaleness({
      currentInputSignature: context.inputSignature,
      currentContextSignature: context.contextSignature,
      dependencies: {
        reasoningContext: artifactContentSignature(context),
        narrative: artifactContentSignature(edited),
        visual: artifactContentSignature(visual),
      },
      artifacts: { visual: visual.production!, selfCheck: report },
    })
    expect(stale.artifacts.find((a) => a.artifact === "visual")?.status).toBe("STALE")
    expect(stale.artifacts.find((a) => a.artifact === "selfCheck")?.status).toBe("STALE")
  })
})

it("requires both contradiction sides across the treatment's responsible sentences", () => {
  const c = context.constraints.find((c) => c.kind === "DO_NOT_RESOLVE_CONTRADICTION")!
  const first = narrative({
    contradictionIds: ["CTR_001"],
    constraintTreatments: [
      {
        constraintId: c.id,
        subjectIds: c.subjectIds,
        treatment: "preserve-contradiction",
        explanation: "First side",
      },
    ],
  })
  expect(
    auditNarrativeReferences(first, context).constraints.find((r) => r.constraintId === c.id)
      ?.status,
  ).toBe("MISSING")
  first.sections[0]!.sentences.push({
    ...first.sections[0]!.sentences[0]!,
    id: "SNT_002",
    claimIds: ["CLM_002"],
  })
  expect(
    auditNarrativeReferences(first, context).constraints.find((r) => r.constraintId === c.id),
  ).toMatchObject({
    status: "COVERED",
    semanticStatus: "UNKNOWN",
    sentenceIds: ["SNT_001", "SNT_002"],
  })
})

it("an invalid uncertainty link cannot earn constraint coverage with correct-looking IDs", () => {
  const u = context.uncertainties.find((u) => u.subjectType === "claim")!
  const c = context.constraints.find(
    (c) => c.kind === "ACKNOWLEDGE_UNCERTAINTY" && c.subjectIds[0] === u.uncertaintyId,
  )!
  const n = narrative({
    claimIds: ["CLM_UNRELATED"],
    uncertaintyIds: [u.uncertaintyId],
    constraintTreatments: [
      {
        constraintId: c.id,
        subjectIds: c.subjectIds,
        treatment: "acknowledge-uncertainty",
        explanation: "Acknowledged",
      },
    ],
  })
  const report = auditNarrativeReferences(n, context)
  expect(report.structuralStatus).toBe("FAIL")
  expect(report.constraints.find((r) => r.constraintId === c.id)?.status).toBe("MISSING")
})

it("a known uncertainty ID cannot hide a dangling subject", () => {
  const u = context.uncertainties.find((u) => u.subjectType === "claim")!
  const broken = structuredClone(context)
  broken.claims = broken.claims.filter((c) => c.claimId !== u.subjectId)
  const report = auditNarrativeReferences(
    narrative({ claimIds: [u.subjectId], uncertaintyIds: [u.uncertaintyId] }),
    broken,
  )
  expect(report.references.find((r) => r.kind === "uncertainty")?.status).toBe("INVALID")
})
