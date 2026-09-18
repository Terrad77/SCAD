import { describe, it, expect } from "vitest"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import type { SearchProvider } from "../src/providers/search/search-provider.js"
import { MockSearchProvider } from "../src/providers/search/mock-search-provider.js"
import { normalizeUrl, requestCacheKey } from "../src/providers/search/normalize.js"
import { MemorySearchCache } from "../src/providers/search/cached-search-provider.js"
import { SourceRegistry } from "../src/core/sources/source-registry.js"
import { SourceAnalyzer } from "../src/agents/research/source-analyzer.js"
import {
  computeEvidenceConfidence,
  computeClaimConfidence,
  clamp,
} from "../src/core/evidence/confidence.js"
import { detectContradictions } from "../src/agents/research/contradiction-detector.js"
import { detectResearchGaps } from "../src/agents/research/gap-detector.js"
import { ResearchEngine } from "../src/agents/research/research-engine.js"
import { verifyHypotheses } from "../src/agents/hypothesis/verify.js"
import { TraceService } from "../src/core/trace.js"
import { makeClaim, makeHypothesis, makeNarrative, makeShot } from "./fixtures.js"
import type {
  Claim,
  Evidence,
  ResearchBundle,
  ResearchGap,
  ResearchPlan,
} from "../src/core/schemas.js"

/** Provider that has no canned responses — exercises deterministic fallbacks. */
const emptyProvider = () => new MockLLMProvider(() => null)

function engineFor(
  question: string,
  search: SearchProvider = new MockSearchProvider(),
): ResearchEngine {
  const agent = new StructuredAgent(emptyProvider(), readPromptFile)
  return new ResearchEngine({ question, agent, search, maxFollowUpRounds: 0 })
}

describe("url normalization", () => {
  it("drops tracking parameters and fragments", () => {
    expect(normalizeUrl("https://Example.COM/a?utm_source=x&id=1#frag")).toBe(
      "https://example.com/a?id=1",
    )
  })

  it("strips trailing slashes", () => {
    expect(normalizeUrl("https://example.com/path///")).toBe("https://example.com/path")
  })

  it("produces stable cache keys", () => {
    expect(requestCacheKey({ query: "  Speciation  ", limit: 5 })).toBe(
      requestCacheKey({ query: "speciation", limit: 5 }),
    )
  })
})

describe("SourceRegistry", () => {
  const analyzer = new SourceAnalyzer()

  it("deduplicates by canonical URL and assigns SRC ids", () => {
    const registry = new SourceRegistry()
    const result: SearchProvider["search"] = async () => []
    void result
    const results = [
      {
        id: "RSLT_001",
        title: "Speciation study",
        url: "https://example.com/a?utm_source=gen&x=1",
      },
      {
        id: "RSLT_002",
        title: "Speciation study (mirror)",
        url: "https://example.com/a?x=1",
      },
    ]
    const added = registry.addSearchResults(
      results,
      { queryId: "QRY_001", subquestionId: "SUB_Q_001" },
      analyzer,
    )
    expect(registry.size).toBe(1)
    // Each result resolves to the same deduplicated source
    expect(added).toHaveLength(2)
    expect(new Set(added.map((s) => s.id))).toEqual(new Set(["SRC_001"]))
  })
})

describe("confidence calculator", () => {
  it("combines source reliability and evidence agreement", () => {
    const high = computeEvidenceConfidence({ sourceReliability: 0.9 })
    const low = computeEvidenceConfidence({ sourceReliability: 0.3 })
    expect(high).toBeGreaterThan(low)
  })

  it("clamps to [0,1]", () => {
    expect(clamp(1.5)).toBe(1)
    expect(clamp(-1)).toBe(0)
  })

  it("computes claim confidence with agreement bonuses", () => {
    const c1 = computeClaimConfidence({
      evidenceConfidences: [0.8, 0.9],
      sourceReliabilities: [0.8, 0.9],
      agreement: 1,
    })
    expect(c1).toBeGreaterThan(0.8)
    // Missing factors degrade gracefully instead of throwing
    expect(() => {
      computeClaimConfidence({ evidenceConfidences: [], sourceReliabilities: [] })
    }).not.toThrow()
  })
})

describe("contradiction detector", () => {
  it("flags a true contradiction with negation polarity mismatch", () => {
    const a = makeClaim({
      id: "CLM_001",
      statement: "Modern human populations are diverging into separate species.",
      confidence: 0.9,
      evidenceIds: ["EVID_001"],
    })
    const b = makeClaim({
      id: "CLM_002",
      statement: "Modern human populations are not diverging into separate species.",
      confidence: 0.85,
      evidenceIds: ["EVID_002"],
    })
    const results = detectContradictions([a, b])
    expect(results).toHaveLength(1)
    expect(results[0]!.classification).toBe("CONTRADICTION")
  })

  it("classifies population differences, not contradictions", () => {
    const a = makeClaim({
      id: "CLM_001",
      statement: "Non-African populations carry Neanderthal ancestry.",
      confidence: 0.9,
    })
    const b = makeClaim({
      id: "CLM_002",
      statement: "African populations do not carry the same Neanderthal ancestry.",
      confidence: 0.9,
    })
    const results = detectContradictions([a, b])
    expect(results[0]!.classification).toBe("DIFFERENT_POPULATION")
  })

  it("flags hedged conflicts as uncertainty", () => {
    const a = makeClaim({
      id: "CLM_001",
      statement: "Isolated populations may diverge into new species.",
      confidence: 0.6,
    })
    const b = makeClaim({
      id: "CLM_002",
      statement: "Isolated populations do not diverge into new species.",
      confidence: 0.6,
    })
    const results = detectContradictions([a, b])
    expect(results[0]!.classification).toBe("UNCERTAINTY")
  })

  it("ignores unrelated claims", () => {
    const a = makeClaim({ id: "CLM_001", statement: "Mars has low gravity.", confidence: 0.8 })
    const b = makeClaim({ id: "CLM_002", statement: "Birds migrate seasonally.", confidence: 0.8 })
    expect(detectContradictions([a, b])).toHaveLength(0)
  })
})

describe("research gap detector", () => {
  const plan: ResearchPlan = {
    id: "PLAN_001",
    question: "Q",
    scope: "S",
    subQuestions: [
      { id: "SUB_Q_001", text: "Covered sub-question" },
      { id: "SUB_Q_002", text: "Uncovered sub-question" },
    ],
  }

  const evidence: Evidence[] = [
    {
      id: "EVID_001",
      sourceId: "SRC_001",
      statement: "Evidence statement",
      supportsClaims: ["CLM_001"],
      contradictsClaims: [],
      confidence: 0.9,
    },
  ]

  const claims: Claim[] = [
    makeClaim({
      id: "CLM_001",
      statement: "Single-sourced claim about speciation.",
      sources: ["SRC_001"],
      evidenceIds: ["EVID_001"],
      confidence: 0.9,
      knowledge: "FACT",
      subquestionIds: ["SUB_Q_001"],
    }),
    makeClaim({
      id: "CLM_002",
      statement: "Speculative claim lacking verification.",
      sources: ["SRC_001"],
      evidenceIds: ["EVID_001"],
      confidence: 0.3,
      knowledge: "SPECULATION",
    }),
  ]

  it("flags uncovered sub-questions, corroboration and verification needs", () => {
    const gaps: ResearchGap[] = detectResearchGaps({ plan, claims, evidence, contradictions: [] })
    const questions = gaps.map((g) => g.question)
    expect(questions.some((q) => q.includes("No evidence gathered"))).toBe(true)
    expect(questions.some((q) => q.includes("Single-source claim"))).toBe(true)
    expect(questions.some((q) => q.includes("Verification needed"))).toBe(true)
  })

  it("creates a high-importance gap for unresolved HIGH contradictions", () => {
    const contradictoryClaims: Claim[] = [
      makeClaim({
        id: "CLM_003",
        statement: "X is rising.",
        confidence: 0.9,
        evidenceIds: ["EVID_001"],
      }),
      makeClaim({
        id: "CLM_004",
        statement: "X is not rising.",
        confidence: 0.9,
        evidenceIds: ["EVID_001"],
      }),
    ]
    const contradictions = detectContradictions(contradictoryClaims)
    expect(contradictions[0]!.severity).toBe("HIGH")
    const gaps = detectResearchGaps({
      plan,
      claims: contradictoryClaims,
      evidence,
      contradictions,
    })
    expect(gaps.some((g) => g.importance >= 0.9)).toBe(true)
  })
})

describe("ResearchEngine", () => {
  it("produces a fully linked research bundle deterministically", async () => {
    const engine = engineFor("Can humanity become a new species?")
    const first = await engine.run()
    const second = await engineFor("Can humanity become a new species?").run()

    // Determinism: same ids and counts across runs
    expect(first.sources.map((s) => s.id)).toEqual(second.sources.map((s) => s.id))
    expect(first.evidence.length).toBe(second.evidence.length)
    expect(first.claims.length).toBe(second.claims.length)

    expect(first.plan.subQuestions.length).toBeGreaterThanOrEqual(1)
    expect(first.queries.length).toBe(first.plan.subQuestions.length)
    expect(first.sources.length).toBeGreaterThanOrEqual(1)
    expect(first.evidence.length).toBeGreaterThanOrEqual(1)
    expect(first.claims.length).toBeGreaterThanOrEqual(1)
    expect(first.gaps).toBeDefined()
    expect(first.contradictions).toBeDefined()

    // Every claim links back through evidence to a source
    const evidenceById = new Map(first.evidence.map((e) => [e.id, e]))
    for (const claim of first.claims) {
      expect(claim.evidenceIds?.length).toBeGreaterThanOrEqual(1)
      for (const evId of claim.evidenceIds ?? []) {
        expect(evidenceById.get(evId)?.sourceId).toBeDefined()
      }
    }
    // Evidence registers which claims it supports
    for (const evidenceItem of first.evidence) {
      expect(evidenceItem.supportsClaims.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("runs an additional research round to reduce gaps", async () => {
    const agent = new StructuredAgent(emptyProvider(), readPromptFile)
    const engine = new ResearchEngine({
      question: "Can humanity become a new species?",
      agent,
      search: new MockSearchProvider(),
      maxFollowUpRounds: 1,
      followUpLimit: 1,
    })
    const bundle = await engine.run()
    expect(bundle.queries.length).toBeGreaterThan(bundle.plan.subQuestions.length)
  })
})

describe("hypothesis verification", () => {
  it("verifies hypotheses against evidence", () => {
    const bundle: Pick<ResearchBundle, "claims" | "evidence" | "gaps" | "contradictions"> = {
      claims: [
        makeClaim({ id: "CLM_001", evidenceIds: ["EVID_001"] }),
        makeClaim({ id: "CLM_002", evidenceIds: ["EVID_002"] }),
      ],
      evidence: [
        {
          id: "EVID_001",
          sourceId: "SRC_001",
          statement: "Strong support",
          supportsClaims: [],
          contradictsClaims: [],
          confidence: 0.95,
        },
        {
          id: "EVID_002",
          sourceId: "SRC_002",
          statement: "Contradicting datum",
          supportsClaims: [],
          contradictsClaims: [],
          confidence: 0.9,
        },
      ],
      gaps: [
        {
          id: "GAP_001",
          question: "G",
          importance: 0.8,
          relatedClaims: ["CLM_001"],
          suggestedResearchQueries: ["Q"],
        },
      ],
      contradictions: [],
    }
    const hypothesis = makeHypothesis({
      supportingClaims: ["CLM_001"],
      contradictingClaims: ["CLM_002"],
    })
    const { verifications } = verifyHypotheses({ hypotheses: [hypothesis], research: bundle })
    expect(verifications).toHaveLength(1)
    expect(verifications[0]!.status).toBe("PARTIALLY_SUPPORTED")
    expect(hypothesis.supportingEvidence).toContain("EVID_001")
    expect(hypothesis.contradictingEvidence).toContain("EVID_002")
    expect(hypothesis.researchGaps).toContain("GAP_001")
  })

  it("marks hypotheses untested when no evidence exists", () => {
    const { verifications } = verifyHypotheses({
      hypotheses: [makeHypothesis()],
      research: { claims: [], evidence: [], gaps: [], contradictions: [] },
    })
    expect(verifications[0]!.status).toBe("UNTESTED")
  })
})

describe("TraceService", () => {
  it("traces a claim back to its sources and evidence", async () => {
    const bundle = await engineFor("Can humanity become a new species?").run()
    const claim = bundle.claims[0]!
    const service = new TraceService(bundle)
    const trace = service.traceClaim(claim.id)
    expect(trace).toBeDefined()
    expect(trace!.evidence.length).toBeGreaterThanOrEqual(1)
    expect(trace!.sources.length).toBeGreaterThanOrEqual(1)
  })

  it("builds a shot→claim→evidence→source report", async () => {
    const bundle = await engineFor("Can humanity become a new species?").run()
    const claim = bundle.claims[0]!
    const narrative = makeNarrative({
      sections: [
        {
          id: "SEC_001",
          heading: "Hook",
          sentences: [
            {
              id: "SNT_001",
              text: "Sentence backed by a claim.",
              knowledge: "FACT",
              claimIds: [claim.id],
            },
          ],
        },
      ],
    })
    const shot = makeShot({ narrativeSentenceIds: ["SNT_001"] })
    const report = new TraceService(bundle).report(narrative, [shot])
    expect(report.summary.totalShots).toBe(1)
    expect(report.summary.fullyTraced).toBe(1)
    expect(report.entries[0]!.evidenceIds?.length).toBeGreaterThanOrEqual(1)
    expect(report.entries[0]!.sourceTitles.length).toBeGreaterThanOrEqual(1)
  })
})

describe("cached search provider", () => {
  it("serves repeat queries from cache deterministically", async () => {
    const cache = new MemorySearchCache()
    const calls = new Map<string, number>()
    const base: SearchProvider = {
      name: "counting",
      async search(request) {
        calls.set(cacheKeyOf(request), (calls.get(cacheKeyOf(request)) ?? 0) + 1)
        return new MockSearchProvider().search(request)
      },
    }
    const provider = new (
      await import("../src/providers/search/cached-search-provider.js")
    ).CachedSearchProvider(base, cache)
    await provider.search({ query: "species" })
    await provider.search({ query: "species" })
    const key = requestCacheKey({ query: "species" })
    expect(calls.get(key)).toBe(1)
  })
})

function cacheKeyOf(request: { query: string; limit?: number }): string {
  return requestCacheKey(request)
}
