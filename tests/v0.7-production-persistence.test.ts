import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { ScopedMemory } from "../src/core/memory/scoped-memory.js"
import { ProductionEngine } from "../src/agents/production/production-engine.js"
import { guardNarrative, guardVisual } from "../src/core/production/guards.js"
import {
  PRODUCTION_WRITE_KEYS,
  EPISTEMIC_PIPELINE_KEYS,
  REASONING_ARTIFACT_KEYS,
  GOVERNANCE_WRITE_KEYS,
  protectedKeys,
} from "../src/core/production/write-scope.js"
import { NarrativeSchema, VisualOutputSchema, SelfCheckOutputSchema } from "../src/core/schemas.js"
import { ReasoningContextSchema, ProductionManifestSchema } from "../src/core/production/schemas.js"
import type { Narrative, VisualOutput, SelfCheckOutput } from "../src/core/schemas.js"
import type { ProductionProvenance, ReasoningContext } from "../src/core/production/types.js"

const REFERENCE = "2024-06-01T00:00:00.000Z"
const SIG = "a".repeat(64)
const CTX_SIG = "b".repeat(64)

let dir: string
let memory: JsonMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-v07-persist-"))
  memory = new JsonMemoryStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function context(over: Partial<ReasoningContext> = {}): ReasoningContext {
  return {
    version: 1,
    project: "demo",
    question: "Why do cats purr?",
    referenceDate: REFERENCE,
    inputSignature: SIG,
    contextSignature: CTX_SIG,
    reasoningCycleId: "CYC_001",
    decision: {
      cycleId: "CYC_001",
      sessionId: "SES_001",
      stepId: "STEP_003",
      trigger: "explicit-request",
      actionKind: "STOP",
      actionTarget: null,
      status: "STOPPED",
      stoppingKind: "STOP_INCONCLUSIVE",
      stoppingReason: "Evidence is not yet conclusive.",
      humanInTheLoop: false,
      cycleCompleted: true,
    },
    epistemicSummary: {
      claimCount: 1,
      usableClaimCount: 1,
      qualifiedClaimCount: 0,
      unsupportedClaimCount: 0,
      hypothesisCount: 1,
      activeHypothesisCount: 1,
      contradictionCount: 0,
      openGapCount: 0,
      uncertaintyCount: 0,
      meanClaimConfidence: 0.9,
      completenessStatus: "COMPLETE",
      continueResearch: false,
    },
    claims: [
      {
        claimId: "CLM_001",
        knowledge: "FACT",
        status: "SUPPORTED",
        confidence: 0.9,
        usable: true,
        requiresQualification: false,
        contradictionIds: [],
        gapIds: [],
        uncertaintyIds: [],
      },
    ],
    activeHypotheses: [
      {
        hypothesisId: "HYP_001",
        versionId: "HYP_001_v2",
        statement: "Purring aids bone healing.",
        verificationRationale: "The effect size is not established.",
        status: "ACTIVE",
        confidence: 0.5,
        verificationStatus: "INCONCLUSIVE",
        supportingClaimIds: ["CLM_001"],
        contradictingClaimIds: [],
        researchGapIds: [],
        isAlternative: false,
      },
    ],
    uncertainties: [],
    constraints: [
      {
        id: "REQUIRE_HUMAN_APPROVAL#global",
        kind: "REQUIRE_HUMAN_APPROVAL",
        severity: "critical",
        rule: "Human approval is required.",
        subjectIds: [],
        source: "governance",
      },
    ],
    traceRefs: {
      reasoningCycleId: "CYC_001",
      reasoningSessionId: "SES_001",
      reasoningStepId: "STEP_003",
      epistemicSignature: "c".repeat(64),
      stateSignature: "d".repeat(64),
      intelligenceInputSignature: null,
      intelligenceFreshness: "recomputed",
      intelligenceBudget: null,
      claimIds: ["CLM_001"],
      claimTraceEdges: [
        { claimId: "CLM_001", evidenceIds: ["EV_001"], sourceIds: ["SRC_001"], supported: true },
      ],
      hypothesisVersionIds: ["HYP_001_v2"],
      contradictionIds: [],
      gapIds: [],
      uncertaintyIds: [],
      evidenceIds: ["EV_001"],
      sourceIds: ["SRC_001"],
    },
    ...over,
  }
}

function narrative(): Narrative {
  return {
    title: "Purr",
    logline: "Why cats purr.",
    thesis: "Purring may aid bone healing, but the evidence is not settled.",
    sections: [
      {
        id: "SEC_001",
        heading: "Open",
        sentences: [
          {
            id: "SNT_001",
            text: "Purring may aid bone healing.",
            knowledge: "SCIENTIFIC_HYPOTHESIS",
            claimIds: ["CLM_001"],
          },
        ],
      },
    ],
  }
}

function visual(): VisualOutput {
  return {
    shots: [
      {
        id: "SHT_001",
        duration: 5,
        narration: "Purring may aid bone healing.",
        visualType: "AI_RECONSTRUCTION",
        description: "A cat purring on a sofa.",
        source: "SRC_001",
        narrativeSentenceIds: ["SNT_001"],
      },
    ],
  }
}

function selfCheck(
  ctx: ReasoningContext,
  narrativeProvenance: ProductionProvenance,
): SelfCheckOutput {
  const engine = new ProductionEngine(memory)
  return {
    critical: [],
    warnings: [],
    info: [],
    production: engine.audit(
      {
        context: ctx,
        narrative: { ...narrative(), production: narrativeProvenance },
        visual: visual(),
      },
      [{ artifact: "narrative", keys: ["narrative"] }],
    ),
  }
}

describe("v0.7 §17 — provenance persistence", () => {
  it("round-trips a guarded narrative through the schema", () => {
    const { artifact } = guardNarrative(narrative(), context())
    const parsed = NarrativeSchema.parse(JSON.parse(JSON.stringify(artifact)))
    expect(parsed.production).toBeDefined()
    expect(parsed.production!.contextSignature).toBe(CTX_SIG)
  })

  it("round-trips a guarded visual output through the schema", async () => {
    const ctx = context()
    const { artifact } = guardVisual(visual(), guardNarrative(narrative(), ctx).artifact, ctx)
    await memory.save("visual", artifact)
    const parsed = VisualOutputSchema.parse((await memory.get("visual"))!)
    expect(parsed.production!.inputSignature).toBe(SIG)
  })

  it("keeps pre-v0.7 artifacts valid (production is optional)", () => {
    expect(
      NarrativeSchema.parse(JSON.parse(JSON.stringify(narrative()))).production,
    ).toBeUndefined()
    expect(
      VisualOutputSchema.parse(JSON.parse(JSON.stringify(visual()))).production,
    ).toBeUndefined()
    expect(
      SelfCheckOutputSchema.parse({ critical: [], warnings: [], info: [] }).production,
    ).toBeUndefined()
  })

  it("round-trips a self-check report carrying the production audit", () => {
    const ctx = context()
    const report = selfCheck(ctx, guardNarrative(narrative(), ctx).provenance)
    const parsed = SelfCheckOutputSchema.parse(JSON.parse(JSON.stringify(report)))
    expect(parsed.production!.contextSignature).toBe(CTX_SIG)
    expect(parsed.production!.epistemicMutation).toBe(false)
    expect(parsed.production!.checks.length).toBeGreaterThan(0)
  })

  it("round-trips the reasoning context through the schema", () => {
    const parsed = ReasoningContextSchema.parse(JSON.parse(JSON.stringify(context())))
    expect(parsed.contextSignature).toBe(CTX_SIG)
    expect(parsed.traceRefs.sourceIds).toEqual(["SRC_001"])
  })
})

describe("v0.7 §15 — manifest", () => {
  function inputs(ctx = context()) {
    const guarded = guardNarrative(narrative(), ctx)
    return {
      context: ctx,
      narrative: guarded.artifact,
      visual: guardVisual(visual(), guarded.artifact, ctx).artifact,
      selfCheck: selfCheck(ctx, guarded.provenance),
    }
  }

  it("binds every artifact to the context that produced it", () => {
    const manifest = new ProductionEngine(memory).buildManifest(inputs())
    expect(ProductionManifestSchema.parse(manifest).version).toBe(1)
    expect(manifest.context.contextSignature).toBe(CTX_SIG)
    expect(manifest.context.reasoningCycleId).toBe("CYC_001")
    for (const artifact of manifest.artifacts) {
      expect(artifact.inputSignature).toBe(SIG)
      expect(artifact.contextSignature).toBe(CTX_SIG)
    }
    expect(manifest.artifacts.map((a) => a.artifact).sort()).toEqual([
      "narrative",
      "selfCheck",
      "visual",
    ])
    expect(manifest.staleness.autoRegenerate).toBe(false)
  })

  it("carries the self-check verdict and the context constraints", () => {
    const manifest = new ProductionEngine(memory).buildManifest(inputs())
    expect(manifest.selfCheck!.verdict).toBe("PASS")
    expect(manifest.constraints.map((c) => c.id)).toContain("REQUIRE_HUMAN_APPROVAL#global")
  })

  it("is byte-identical for identical inputs", () => {
    const engine = new ProductionEngine(memory)
    expect(JSON.stringify(engine.buildManifest(inputs()))).toBe(
      JSON.stringify(engine.buildManifest(inputs())),
    )
  })

  it("round-trips through persistence", async () => {
    const engine = new ProductionEngine(memory)
    await engine.writeManifest(engine.buildManifest(inputs()))
    const read = await engine.readManifest()
    expect(ProductionManifestSchema.parse(read).context.contextSignature).toBe(CTX_SIG)
  })

  it("round-trips the context through persistence", async () => {
    const engine = new ProductionEngine(new ScopedMemory(memory, new Set(PRODUCTION_WRITE_KEYS)))
    await engine.writeContext(context())
    expect((await engine.readContext())!.contextSignature).toBe(CTX_SIG)
  })
})

describe("v0.7 §16 — staleness", () => {
  it("reports CURRENT when the input signature is unchanged", async () => {
    const ctx = context()
    const guarded = guardNarrative(narrative(), ctx)
    const report = await new ProductionEngine(memory).staleness(ctx, {
      context: ctx,
      narrative: guarded.artifact,
      visual: guardVisual(visual(), guarded.artifact, ctx).artifact,
      selfCheck: selfCheck(ctx, guarded.provenance),
    })
    expect(report.artifacts.find((a) => a.artifact === "narrative")!.status).toBe("CURRENT")
    expect(report.stale).toBe(false)
    expect(report.autoRegenerate).toBe(false)
  })

  it("reports STALE when the reasoning context has moved on", async () => {
    const original = context()
    const guarded = guardNarrative(narrative(), original)
    await memory.save("narrative", guarded.artifact)
    await memory.save("visual", guardVisual(visual(), guarded.artifact, original).artifact)

    const moved = context({ inputSignature: "e".repeat(64) })
    const report = await await new ProductionEngine(memory).staleness(moved)
    expect(report.stale).toBe(true)
    expect(report.autoRegenerate).toBe(false)
    expect(report.artifacts.find((a) => a.artifact === "narrative")!.status).toBe("STALE")
    expect(report.artifacts.find((a) => a.artifact === "visual")!.status).toBe("STALE")
  })

  it("never claims a stale artifact was regenerated", async () => {
    const original = context()
    const guarded = guardNarrative(narrative(), original)
    await memory.save("narrative", guarded.artifact)

    const report = await await new ProductionEngine(memory).staleness(
      context({ inputSignature: "f".repeat(64) }),
    )
    expect(report.autoRegenerate).toBe(false)
    expect(report.artifacts.find((a) => a.artifact === "narrative")!.inputSignature).toBe(SIG)
  })

  it("reports MISSING for an artifact that was never produced", async () => {
    const report = await await new ProductionEngine(memory).staleness(context())
    const narrativeState = report.artifacts.find((a) => a.artifact === "narrative")!
    expect(narrativeState.status).toBe("MISSING")
    expect(narrativeState.inputSignature).toBeNull()
    // A never-produced artifact means the manifest is not in sync, so the
    // manifest is not "clean" either — that is the honest reading.
    expect(report.stale).toBe(true)
  })

  it("reports UNKNOWN when there is no context to compare against", async () => {
    const report = await await new ProductionEngine(memory).staleness(null)
    expect(report.currentInputSignature).toBeNull()
    expect(report.artifacts.every((a) => a.status === "MISSING" || a.status === "UNKNOWN")).toBe(
      true,
    )
  })

  it("mirrors the staleness view into the manifest", () => {
    const ctx = context()
    const guarded = guardNarrative(narrative(), ctx)
    const manifest = new ProductionEngine(memory).buildManifest({
      context: ctx,
      narrative: guarded.artifact,
      visual: guardVisual(visual(), guarded.artifact, ctx).artifact,
    })
    expect(manifest.staleness.currentInputSignature).toBe(SIG)
    expect(manifest.staleness.autoRegenerate).toBe(false)
  })
})

describe("v0.7 §12 — production write scope", () => {
  it("keeps production keys disjoint from every other group", () => {
    for (const key of PRODUCTION_WRITE_KEYS) {
      expect(EPISTEMIC_PIPELINE_KEYS.includes(key as never)).toBe(false)
      expect(REASONING_ARTIFACT_KEYS.includes(key as never)).toBe(false)
      expect(GOVERNANCE_WRITE_KEYS.includes(key as never)).toBe(false)
    }
  })

  it("declares every non-production key as protected", () => {
    for (const key of protectedKeys()) {
      expect(PRODUCTION_WRITE_KEYS.includes(key as never)).toBe(false)
    }
    expect(protectedKeys()).toEqual(
      expect.arrayContaining(["research", "claims", "hypotheses", "reasoning", "approved"]),
    )
  })

  it("keeps epistemic keys out of the production scope", () => {
    for (const key of EPISTEMIC_PIPELINE_KEYS) {
      expect(PRODUCTION_WRITE_KEYS.includes(key as never)).toBe(false)
    }
  })

  it("physically refuses an epistemic write from a production-scoped store", async () => {
    const scoped = new ScopedMemory(memory, new Set(PRODUCTION_WRITE_KEYS))
    await expect(scoped.save("research", {})).rejects.toThrow()
    await expect(scoped.save("hypotheses", {})).rejects.toThrow()
    await expect(scoped.save("approved", {})).rejects.toThrow()
    await expect(scoped.save("reasoning", {})).rejects.toThrow()
  })

  it("physically permits every production key", async () => {
    const scoped = new ScopedMemory(memory, new Set(PRODUCTION_WRITE_KEYS))
    for (const key of PRODUCTION_WRITE_KEYS) {
      await expect(scoped.save(key, { key })).resolves.toBeUndefined()
    }
    const files = await readdir(dir)
    for (const key of PRODUCTION_WRITE_KEYS) {
      expect(files).toContain(`${key}.json`)
    }
  })

  it("leaves the epistemic store byte-identical after a production-only run", async () => {
    await memory.save("research", { claims: [] })
    await memory.save("hypotheses", { hypotheses: [] })
    const before = await readFile(join(dir, "research.json"), "utf8")

    const ctx = context()
    const engine = new ProductionEngine(new ScopedMemory(memory, new Set(PRODUCTION_WRITE_KEYS)))
    await engine.writeContext(ctx)
    await engine.writeManifest(
      engine.buildManifest({ context: ctx, narrative: narrative(), visual: visual() }),
    )

    expect(await readFile(join(dir, "research.json"), "utf8")).toBe(before)
    expect(await memory.get("hypotheses")).toEqual({ hypotheses: [] })
  })
})
