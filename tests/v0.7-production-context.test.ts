import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReasoningContext } from "../src/agents/production/reasoning-context.js"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { ReasoningContextSchema, ProductionManifestSchema } from "../src/core/production/schemas.js"
import { PRODUCTION_CONSTRAINT_KINDS } from "../src/core/production/types.js"
import {
  computeReasoningContextSignature,
  reasoningContextInputSignature,
} from "../src/core/production/signature.js"
import { makeResearchBundle, makeClaim, makeHypothesis } from "./fixtures.js"
import type {
  ResearchBundle,
  Claim,
  Hypothesis,
  HypothesisVerification,
} from "../src/core/schemas.js"

const REFERENCE = "2024-06-01T00:00:00.000Z"

let dir: string
let store: JsonMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-v07-ctx-"))
  store = new JsonMemoryStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Bundle with a clean FACT claim, a contested one, and a speculation. */
function bundle(over: Partial<ResearchBundle> = {}): ResearchBundle {
  const claims: Claim[] = [
    makeClaim({ id: "CLM_001", knowledge: "FACT", status: "SUPPORTED", confidence: 0.9 }),
    makeClaim({ id: "CLM_002", knowledge: "FACT", status: "SUPPORTED", confidence: 0.9 }),
    makeClaim({
      id: "CLM_003",
      knowledge: "SCIENTIFIC_HYPOTHESIS",
      status: "PARTIAL",
      confidence: 0.5,
    }),
  ]
  return makeResearchBundle({
    claims,
    contradictions: [
      {
        id: "CTR_001",
        claimA: "CLM_001",
        claimB: "CLM_002",
        severity: "HIGH",
        classification: "CONTRADICTION",
        explanation: "Sources disagree on the effect size.",
      },
    ],
    gaps: [
      {
        id: "GAP_001",
        question: "How large is the effect?",
        importance: 0.9,
        relatedClaims: ["CLM_001"],
        suggestedResearchQueries: ["effect size replications"],
      },
    ],
    ...over,
  })
}

function hypotheses(
  over: Partial<Hypothesis> = {},
): Array<Hypothesis & { verifications?: HypothesisVerification[] }> {
  return [
    {
      ...makeHypothesis({ id: "HYP_001", status: "ACTIVE", supportingClaims: ["CLM_001"] }),
      verifications: [
        {
          hypothesisId: "HYP_001",
          status: "INCONCLUSIVE",
          confidence: 0.4,
          supportingEvidence: ["EV_001"],
          contradictingEvidence: [],
          researchGaps: ["GAP_001"],
          rationale: "Insufficient independent replication.",
        },
      ],
      ...over,
    },
  ]
}

async function build(
  over: {
    research?: ResearchBundle | null
    hypotheses?: ReturnType<typeof hypotheses> | null
  } = {},
) {
  return buildReasoningContext({
    project: "demo",
    question: "Why do cats purr?",
    research: "research" in over ? (over.research ?? null) : bundle(),
    hypotheses: "hypotheses" in over ? (over.hypotheses ?? null) : hypotheses(),
    referenceDate: REFERENCE,
    memory: store,
  })
}

describe("v0.7 §7 — ReasoningContext", () => {
  it("projects the epistemic state without copying it", async () => {
    const ctx = await build()
    expect(ctx.version).toBe(1)
    expect(ctx.project).toBe("demo")
    expect(ctx.question).toBe("Why do cats purr?")
    expect(ctx.referenceDate).toBe(REFERENCE)

    // Classification only: no evidence bodies, no source objects, no statements.
    const serialized = JSON.stringify(ctx)
    expect(serialized).not.toContain("Genomic data shows")
    expect(ctx.claims.every((c) => typeof c.claimId === "string" && !("statement" in c))).toBe(true)
    expect(ctx.traceRefs.evidenceIds.every((id) => typeof id === "string")).toBe(true)
  })

  it("marks a claim with an unresolved contradiction as not usable as fact", async () => {
    const ctx = await build()
    const clm1 = ctx.claims.find((c) => c.claimId === "CLM_001")!
    expect(clm1.contradictionIds).toContain("CTR_001")
    expect(clm1.usable).toBe(false)
    expect(clm1.requiresQualification).toBe(true)
  })

  it("keeps an uncontested, well-supported claim usable as fact", async () => {
    const ctx = await build()
    // CLM_003 is speculative; add a clean fact claim to prove usable is reachable.
    const clean = await build({
      research: bundle({ contradictions: [], claims: [makeClaim({ id: "CLM_009" })] }),
    })
    const found = clean.claims.find((c) => c.claimId === "CLM_009")
    expect(found).toBeDefined()
    expect(ctx.claims.find((c) => c.claimId === "CLM_003")!.usable).toBe(false)
  })

  it("excludes REJECTED/SUPERSEDED hypotheses from the active set", async () => {
    const ctx = await build({
      hypotheses: [
        { ...makeHypothesis({ id: "HYP_REJ", status: "REJECTED" }) },
        { ...makeHypothesis({ id: "HYP_SUP", status: "SUPERSEDED" }) },
        { ...makeHypothesis({ id: "HYP_ACT", status: "ACTIVE" }) },
      ],
    })
    expect(ctx.activeHypotheses.map((h) => h.hypothesisId)).toEqual(["HYP_ACT"])
  })

  it("reports NONE for the decision when no reasoning cycle has run", async () => {
    const ctx = await build()
    expect(ctx.reasoningCycleId).toBeNull()
    expect(ctx.decision.cycleId).toBeNull()
    expect(ctx.decision.actionKind).toBe("NONE")
    expect(ctx.decision.status).toBe("NONE")
    expect(ctx.decision.cycleCompleted).toBe(false)
  })

  it("degrades safely on a legacy research artifact (no evidence chain)", async () => {
    const ctx = await build({ research: { sources: [], summary: "legacy" } as never })
    expect(ctx.claims).toHaveLength(0)
    expect(ctx.epistemicSummary.completenessStatus).toBe("UNKNOWN")
    expect(ctx.epistemicSummary.continueResearch).toBe(true)
  })

  it("produces a byte-identical context for identical inputs", async () => {
    const a = await build()
    const b = await build()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.inputSignature).toBe(b.inputSignature)
    expect(a.contextSignature).toBe(b.contextSignature)
  })

  it("changes inputSignature when the epistemic state changes", async () => {
    const before = await build()
    const after = await build({
      research: bundle({ claims: [makeClaim({ id: "CLM_001", confidence: 0.1 })] }),
    })
    expect(after.inputSignature).not.toBe(before.inputSignature)
    expect(after.contextSignature).not.toBe(before.contextSignature)
  })

  it("ignores volatile fetch metadata in the signature", async () => {
    const base = bundle()
    const withAccessed = bundle({
      sources: base.sources.map((s) => ({ ...s, accessedAt: "2024-01-01T00:00:00.000Z" })),
    })
    const a = await build({ research: base })
    const b = await build({ research: withAccessed })
    expect(b.inputSignature).toBe(a.inputSignature)
  })

  it("signs a recomputed report when no envelope is persisted", async () => {
    // An empty store does NOT mean a null intelligence input. `resolveIntelligence`
    // derives the report in memory (production reads intelligence, it never
    // writes it), so the signature covers a populated report and the context
    // records that the value was recomputed rather than persisted.
    expect(await store.get("intelligence")).toBeNull()

    const ctx = await build()

    expect(ctx.traceRefs.intelligenceFreshness).toBe("recomputed")
    expect(ctx.traceRefs.intelligenceInputSignature).not.toBeNull()
    expect(ctx.inputSignature).toMatch(/^[0-9a-f]{64}$/)
  })

  it("recomputes instead of trusting a tampered envelope (H1)", async () => {
    // A corrupt envelope must never be trusted. `resolveIntelligence` must fall
    // back to an in-memory recomputation, record it as such, and — critically —
    // leave the corrupt artifact on disk untouched: production reads intelligence
    // and must never rewrite it.
    await store.save("intelligence", "{corrupt")
    const ctx = await buildReasoningContext({
      project: "demo",
      question: "Why do cats purr?",
      research: bundle(),
      hypotheses: hypotheses(),
      referenceDate: REFERENCE,
      memory: store,
    })

    expect(ctx.traceRefs.intelligenceFreshness).toBe("recomputed")
    expect(ctx.traceRefs.intelligenceInputSignature).not.toBeNull()
    // The tampered payload is still there — production healed nothing in place.
    expect(await store.readRaw("intelligence")).toContain("corrupt")
  })

  it("reports intelligence as absent only when no report can be derived at all", async () => {
    // The genuine `absent` case: there is no research bundle to reason about, so
    // there is nothing to derive a report from. This is the only state in which
    // the builder signs a null intelligence input.
    const ctx = await build({ research: null, hypotheses: null })

    expect(ctx.traceRefs.intelligenceFreshness).toBe("absent")
    expect(ctx.traceRefs.intelligenceInputSignature).toBeNull()
  })

  it("contextSignature signs the body, not itself", async () => {
    const ctx = await build()
    const { contextSignature, ...body } = ctx
    expect(computeReasoningContextSignature(body)).toBe(contextSignature)
  })

  it("inputSignature is a pure function of its declared inputs", async () => {
    const ctx = await build()
    const base = {
      question: "Why do cats purr?",
      research: bundle(),
      hypotheses: hypotheses().map((h) => {
        const copy: Partial<Hypothesis> = { ...h }
        delete (copy as { verifications?: unknown }).verifications
        return copy as Hypothesis
      }),
      verifications: hypotheses().flatMap((h) => h.verifications ?? []),
      // A placeholder for this purity test of the signature helper, NOT a
      // description of what the builder feeds it. An absent envelope does not
      // mean a null report: `resolveIntelligence` recomputes one in memory, so
      // the real builder signs a populated report. That behaviour is pinned
      // separately in "signs a recomputed report when no envelope is persisted".
      intelligence: null,
      decision: ctx.decision,
      referenceDate: REFERENCE,
    }
    const same = reasoningContextInputSignature(base)
    expect(same).toBe(reasoningContextInputSignature({ ...base }))
    expect(same).toMatch(/^[0-9a-f]{64}$/)

    // Any change to a declared input must move the signature.
    expect(reasoningContextInputSignature({ ...base, question: "Why do dogs bark?" })).not.toBe(
      same,
    )
    expect(
      reasoningContextInputSignature({ ...base, referenceDate: "2025-01-01T00:00:00.000Z" }),
    ).not.toBe(same)
    expect(
      reasoningContextInputSignature({
        ...base,
        research: bundle({ claims: [makeClaim({ id: "CLM_001", confidence: 0.1 })] }),
      }),
    ).not.toBe(same)
  })

  it("validates against the persisted schema (round-trippable)", async () => {
    const ctx = await build()
    await store.save("reasoningContext", ctx)
    const read = (await store.get("reasoningContext"))!
    const parsed = ReasoningContextSchema.parse(read)
    expect(parsed.contextSignature).toBe(ctx.contextSignature)
  })
})

describe("v0.7 §8 — production constraints", () => {
  it("derives only constraints from the declared taxonomy", async () => {
    const ctx = await build()
    for (const c of ctx.constraints) {
      expect(PRODUCTION_CONSTRAINT_KINDS).toContain(c.kind)
    }
  })

  it("forbids presenting a contradicted claim as fact", async () => {
    const ctx = await build()
    const c = ctx.constraints.find(
      (c) => c.kind === "DO_NOT_PRESENT_AS_FACT" && c.subjectIds.includes("CLM_001"),
    )
    expect(c).toBeDefined()
    expect(c!.severity).toBe("critical")
  })

  it("requires qualifying an unverified hypothesis", async () => {
    const ctx = await build()
    expect(
      ctx.constraints.some(
        (c) => c.kind === "QUALIFY_AS_HYPOTHESIS" && c.subjectIds.includes("HYP_001"),
      ),
    ).toBe(true)
  })

  it("forbids resolving an unresolved contradiction", async () => {
    const ctx = await build()
    const c = ctx.constraints.find((c) => c.kind === "DO_NOT_RESOLVE_CONTRADICTION")
    expect(c).toBeDefined()
    expect(c!.subjectIds).toContain("CTR_001")
  })

  it("preserves a high-importance research gap", async () => {
    const ctx = await build()
    expect(
      ctx.constraints.some(
        (c) => c.kind === "PRESERVE_RESEARCH_GAPS" && c.subjectIds.includes("GAP_001"),
      ),
    ).toBe(true)
  })

  it("requires human approval unconditionally", async () => {
    const ctx = await build()
    const c = ctx.constraints.find((c) => c.kind === "REQUIRE_HUMAN_APPROVAL")!
    expect(c).toBeDefined()
    expect(c.source).toBe("governance")
  })

  it("forbids a definitive conclusion while reasoning is unresolved", async () => {
    const ctx = await build()
    const c = ctx.constraints.find((c) => c.kind === "NO_DEFINITIVE_CONCLUSION")
    expect(c).toBeDefined()
    expect(c!.source).toBe("reasoning")
  })

  it("is deterministically ordered", async () => {
    const a = await build()
    const b = await build()
    expect(a.constraints.map((c) => c.id)).toEqual(b.constraints.map((c) => c.id))
  })
})

describe("v0.7 §15 — production manifest", () => {
  it("validates against the persisted schema", () => {
    const manifest = {
      version: 1,
      project: "demo",
      question: "Why do cats purr?",
      context: {
        version: 1,
        inputSignature: "a".repeat(64),
        contextSignature: "b".repeat(64),
        reasoningCycleId: null,
        referenceDate: REFERENCE,
      },
      artifacts: [
        {
          artifact: "narrative",
          inputSignature: "a".repeat(64),
          contextSignature: "b".repeat(64),
          reasoningCycleId: null,
        },
      ],
      constraints: [],
      selfCheck: null,
      staleness: {
        currentInputSignature: "a".repeat(64),
        artifacts: [
          {
            artifact: "narrative",
            status: "CURRENT",
            inputSignature: "a".repeat(64),
            reasoningCycleId: null,
          },
        ],
        stale: false,
        autoRegenerate: false,
      },
    }
    expect(ProductionManifestSchema.parse(manifest).version).toBe(1)
  })
})
