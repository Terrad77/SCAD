import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDocumentaryPipeline } from "../src/core/documentary.js"
import { JsonMemoryStore } from "../src/core/memory/json-memory.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { createLLMProvider } from "../src/providers/llm/factory.js"
import { ResearchBundleSchema, NarrativeSchema, VisualOutputSchema } from "../src/core/schemas.js"
import { ReasoningContextSchema, ProductionManifestSchema } from "../src/core/production/schemas.js"
import type { LLMProvider, LLMRequest } from "../src/providers/llm/llm.js"
import {
  EPISTEMIC_PIPELINE_KEYS,
  PRODUCTION_WRITE_KEYS,
} from "../src/core/production/write-scope.js"

const QUESTION = "Can humanity become a new species?"
const TITLE = "Speciation"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scad-v07-e2e-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const RESEARCH = JSON.stringify({
  sources: [
    {
      id: "SRC_001",
      title: "A study",
      url: "https://example.org/a",
      publisher: "Journal",
      date: "2024-01-01",
    },
  ],
  evidence: [
    {
      id: "EV_001",
      sourceId: "SRC_001",
      statement: "Gene editing in human embryos has been performed.",
      reliability: 0.9,
    },
  ],
  claims: [
    {
      id: "CLM_001",
      statement: "Human embryos have been gene-edited.",
      knowledge: "FACT",
      status: "SUPPORTED",
      confidence: 0.85,
      sources: ["SRC_001"],
      evidence: ["EV_001"],
    },
    {
      id: "CLM_002",
      statement: "Gene editing will produce a new species.",
      knowledge: "SCIENTIFIC_HYPOTHESIS",
      status: "PARTIAL",
      confidence: 0.5,
      sources: ["SRC_001"],
      evidence: ["EV_001"],
    },
  ],
  contradictions: [
    {
      id: "CTR_001",
      claimA: "CLM_001",
      claimB: "CLM_002",
      severity: "MEDIUM",
      classification: "UNRESOLVED_PARADOX",
      explanation: "The mechanism is disputed.",
    },
  ],
  gaps: [
    {
      id: "GAP_001",
      question: "What are the long-term effects?",
      importance: 0.8,
      relatedClaims: ["CLM_001"],
      suggestedResearchQueries: ["long term effects"],
    },
  ],
  summary: "A research bundle.",
})

const CLAIMS = JSON.stringify({
  claims: [
    {
      id: "CLM_001",
      statement: "Human embryos have been gene-edited.",
      knowledge: "FACT",
      status: "SUPPORTED",
      confidence: 0.85,
      sources: ["SRC_001"],
      evidence: ["EV_001"],
    },
    {
      id: "CLM_002",
      statement: "Gene editing will produce a new species.",
      knowledge: "SCIENTIFIC_HYPOTHESIS",
      status: "PARTIAL",
      confidence: 0.5,
      sources: ["SRC_001"],
      evidence: ["EV_001"],
    },
  ],
  summary: "Claims.",
})

const HYPOTHESES = JSON.stringify({
  hypotheses: [
    {
      id: "HYP_001",
      statement: "Directed evolution may eventually produce a new species.",
      basis: ["CLM_001"],
      supportingClaims: ["CLM_001"],
      contradictingClaims: ["CLM_002"],
      researchGaps: ["GAP_001"],
      confidence: 0.5,
      status: "ACTIVE",
      assumptions: ["Selection pressure persists."],
      missingInfo: ["Long-term effects."],
      verificationTasks: ["Find longitudinal data."],
    },
  ],
})

const NARRATIVE = JSON.stringify({
  title: TITLE,
  logline: "A question about species.",
  thesis: "The answer is not settled.",
  sections: [
    {
      id: "SEC_001",
      heading: "The record",
      summary: "What is known.",
      sentences: [
        {
          // Rests on a claim the research layer found contested.
          id: "SNT_001",
          text: "Human embryos have been gene-edited.",
          knowledge: "FACT",
          claimIds: ["CLM_001"],
        },
        {
          // An untraceable assertion.
          id: "SNT_002",
          text: "In conclusion, a new species is inevitable.",
          knowledge: "FACT",
          claimIds: ["CLM_002"],
        },
        {
          // Rests on a claim the research layer found clean.
          id: "SNT_003",
          text: "Editing techniques have been regulated in most jurisdictions.",
          knowledge: "FACT",
          claimIds: ["CLM_004"],
        },
      ],
    },
  ],
})

const VISUAL = JSON.stringify({
  shots: [
    {
      id: "SHT_001",
      duration: 5,
      narration: "Embryos under a microscope.",
      visualType: "ARCHIVE",
      description: "Microscope footage.",
      source: "SRC_001",
      narrativeSentenceIds: ["SNT_001"],
    },
    {
      id: "SHT_002",
      duration: 5,
      narration: "An inevitable future.",
      visualType: "ARCHIVE",
      description: "A stock future city.",
      source: "SRC_001",
      narrativeSentenceIds: ["SNT_002"],
    },
    {
      id: "SHT_003",
      duration: 5,
      narration: "A regulatory document.",
      visualType: "ARCHIVE",
      description: "A document on a desk.",
      source: "SRC_001",
      narrativeSentenceIds: ["SNT_003"],
    },
  ],
})

/** Offline provider: every stage answered from a fixed fixture. */
function offlineProvider(): LLMProvider {
  const map: Record<string, string> = {
    research: RESEARCH,
    claims: CLAIMS,
    hypothesis: HYPOTHESES,
    narrative: NARRATIVE,
    visual: VISUAL,
  }
  return new MockLLMProvider((request: LLMRequest) => {
    const text = map[request.meta?.stage ?? ""]
    return text === undefined ? null : { text }
  })
}

async function run() {
  return runDocumentaryPipeline({
    provider: offlineProvider(),
    memoryDir: dir,
    question: QUESTION,
    title: TITLE,
  })
}

describe("v0.7 offline end-to-end", () => {
  it.each([QUESTION, "Offline pipeline verification"])(
    "keeps the standard CLI mock demo free of dangling claim references: %s",
    async (question) => {
      const result = await runDocumentaryPipeline({
        provider: createLLMProvider({ provider: "mock" }).provider,
        memoryDir: dir,
        question,
        title: TITLE,
        referenceDate: "2024-06-01T00:00:00.000Z",
      })
      const known = new Set(result.reasoningContext!.claims.map((claim) => claim.claimId))
      const sentences = result.narrative!.sections.flatMap((section) => section.sentences)
      for (const sentence of sentences) {
        expect(
          sentence.claimIds.every((id) => known.has(id)),
          sentence.id,
        ).toBe(true)
      }
      expect(
        result.selfCheck!.production!.checks.find((check) => check.id === "TRACEABILITY")?.status,
      ).toBe("PASS")
    },
  )

  it("produces every artifact, including the reasoning context and manifest", async () => {
    const result = await run()
    const files = await readdir(dir)

    for (const key of [...PRODUCTION_WRITE_KEYS, ...EPISTEMIC_PIPELINE_KEYS]) {
      if (key === "hypothesis-versions") continue // written by the reasoning cycle
      expect(files).toContain(`${key}.json`)
    }
    expect(result.reasoningContext).toBeDefined()
    expect(result.production).toBeDefined()

    // Every artifact parses against its schema.
    const memory = new JsonMemoryStore(dir)
    expect(ReasoningContextSchema.parse(await memory.get("reasoningContext"))).toBeDefined()
    expect(NarrativeSchema.parse(await memory.get("narrative"))).toBeDefined()
    expect(VisualOutputSchema.parse(await memory.get("visual"))).toBeDefined()
    expect(ProductionManifestSchema.parse(await memory.get("production"))).toBeDefined()
    expect(ResearchBundleSchema.safeParse(await memory.get("research")).success).toBe(true)
  })

  it("makes production no more assertive than the reasoning", async () => {
    const result = await run()
    const ctx = result.reasoningContext!
    const sentences = result.narrative!.sections.flatMap((s) => s.sentences)
    const byId = new Map(sentences.map((s) => [s.id, s]))
    const claimById = new Map(ctx.claims.map((c) => [c.claimId, c]))

    // A fact resting on a clean claim survives as a fact.
    expect(claimById.get("CLM_004")!.usable).toBe(true)
    expect(byId.get("SNT_003")!.knowledge).toBe("FACT")

    // A fact resting on a contested claim does not.
    expect(claimById.get("CLM_001")!.usable).toBe(false)
    expect(byId.get("SNT_001")!.knowledge).not.toBe("FACT")

    // A definitive conclusion does not either.
    expect(byId.get("SNT_002")!.knowledge).not.toBe("FACT")

    // The invariant, stated generally: no sentence may outrank its claims.
    for (const sentence of sentences) {
      for (const claimId of sentence.claimIds) {
        const claim = claimById.get(claimId)
        if (claim === undefined) continue
        if (!claim.usable) expect(sentence.knowledge).not.toBe("FACT")
      }
    }

    // And the corrections are on the record, not silent.
    const provenance = result.narrative!.production!
    expect(provenance.normalizations.length).toBeGreaterThan(0)
    expect(provenance.inputSignature).toBe(ctx.inputSignature)
  })

  it("does not let hypothesis material wear documentary footage", async () => {
    const result = await run()
    const byId = new Map(result.visual!.shots.map((s) => [s.id, s]))
    // SHT_003 documents an established fact → footage is legitimate.
    expect(byId.get("SHT_003")!.visualType).toBe("ARCHIVE")
    // SHT_001 and SHT_002 document unsettled material → footage would assert it.
    expect(byId.get("SHT_001")!.visualType).not.toBe("ARCHIVE")
    expect(byId.get("SHT_002")!.visualType).not.toBe("ARCHIVE")
    expect(result.visual!.production!.normalizations.length).toBeGreaterThan(0)
  })

  it("surfaces the contradiction and the gap in the audit", async () => {
    const result = await run()
    const report = result.selfCheck!.production!
    const ids = report.checks.map((c) => c.id)
    expect(ids).toContain("CONTRADICTION_PRESERVATION")
    expect(ids).toContain("UNSUPPORTED_STATEMENTS")
    expect(report.diagnostics.length).toBeGreaterThan(0)
  })

  it("leaves the epistemic state untouched", async () => {
    const memory = new JsonMemoryStore(dir)
    await run()
    const research = JSON.stringify(await memory.get("research"))
    const claims = JSON.stringify(await memory.get("claims"))
    const hypotheses = JSON.stringify(await memory.get("hypotheses"))

    // A second, resumed run must not let production rewrite any of them.
    await runDocumentaryPipeline({
      provider: offlineProvider(),
      memoryDir: dir,
      question: QUESTION,
      title: TITLE,
    })
    expect(JSON.stringify(await memory.get("research"))).toBe(research)
    expect(JSON.stringify(await memory.get("claims"))).toBe(claims)
    expect(JSON.stringify(await memory.get("hypotheses"))).toBe(hypotheses)
  })

  it("keeps the context and every artifact signature-bound together", async () => {
    const result = await run()
    const manifest = result.production!
    expect(manifest.context.contextSignature).toBe(result.reasoningContext!.contextSignature)
    for (const artifact of manifest.artifacts) {
      if (artifact.inputSignature !== null) {
        expect(artifact.inputSignature).toBe(manifest.context.inputSignature)
      }
    }
  })

  it("writes no governance state on its own", async () => {
    await run()
    const files = await readdir(dir)
    expect(files).not.toContain("approved.json")
  })

  it("is reproducible: the same project and inputs yield the same context", async () => {
    // The store directory name is the project identity, and the context is
    // signed with it, so both runs need the same name in different parents.
    const parentA = await mkdtemp(join(tmpdir(), "scad-reproA-"))
    const parentB = await mkdtemp(join(tmpdir(), "scad-reproB-"))
    const name = "speciation"
    const options = {
      provider: offlineProvider(),
      question: QUESTION,
      title: TITLE,
      referenceDate: "2024-06-01T00:00:00.000Z",
    }
    try {
      await runDocumentaryPipeline({ ...options, memoryDir: join(parentA, name) })
      await runDocumentaryPipeline({ ...options, memoryDir: join(parentB, name) })
      expect(await readFile(join(parentA, name, "reasoningContext.json"), "utf8")).toBe(
        await readFile(join(parentB, name, "reasoningContext.json"), "utf8"),
      )
    } finally {
      await rm(parentA, { recursive: true, force: true })
      await rm(parentB, { recursive: true, force: true })
    }
  })
})
