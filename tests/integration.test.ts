import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { runDocumentaryPipeline, renderScript } from "../src/core/documentary.js"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import type { LLMProvider, LLMRequest } from "../src/providers/llm/llm.js"

// ------------------------------------------------------------------
// Stage-specific canned JSON output (validates against Zod schemas)
// ------------------------------------------------------------------

const RESEARCH = JSON.stringify({
  sources: [
    { id: "SRC_001", title: "Neanderthal Genome Project", type: "PAPER", reliability: 0.95 },
    { id: "SRC_002", title: "Future Evolution of Humans", type: "BOOK", reliability: 0.7 },
  ],
  summary: "Well-established facts about Neanderthal admixture and future evolutionary pressures.",
})

const CLAIMS = JSON.stringify({
  claims: [
    {
      id: "CLM_001",
      statement: "Modern humans carry 1-4% Neanderthal DNA from ancient interbreeding.",
      sources: ["SRC_001"],
      evidence: ["Genomic sequencing of Neanderthal and modern populations."],
      confidence: 0.95,
      status: "SUPPORTED",
      knowledge: "FACT",
    },
    {
      id: "CLM_002",
      statement:
        "Technology is beginning to create selective pressures unlike anything in natural history.",
      sources: ["SRC_002"],
      evidence: ["Discussion of genetic engineering, AI, and human enhancement."],
      confidence: 0.6,
      status: "PARTIAL",
      knowledge: "INTERPRETATION",
    },
    {
      id: "CLM_003",
      statement: "A genetically modified human population might diverge rapidly.",
      sources: ["SRC_002"],
      evidence: ["Speculative projection from current gene therapy research."],
      confidence: 0.4,
      status: "PARTIAL",
      knowledge: "SPECULATION",
    },
  ],
})

const HYPOTHESES = JSON.stringify({
  hypotheses: [
    {
      id: "HYP_001",
      statement: "Geographic or reproductive isolation could cause new speciation.",
      basis: ["Allopatric speciation models."],
      supportingClaims: ["CLM_001"],
      contradictingClaims: [],
      confidence: 0.5,
      status: "ACTIVE",
      assumptions: ["A sufficiently isolated population persists."],
      missingInfo: ["Isolation threshold for humans."],
      verificationTasks: ["Review reproductive isolation research."],
    },
    {
      id: "HYP_002",
      statement: "Genetic engineering may bypass natural selection and create a new form of human.",
      basis: ["Gene therapy and synthetic biology advances."],
      supportingClaims: ["CLM_002"],
      contradictingClaims: [],
      confidence: 0.55,
      status: "ACTIVE",
      assumptions: ["Technology continues to advance without major restrictions."],
      missingInfo: ["Technical feasibility of heritable human germline changes."],
      verificationTasks: ["Assess CRISPR human germline progress."],
    },
  ],
})

const NARRATIVE = JSON.stringify({
  title: "Can Humanity Become a New Species?",
  logline:
    "When technology begins to shape evolution, the definition of 'human' may change forever.",
  thesis:
    "Human evolution is no longer driven only by nature; technology is creating new forces of divergence.",
  sections: [
    {
      id: "SEC_001",
      heading: "Hook",
      sentences: [
        {
          id: "SNT_001",
          text: "Humans carry a small but measurable percentage of Neanderthal DNA from encounters tens of thousands of years ago.",
          knowledge: "FACT",
          claimIds: ["CLM_001"],
        },
        {
          id: "SNT_002",
          text: "But what if our species could split again — this time, driven by technology rather than ice and isolation?",
          knowledge: "SPECULATION",
          claimIds: ["CLM_003"],
        },
      ],
    },
    {
      id: "SEC_002",
      heading: "What is a biological species?",
      sentences: [
        {
          id: "SNT_003",
          text: "In classical biology, a species is a group of organisms that can interbreed and produce fertile offspring.",
          knowledge: "FACT",
          claimIds: [],
        },
        {
          id: "SNT_004",
          text: "The definition works well for well-isolated populations but blurs at the edges.",
          knowledge: "INTERPRETATION",
          claimIds: [],
        },
      ],
    },
    {
      id: "SEC_003",
      heading: "Humans and Neanderthals",
      sentences: [
        {
          id: "SNT_005",
          text: "Modern humans and Neanderthals interbred, leaving a small genetic legacy in non-African populations today.",
          knowledge: "FACT",
          claimIds: ["CLM_001"],
        },
      ],
    },
  ],
})

const VISUAL = JSON.stringify({
  shots: [
    {
      id: "SHOT_001",
      duration: 5,
      narration: "Humans carry a small but measurable percentage of Neanderthal DNA.",
      visualType: "INFOGRAPHIC",
      description: "Animated bar chart showing 1-4% Neanderthal DNA percentage.",
      narrativeSentenceIds: ["SNT_001"],
    },
    {
      id: "SHOT_002",
      duration: 4,
      narration: "What if our species could split again?",
      visualType: "AI_RECONSTRUCTION",
      description: "Two divergent human silhouettes against a futuristic backdrop.",
      camera: "slow pan",
      mood: "mysterious",
      narrativeSentenceIds: ["SNT_002"],
    },
    {
      id: "SHOT_003",
      duration: 6,
      narration: "In classical biology, a species is a group that can interbreed.",
      visualType: "ABSTRACT",
      description: "Animated interbreeding circle diagram.",
      narrativeSentenceIds: ["SNT_003"],
    },
    {
      id: "SHOT_004",
      duration: 5,
      narration: "Modern humans and Neanderthals interbred, leaving a genetic legacy.",
      visualType: "ARCHIVE",
      description: "Side-by-side hominid skulls with data overlay.",
      narrativeSentenceIds: ["SNT_005"],
    },
  ],
})

function mockProvider(): LLMProvider {
  const responseByStage: Record<string, string> = {
    research: RESEARCH,
    claims: CLAIMS,
    hypothesis: HYPOTHESES,
    narrative: NARRATIVE,
    visual: VISUAL,
  }

  const select = (request: LLMRequest) => {
    const stage = request.meta?.stage ?? "unknown"
    const json = responseByStage[stage]
    if (!json) return null
    return { text: json }
  }

  return new MockLLMProvider(select)
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "scad-integration-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("full documentary pipeline", () => {
  it("produces valid artifacts and script from mocked LLM", async () => {
    const result = await runDocumentaryPipeline({
      provider: mockProvider(),
      memoryDir: tmpDir,
      question: "Can humanity become a new species?",
      title: "Species",
    })

    // Every stage produced valid artifacts
    expect(result.research!.sources.length).toBeGreaterThanOrEqual(2)
    expect(result.claims!.claims.length).toBeGreaterThanOrEqual(3)
    expect(result.hypotheses!.hypotheses.length).toBeGreaterThanOrEqual(2)
    expect(result.factCheck!.assessments.length).toBeGreaterThanOrEqual(3)
    expect(result.narrative!.sections.length).toBeGreaterThanOrEqual(2)
    expect(result.visual!.shots.length).toBeGreaterThanOrEqual(2)

    // Script renders cleanly
    const script = renderScript(result.narrative!)
    expect(script).toContain("Can Humanity Become a New Species?")
    expect(script).toContain("[FACT]")
    expect(script).toContain("[SPECULATION]")

    // Traceability
    expect(result.traceability.summary.totalShots).toBe(result.visual!.shots.length)
    expect(result.traceability.summary.fullyTraced).toBeGreaterThanOrEqual(1)
  })

  it("can resume from a prior stage", async () => {
    const mem = new JsonMemoryStore(tmpDir)
    await mem.save("research", {
      sources: [{ id: "SRC_X", title: "Prior", type: "BOOK", reliability: 0.5 }],
      summary: "Pre-existing research.",
    })

    // claims not saved → pipeline should run claims onward
    const result = await runDocumentaryPipeline({
      provider: mockProvider(),
      memoryDir: tmpDir,
      question: "Can humanity become a new species?",
      title: "Species",
    })

    expect(result.research!.sources[0]!.id).toBe("SRC_X") // kept from prior run
    expect(result.claims!.claims.length).toBeGreaterThanOrEqual(1)
    expect(result.selfCheck).toBeDefined()
  })
})
