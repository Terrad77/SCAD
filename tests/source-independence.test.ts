import { describe, it, expect } from "vitest"
import {
  analyzeSourceIndependence,
  pairRelationship,
  mergeRelationships,
  independentSourcesFor,
} from "../src/core/evidence/source-independence.js"
import { makeSource } from "./fixtures.js"

describe("source independence (v0.4)", () => {
  it("classifies distinct publishers and domains as independent", () => {
    const a = makeSource({
      id: "SRC_001",
      url: "https://reuters.com/science/a",
      publisher: "Reuters",
      title: "Report A",
    })
    const b = makeSource({
      id: "SRC_002",
      url: "https://nature.com/articles/b",
      publisher: "Nature Portfolio",
      title: "Paper B",
    })
    expect(pairRelationship(a, b).relationship).toBe("INDEPENDENT")
  })

  it("classifies identical canonical URLs as reposts", () => {
    const a = makeSource({ id: "SRC_001", url: "https://x.com/a?utm_source=feed", title: "A" })
    const b = makeSource({ id: "SRC_002", url: "https://x.com/a?utm_source=email", title: "B" })
    expect(pairRelationship(a, b).relationship).toBe("REPOSTS")
  })

  it("classifies same publisher + title as derived", () => {
    const a = makeSource({ id: "SRC_001", publisher: "Reuters", title: "Same Story" })
    const b = makeSource({ id: "SRC_002", publisher: "Reuters", title: "Same Story" })
    expect(pairRelationship(a, b).relationship).toBe("DERIVED_FROM")
  })

  it("classifies same domain but different articles as references", () => {
    const a = makeSource({
      id: "SRC_001",
      url: "https://reuters.com/a",
      publisher: "Reuters",
      title: "Story One",
    })
    const b = makeSource({
      id: "SRC_002",
      url: "https://reuters.com/b",
      publisher: "Reuters",
      title: "Story Two",
    })
    expect(pairRelationship(a, b).relationship).toBe("REFERENCES")
  })

  it("stays UNKNOWN when there is no clear signal and refuses to assume independence", () => {
    const a = makeSource({ id: "SRC_001", title: "A" })
    const b = makeSource({ id: "SRC_002", title: "B" })
    expect(pairRelationship(a, b).relationship).toBe("UNKNOWN")
  })

  it("profiles two independent sources as fully independent", () => {
    const profile = analyzeSourceIndependence([
      makeSource({ id: "SRC_001", url: "https://reuters.com/a", publisher: "Reuters", title: "A" }),
      makeSource({
        id: "SRC_002",
        url: "https://nature.com/b",
        publisher: "Nature Portfolio",
        title: "B",
      }),
    ])
    expect(profile.independentSources).toBe(2)
    expect(profile.dependentSources).toBe(0)
    expect(profile.unknownSources).toBe(0)
    expect(profile.independenceRatio).toBe(1)
  })

  it("marks the target of a dependency edge as dependent, not the origin", () => {
    const profile = analyzeSourceIndependence([
      makeSource({ id: "SRC_001", url: "https://reuters.com/a", publisher: "Reuters" }),
      makeSource({ id: "SRC_002", url: "https://reuters.com/b", publisher: "Reuters" }),
    ])
    expect(profile.dependentSources).toBe(1)
    expect(profile.unknownSources).toBe(1)
    expect(profile.independentSources).toBe(0)
  })

  it("counts independence among a claim's own sources", () => {
    const sources = [
      makeSource({ id: "SRC_001", url: "https://reuters.com/a", publisher: "Reuters", title: "A" }),
      makeSource({
        id: "SRC_002",
        url: "https://nature.com/b",
        publisher: "Nature Portfolio",
        title: "B",
      }),
      makeSource({
        id: "SRC_003",
        url: "https://nature.com/c",
        publisher: "Nature Portfolio",
        title: "B",
      }),
    ]
    const result = independentSourcesFor(["SRC_001", "SRC_002", "SRC_003"], sources)
    expect(result.independentCount).toBe(1)
    expect(result.note).toContain("share origin signals")
  })

  it("merges LLM-provided relationship overrides deterministically", () => {
    const sources = [
      makeSource({ id: "SRC_001", url: "https://reuters.com/a", publisher: "Reuters", title: "A" }),
      makeSource({
        id: "SRC_002",
        url: "https://nature.com/b",
        publisher: "Nature Portfolio",
        title: "B",
      }),
    ]
    const base = analyzeSourceIndependence(sources)
    const merged = mergeRelationships(
      base.relationships,
      [{ sourceA: "SRC_001", sourceB: "SRC_002", relationship: "REFERENCES", basis: "test" }],
      sources,
    )
    expect(merged.independentSources).toBe(0)
    expect(merged.dependentSources).toBe(1)
    expect(merged.relationships).toHaveLength(1)
    expect(merged.relationships[0]!.relationship).toBe("REFERENCES")
  })
})
