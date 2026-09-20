import { describe, it, expect } from "vitest"
import { StructuredAgent, readPromptFile } from "../src/core/structured-agent.js"
import { ResearchEngine } from "../src/agents/research/research-engine.js"
import { TraceService } from "../src/core/trace.js"
import { MockLLMProvider } from "../src/providers/llm/mock.js"
import { MockSearchProvider } from "../src/providers/search/mock-search-provider.js"
import {
  CachedSearchProvider,
  MemorySearchCache,
} from "../src/providers/search/cached-search-provider.js"
import { MockContentProvider } from "../src/providers/content/mock-content-provider.js"

/** No canned LLM responses — the research engine uses only deterministic fallbacks. */
const fallbackProvider = () => new MockLLMProvider(() => null)

function buildEngine(question: string): ResearchEngine {
  const agent = new StructuredAgent(fallbackProvider(), readPromptFile)
  const search = new CachedSearchProvider(new MockSearchProvider(), new MemorySearchCache())
  return new ResearchEngine({
    question,
    agent,
    search,
    content: new MockContentProvider(),
    maxSourcesPerQuery: 6,
    maxSources: 24,
    maxFollowUpRounds: 1,
    followUpLimit: 2,
  })
}

describe("offline research E2E", () => {
  it("runs the full chain deterministically with follow-up research and traceability", async () => {
    const question = "Может ли человечество стать новым видом?"
    const first = await buildEngine(question).run()
    const second = await buildEngine(question).run()

    // Every research artifact is present
    expect(first.plan.subQuestions.length).toBeGreaterThanOrEqual(1)
    expect(first.queries.length).toBeGreaterThanOrEqual(1)
    expect(first.sources.length).toBeGreaterThanOrEqual(1)
    expect(first.evidence.length).toBeGreaterThanOrEqual(1)
    expect(first.claims.length).toBeGreaterThanOrEqual(1)
    expect(first.contradictions).toBeDefined()
    expect(first.gaps).toBeDefined()
    expect(first.summary).toContain("research gaps identified")

    // Follow-up research ran to close gaps
    expect(first.queries.length).toBeGreaterThan(first.plan.subQuestions.length)
    expect(first.gaps.some((g) => g.suggestedResearchQueries.length > 0)).toBe(true)
    expect(first.sources.length).toBeLessThanOrEqual(24)
    expect(first.followUpRoundsUsed).toBe(1)

    // Determinism across independent runs
    expect(first.sources.map((s) => s.id)).toEqual(second.sources.map((s) => s.id))
    expect(first.evidence.map((e) => e.id)).toEqual(second.evidence.map((e) => e.id))
    expect(first.queries.map((q) => q.id)).toEqual(second.queries.map((q) => q.id))

    // Every claim traces back through evidence to sources
    const service = new TraceService(first)
    for (const claim of first.claims) {
      const trace = service.traceClaim(claim.id)
      expect(trace?.evidence.length).toBeGreaterThanOrEqual(1)
      expect(trace?.sources.length).toBeGreaterThanOrEqual(1)
    }

    // Query → sources → evidence
    const queryTrace = service.traceQuery(first.queries[0]!.id)
    expect(queryTrace?.query.id).toBe(first.queries[0]!.id)
    expect(queryTrace?.subQuestion).toBeDefined()
    expect(
      (queryTrace?.sources.length ?? 0) + (queryTrace?.evidence.length ?? 0),
    ).toBeGreaterThanOrEqual(1)

    // Source → query, evidence, claims
    const sourceTrace = service.traceSource(first.sources[0]!.id)
    expect(sourceTrace?.source.id).toBe(first.sources[0]!.id)
    expect(sourceTrace?.query).toBeDefined()

    // Evidence → source → claims
    const evidenceTrace = service.traceEvidence(first.evidence[0]!.id)
    expect(evidenceTrace?.evidence.id).toBe(first.evidence[0]!.id)
    expect(evidenceTrace?.source?.id).toBe(first.evidence[0]!.sourceId)
  })
})
