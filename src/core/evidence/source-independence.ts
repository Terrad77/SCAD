import type {
  Source,
  SourceIndependenceResult,
  SourceRelationship,
  SourceRelationshipRecord,
} from "../schemas.js"
import { canonicalUrl } from "../url.js"

/**
 * Deterministic source-independence assessment (v0.4).
 *
 * Independence is never silently assumed. Pairs are classified from explicit
 * structural signals (identical canonical URLs, shared publisher, shared
 * domain, title reuse); every unclear pair stays UNKNOWN. An LLM can later
 * provide richer pair relationships, but the offline/mock path is fully
 * deterministic and UNKNOWN is always a legal answer.
 */

const DEPENDENT_RELATIONSHIPS = new Set<SourceRelationship>([
  "DERIVED_FROM",
  "QUOTES",
  "REPOSTS",
  "REFERENCES",
])

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function hostOf(source: Source): string {
  if (!source.url) return ""
  try {
    return new URL(source.url).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

/**
 * Classifies the relationship between two sources from structural signals.
 * Dependency signals win; a strong no-shared-origin signal yields INDEPENDENT;
 * anything ambiguous stays UNKNOWN.
 */
export function pairRelationship(a: Source, b: Source): SourceRelationshipRecord {
  const canonicalA = canonicalUrl(a.url ?? "")
  const canonicalB = canonicalUrl(b.url ?? "")

  const titleA = normalizeText(a.title)
  const titleB = normalizeText(b.title)
  const publisherA = normalizeText(a.publisher)
  const publisherB = normalizeText(b.publisher)
  const hostA = hostOf(a)
  const hostB = hostOf(b)

  const ordered = a.id <= b.id ? { sourceA: a.id, sourceB: b.id } : { sourceA: b.id, sourceB: a.id }

  if (canonicalA !== "" && canonicalA === canonicalB) {
    return {
      ...ordered,
      relationship: "REPOSTS",
      basis: "identical canonical URL",
    }
  }

  const sameTitle = titleA !== "" && titleA === titleB
  const samePublisher = publisherA !== "" && publisherA === publisherB
  const sameHost = hostA !== "" && hostA === hostB

  if (sameTitle && samePublisher) {
    return {
      ...ordered,
      relationship: "DERIVED_FROM",
      basis: `same publisher (${publisherA}) and identical title`,
    }
  }
  if (sameTitle && (samePublisher || sameHost)) {
    return {
      ...ordered,
      relationship: "REPOSTS",
      basis: "identical title across the same outlet",
    }
  }

  // One title quoting/referencing the other (e.g. a press roundup of a headline).
  if (
    (titleA.includes(titleB) && titleB.length >= 5) ||
    (titleB.includes(titleA) && titleA.length >= 5)
  ) {
    return {
      ...ordered,
      relationship: "QUOTES",
      basis: `title of ${titleA.length <= titleB.length ? "one" : "the other"} contains the other's title`,
    }
  }

  if (sameHost) {
    return {
      ...ordered,
      relationship: "REFERENCES",
      basis: `same domain (${hostA})`,
    }
  }

  if (publisherA !== "" && publisherB !== "" && publisherA !== publisherB && !sameHost) {
    return {
      ...ordered,
      relationship: "INDEPENDENT",
      basis: `distinct publishers (${publisherA} vs ${publisherB}) and domains (${hostA} vs ${hostB})`,
    }
  }

  return {
    ...ordered,
    relationship: "UNKNOWN",
    basis: "no clear structural dependency or independence signal",
  }
}

/** Builds every unordered source pair relationship deterministically. */
export function buildSourceRelationships(sources: Source[]): SourceRelationshipRecord[] {
  const relationships: SourceRelationshipRecord[] = []
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      relationships.push(pairRelationship(sources[i]!, sources[j]!))
    }
  }
  return relationships
}

/** Recomputes the independence profile from a relationship list. */
export function profileFromRelationships(
  relationships: SourceRelationshipRecord[],
  sources: Source[],
): SourceIndependenceResult {
  const dependent = new Set<string>()
  const independent = new Set<string>()
  for (const record of relationships) {
    if (DEPENDENT_RELATIONSHIPS.has(record.relationship)) dependent.add(record.sourceB)
  }
  for (const record of relationships) {
    if (record.relationship === "INDEPENDENT") {
      independent.add(record.sourceA)
      independent.add(record.sourceB)
    }
  }

  const totalSources = sources.length
  let independentSources = 0
  let dependentSources = 0
  let unknownSources = 0
  for (const source of sources) {
    const isDependent = dependent.has(source.id)
    const isIndependent = independent.has(source.id) && !isDependent
    if (isDependent) dependentSources += 1
    else if (isIndependent) independentSources += 1
    else unknownSources += 1
  }

  return {
    relationships,
    totalSources,
    independentSources,
    dependentSources,
    unknownSources,
    independenceRatio: totalSources > 0 ? independentSources / totalSources : 0,
    reasons: [
      `independence is derived structurally from URLs, publishers and titles; ${unknownSources} of ${totalSources} source${totalSources === 1 ? "" : "s"} carried no clear signal and stayed UNKNOWN`,
      "relationships are heuristics; treat every INDEPENDENT verdict as provisional, never as a guarantee",
    ],
  }
}

/**
 * Computes the global source-independence profile over a set of sources.
 *
 * A source counts as *dependent* when a dependency edge points its way;
 * as *independent* when every pairwise signal is structural independence;
 * otherwise it stays *unknown*. A lone source can never be declared
 * independent on its own.
 */
export function analyzeSourceIndependence(sources: Source[]): SourceIndependenceResult {
  return profileFromRelationships(buildSourceRelationships(sources), sources)
}

/** Unordered pair key used to merge LLM-provided relationship overrides. */
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}::${b}` : `${b}::${a}`
}

/**
 * Merges externally provided relationships (e.g. from a structured LLM stage)
 * over the deterministic profile. Overrides win per pair; everything else
 * keeps its heuristic label.
 */
export function mergeRelationships(
  base: SourceRelationshipRecord[],
  overrides: SourceRelationshipRecord[],
  sources: Source[],
): SourceIndependenceResult {
  const merged = new Map<string, SourceRelationshipRecord>()
  for (const record of base) merged.set(pairKey(record.sourceA, record.sourceB), record)
  for (const record of overrides) {
    merged.set(pairKey(record.sourceA, record.sourceB), record)
  }
  return profileFromRelationships([...merged.values()], sources)
}

/** Counts how many of a claim's sources are independent of the others. */
export function independentSourcesFor(
  sourceIds: string[],
  sources: Source[],
): { independentCount: number; note: string } {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const present = sourceIds.map((id) => byId.get(id)).filter((s): s is Source => Boolean(s))
  if (present.length === 0) return { independentCount: 0, note: "no sources" }

  const edges = new Map<string, Set<string>>()
  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      const a = present[i]!
      const b = present[j]!
      const record = pairRelationship(a, b)
      if (DEPENDENT_RELATIONSHIPS.has(record.relationship)) {
        if (!edges.has(a.id)) edges.set(a.id, new Set())
        if (!edges.has(b.id)) edges.set(b.id, new Set())
        edges.get(a.id)!.add(b.id)
        edges.get(b.id)!.add(a.id)
      }
    }
  }

  const independentCount = present.filter((s) => !edges.has(s.id)).length
  const dependentCount = present.length - independentCount
  return {
    independentCount,
    note:
      dependentCount > 0
        ? `${independentCount} of ${present.length} sources without a detected dependency edge; ${dependentCount} share origin signals`
        : `${independentCount} of ${present.length} sources; no dependency detected`,
  }
}
