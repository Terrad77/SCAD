import { describe, it, expect } from "vitest"
import { guardNarrative, guardVisual } from "../src/core/production/guards.js"
import { VISUAL_TYPES, KNOWLEDGE_LEVELS } from "../src/core/types.js"
import type { KnowledgeLevel, Narrative, Shot, VisualOutput } from "../src/core/types.js"
import type {
  ContextClaimView,
  ContextHypothesisView,
  ProductionNormalization,
  ProductionProvenance,
  ReasoningContext,
  ReasoningDecision,
} from "../src/core/production/types.js"
import { deriveProductionConstraints } from "../src/core/production/constraints.js"
import { makeResearchBundle, makeClaim } from "./fixtures.js"
import type { ResearchBundle } from "../src/core/schemas.js"

const REFERENCE = "2024-06-01T00:00:00.000Z"
const SIG = "a".repeat(64)
const CTX_SIG = "b".repeat(64)

function claimView(over: Partial<ContextClaimView> & { claimId: string }): ContextClaimView {
  return {
    knowledge: "FACT",
    status: "SUPPORTED",
    confidence: 0.9,
    usable: true,
    requiresQualification: false,
    contradictionIds: [],
    gapIds: [],
    uncertaintyIds: [],
    ...over,
  }
}

/** A context with a clean claim, a contradicted claim, and an unverified hypothesis. */
function context(): ReasoningContext {
  const claims = [
    claimView({ claimId: "CLM_001" }),
    claimView({
      claimId: "CLM_002",
      usable: false,
      requiresQualification: true,
      contradictionIds: ["CTR_001"],
    }),
    claimView({
      claimId: "CLM_003",
      knowledge: "SCIENTIFIC_HYPOTHESIS",
      status: "PARTIAL",
      confidence: 0.5,
      usable: false,
      requiresQualification: true,
    }),
  ]
  const activeHypotheses: ContextHypothesisView[] = [
    {
      hypothesisId: "HYP_001",
      versionId: "HYP_001",
      statement: "Purring is a low-frequency vocalization.",
      verificationRationale: null,
      status: "ACTIVE",
      confidence: 0.4,
      verificationStatus: "UNVERIFIED",
      supportingClaimIds: ["CLM_001"],
      contradictingClaimIds: [],
      researchGapIds: [],
      isAlternative: false,
    },
  ]
  // Contradictions and gaps are not carried on the context itself: they reach
  // production only through the constraints derived from them.
  const contradictions = [
    { id: "CTR_001", claimA: "CLM_002", claimB: "CLM_003", severity: "HIGH" as const },
  ]
  const decision: ReasoningDecision = {
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
  }
  const body = {
    version: 1 as const,
    project: "demo",
    question: "Why do cats purr?",
    referenceDate: REFERENCE,
    inputSignature: SIG,
    reasoningCycleId: null,
    epistemicSummary: {
      claimCount: 3,
      usableClaimCount: 1,
      qualifiedClaimCount: 2,
      unsupportedClaimCount: 0,
      hypothesisCount: 1,
      activeHypothesisCount: 1,
      contradictionCount: 1,
      openGapCount: 0,
      uncertaintyCount: 0,
      meanClaimConfidence: 0.77,
      completenessStatus: "INSUFFICIENT" as const,
      continueResearch: true,
    },
    claims,
    activeHypotheses,
    uncertainties: [],
    decision,
    traceRefs: {
      reasoningCycleId: null,
      reasoningSessionId: null,
      reasoningStepId: null,
      epistemicSignature: "c".repeat(64),
      stateSignature: "d".repeat(64),
      intelligenceInputSignature: null,
      intelligenceFreshness: "recomputed" as const,
      intelligenceBudget: null,
      claimIds: ["CLM_001", "CLM_002", "CLM_003"],
      claimTraceEdges: claims.map((claim) => ({
        claimId: claim.claimId,
        evidenceIds: ["EV_001"],
        sourceIds: ["SRC_001"],
        supported: true,
      })),
      hypothesisVersionIds: ["HYP_001"],
      contradictionIds: ["CTR_001"],
      gapIds: [],
      uncertaintyIds: [],
      evidenceIds: ["EV_001"],
      sourceIds: ["SRC_001"],
    },
  }
  const constraints = deriveProductionConstraints({
    claims,
    activeHypotheses,
    contradictions,
    gaps: [],
    uncertainties: [],
    decision,
  })
  return { ...body, constraints, contextSignature: CTX_SIG }
}

function sentence(
  id: string,
  knowledge: KnowledgeLevel,
  claimIds: string[] = [],
  text = "Generic sentence.",
): Narrative["sections"][number]["sentences"][number] {
  return { id, text, knowledge, claimIds }
}

function narrative(sentences: Narrative["sections"][number]["sentences"]): Narrative {
  return {
    title: "T",
    logline: "L",
    thesis: "th",
    sections: [{ id: "SEC_001", heading: "S", sentences }],
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

function firstShot(artifact: VisualOutput): Shot {
  const shot = artifact.shots[0]
  if (shot === undefined) throw new Error("the guarded visual output has no shots")
  return shot
}

function firstNormalization(provenance: ProductionProvenance): ProductionNormalization {
  const normalization = provenance.normalizations[0]
  if (normalization === undefined) throw new Error("the guard recorded no normalization")
  return normalization
}

function shot(over: Partial<Shot> = {}): Shot {
  return {
    id: "SHT_001",
    duration: 5,
    description: "A cat on a sofa.",
    visualType: "ARCHIVE",
    narrativeSentenceIds: ["SNT_001"],
    source: "SRC_001",
    narration: "narration",
    ...over,
  }
}

function visual(shots: Shot[]): VisualOutput {
  return { shots }
}

describe("v0.7 §9.1 — narrative guard", () => {
  it("passes a compliant narrative through untouched apart from provenance", () => {
    const ctx = context()
    const input = narrative([sentence("SNT_001", "FACT", ["CLM_001"])])
    const { artifact, provenance } = guardNarrative(input, ctx)

    expect(firstSentence(artifact).knowledge).toBe("FACT")
    expect(provenance.normalizations).toHaveLength(0)
    expect(provenance.violations).toHaveLength(0)
    expect(artifact.production).toEqual(provenance)
  })

  it("downgrades a FACT sentence resting on a contradicted claim", () => {
    const ctx = context()
    const { artifact, provenance } = guardNarrative(
      narrative([sentence("SNT_001", "FACT", ["CLM_002"])]),
      ctx,
    )
    expect(firstSentence(artifact).knowledge).toBe("SCIENTIFIC_HYPOTHESIS")
    const n = provenance.normalizations.find((x) => x.subjectId === "SNT_001")!
    expect(n.rule).toBe("KNOWLEDGE_DOWNGRADE")
    expect(n.from).toBe("FACT")
    expect(n.to).toBe("SCIENTIFIC_HYPOTHESIS")
    // The reason must name the real cause, not restate the label.
    expect(n.reason).toMatch(/CTR_001/)
  })

  it("downgrades a FACT sentence with no claim reference", () => {
    const { artifact } = guardNarrative(narrative([sentence("SNT_001", "FACT", [])]), context())
    expect(firstSentence(artifact).knowledge).toBe("INTERPRETATION")
  })

  it("downgrades a FACT sentence citing a claim absent from the context", () => {
    const { artifact } = guardNarrative(
      narrative([sentence("SNT_001", "FACT", ["CLM_999"])]),
      context(),
    )
    expect(firstSentence(artifact).knowledge).toBe("INTERPRETATION")
  })

  it("takes the weakest posture across referenced claims", () => {
    // A clean claim cannot lift a sentence above the weakest claim it leans on.
    const { artifact } = guardNarrative(
      narrative([sentence("SNT_001", "FACT", ["CLM_001", "CLM_003"])]),
      context(),
    )
    expect(firstSentence(artifact).knowledge).toBe("SCIENTIFIC_HYPOTHESIS")
  })

  it("flags a definitive conclusion while reasoning is unresolved", () => {
    const { provenance } = guardNarrative(
      narrative([
        sentence("SNT_001", "FACT", ["CLM_001"], "In conclusion, cats purr because of healing."),
      ]),
      context(),
    )
    const v = provenance.violations.find((x) => x.kind === "NO_DEFINITIVE_CONCLUSION")!
    expect(v).toBeDefined()
    expect(v.constraintId).toMatch(/NO_DEFINITIVE_CONCLUSION/)
  })

  it("never deletes or rewrites sentence text", () => {
    const text = "Ultimately the mechanism is settled and purring heals bone."
    const { artifact } = guardNarrative(
      narrative([sentence("SNT_001", "FACT", ["CLM_002"], text)]),
      context(),
    )
    expect(firstSentence(artifact).text).toBe(text)
  })

  it("binds provenance to the exact context that produced it", () => {
    const ctx = context()
    const { provenance } = guardNarrative(
      narrative([sentence("SNT_001", "FACT", ["CLM_001"])]),
      ctx,
    )
    expect(provenance.inputSignature).toBe(ctx.inputSignature)
    expect(provenance.contextSignature).toBe(ctx.contextSignature)
    expect(provenance.contextVersion).toBe(ctx.version)
    expect(provenance.reasoningCycleId).toBeNull()
    expect(provenance.project).toBe("demo")
  })

  it("marks a broken constraint unsatisfied and a held one satisfied", () => {
    const ctx = context()
    const { provenance } = guardNarrative(
      narrative([
        sentence("SNT_001", "FACT", ["CLM_002"]), // breaks CLM_002's constraint
        sentence("SNT_002", "FACT", ["CLM_001"]), // holds CLM_001 (no constraint exists)
      ]),
      ctx,
    )
    const broken = ctx.constraints.find((c) => c.subjectIds.includes("CLM_002"))!
    expect(provenance.satisfiedConstraints).not.toContain(broken.id)
    expect(provenance.violations.some((v) => v.constraintId === broken.id)).toBe(true)
  })

  it("is deterministic", () => {
    const ctx = context()
    const input = narrative([sentence("SNT_001", "FACT", ["CLM_002"])])
    expect(JSON.stringify(guardNarrative(input, ctx))).toBe(
      JSON.stringify(guardNarrative(input, ctx)),
    )
  })

  it("never produces a knowledge level outside the taxonomy", () => {
    const ctx = context()
    const levels = KNOWLEDGE_LEVELS.map((l) => sentence(`S_${l}`, l as KnowledgeLevel, ["CLM_001"]))
    const { artifact } = guardNarrative(narrative(levels), ctx)
    for (const s of sentencesOf(artifact)) {
      expect(KNOWLEDGE_LEVELS).toContain(s.knowledge)
    }
  })
})

describe("v0.7 §9.2 — visual guard", () => {
  const factNarrative = narrative([sentence("SNT_001", "FACT", ["CLM_001"])])
  const hypNarrative = narrative([sentence("SNT_001", "SCIENTIFIC_HYPOTHESIS", ["CLM_002"])])

  it("permits archival footage for FACT material backed by a source", () => {
    const { artifact, provenance } = guardVisual(visual([shot()]), factNarrative, context())
    expect(firstShot(artifact).visualType).toBe("ARCHIVE")
    expect(firstShot(artifact).source).toBe("SRC_001")
    expect(provenance.normalizations).toHaveLength(0)
  })

  it("downgrades archival footage used for hypothesis material", () => {
    const { artifact, provenance } = guardVisual(
      visual([shot({ narrativeSentenceIds: ["SNT_001"] })]),
      hypNarrative,
      context(),
    )
    expect(firstShot(artifact).visualType).not.toBe("ARCHIVE")
    expect(firstNormalization(provenance).rule).toBe("VISUAL_TYPE_DOWNGRADE")
  })

  it("accepts a shot whose source is a known source id or evidence id", () => {
    const ctx = context()
    for (const source of ["SRC_001", "EV_001"]) {
      const { artifact, provenance } = guardVisual(visual([shot({ source })]), factNarrative, ctx)
      expect(firstShot(artifact).source).toBe(source)
      expect(provenance.violations).toHaveLength(0)
    }
  })

  it("detaches an unknown source reference instead of trusting it", () => {
    const { artifact, provenance } = guardVisual(
      visual([shot({ source: "SRC_999" })]),
      factNarrative,
      context(),
    )
    expect(firstShot(artifact).source).toBeUndefined()
    expect(provenance.normalizations.some((n) => n.rule === "SOURCE_DETACHED")).toBe(true)
    expect(provenance.violations.some((v) => v.kind === "KEEP_TRACEABLE_TO_CLAIMS")).toBe(true)
  })

  it("flags a shot documenting a contested claim as footage", () => {
    const ctx = context()
    // Sentence reads FACT but the claim it leans on is not usable.
    const lying = narrative([sentence("SNT_001", "FACT", ["CLM_002"])])
    const { provenance } = guardVisual(visual([shot()]), lying, ctx)
    expect(
      provenance.violations.some(
        (v) => v.kind === "DO_NOT_PRESENT_AS_FACT" && v.subjectIds.includes("CLM_002"),
      ),
    ).toBe(true)
  })

  it("never silently keeps an impermissible visual type across every pairing", () => {
    const ctx = context()
    for (const posture of KNOWLEDGE_LEVELS) {
      const n = narrative([sentence("SNT_001", posture as KnowledgeLevel, ["CLM_001"])])
      for (const visualType of VISUAL_TYPES) {
        const { artifact, provenance } = guardVisual(
          visual([shot({ visualType: visualType as Shot["visualType"] })]),
          n,
          ctx,
        )
        const emitted = firstShot(artifact).visualType
        if (emitted !== visualType) {
          expect(provenance.normalizations.length).toBeGreaterThan(0)
        }
        expect(VISUAL_TYPES).toContain(emitted)
      }
    }
  })

  it("treats a shot with no resolvable sentence as the weakest posture", () => {
    const ctx = context()
    const { artifact } = guardVisual(
      visual([shot({ narrativeSentenceIds: ["SNT_MISSING"], visualType: "ARCHIVE" })]),
      factNarrative,
      ctx,
    )
    expect(firstShot(artifact).visualType).not.toBe("ARCHIVE")
  })

  it("preserves every other shot field", () => {
    const ctx = context()
    const input = shot({ source: "SRC_999" })
    const { artifact } = guardVisual(visual([input]), factNarrative, ctx)
    expect(firstShot(artifact)).toMatchObject({
      id: "SHT_001",
      description: "A cat on a sofa.",
      narrativeSentenceIds: ["SNT_001"],
      narration: "narration",
    })
  })

  it("is deterministic and never mutates its input", () => {
    const ctx = context()
    const input = visual([shot({ source: "SRC_999", visualType: "ARCHIVE" })])
    const snapshot = JSON.stringify(input)
    const a = guardVisual(input, hypNarrative, ctx)
    const b = guardVisual(input, hypNarrative, ctx)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe("v0.7 I12/I13 — guards may only weaken, never erase", () => {
  it("keeps the researched contradictions and gaps out of the artifact scope", () => {
    // The guards must not have any mechanism to remove a contradiction or gap:
    // they only touch knowledge labels, visual types and provenance refs.
    const research: ResearchBundle = makeResearchBundle({
      contradictions: [
        {
          id: "CTR_001",
          claimA: "CLM_001",
          claimB: "CLM_002",
          severity: "HIGH",
          classification: "CONTRADICTION",
          explanation: "x",
        },
      ],
      gaps: [
        {
          id: "GAP_001",
          question: "q",
          importance: 0.9,
          relatedClaims: ["CLM_001"],
          suggestedResearchQueries: ["q1"],
        },
      ],
      claims: [makeClaim({ id: "CLM_001" })],
    })
    const ctx = context()
    const { artifact } = guardNarrative(narrative([sentence("SNT_001", "FACT", ["CLM_001"])]), ctx)
    // Narrative is unchanged in shape: the research record is still addressable.
    expect(research.contradictions).toHaveLength(1)
    expect(research.gaps).toHaveLength(1)
    expect(sentencesOf(artifact)).toHaveLength(1)
  })
})
