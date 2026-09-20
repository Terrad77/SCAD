import type { Source, SourceType } from "../../core/schemas.js"
import type { SearchResult } from "../../providers/search/search-provider.js"
import { clamp } from "../../core/evidence/confidence.js"
import { SOURCE_RELIABILITY_BY_TYPE } from "../../core/evidence/weights.js"

/**
 * Transparent source reliability model. Rather than a universal website
 * ranking, base reliability is derived from the source *type* and should never
 * be treated as absolute truth. Everything here is explainable.
 *
 * The type→reliability map lives in `core/evidence/weights.ts` so the whole
 * Research Intelligence layer shares one source of truth.
 */
export const RELIABILITY_BY_TYPE = SOURCE_RELIABILITY_BY_TYPE

/** Heuristic type inference from the result URL and title. */
export function inferSourceType(result: Pick<SearchResult, "url" | "title">): SourceType {
  const url = (result.url ?? "").toLowerCase()
  const title = (result.title ?? "").toLowerCase()

  if (url.includes(".gov")) return "GOVERNMENT"
  if (url.includes(".edu")) return "UNIVERSITY"
  if (
    url.includes("arxiv") ||
    url.includes("nature.com") ||
    url.includes("science.org") ||
    url.includes("pnas") ||
    url.includes("cell.com") ||
    /royalsociety|plos\.org/.test(url) ||
    title.includes("journal") ||
    title.includes("study")
  ) {
    return "SCIENTIFIC_PAPER"
  }
  if (url.includes("who.int") || url.includes("un.org") || url.includes("esa")) return "GOVERNMENT"
  if (/(nyt|reuters|bbc|cnn|theguardian|wapo|space\.com)/.test(url)) return "NEWS"
  if (url.includes("wikipedia") || title.includes("database")) return "DATABASE"
  if (url.includes("youtube") || url.includes("vimeo")) return "VIDEO"
  if (url.includes("docs.") || title.includes("documentation")) return "DOCUMENTATION"
  if (url.includes("blog") || title.includes("blog")) return "BLOG"
  if (/(facebook|twitter|x\.com|instagram|reddit|youtube)/.test(url)) return "SOCIAL_MEDIA"
  if (title.includes("interview")) return "INTERVIEW"
  if (title.includes("book")) return "BOOK"
  return "OTHER"
}

/**
 * Deterministic source analysis: assigns a type, transparent reliability and a
 * relevance score derived from the search rank (1.0 for the top hit, falling
 * off with position).
 */
export class SourceAnalyzer {
  constructor(private readonly options: { defaultReliability?: number } = {}) {}

  analyze(result: SearchResult, rank: number): Omit<Source, "id"> {
    const type = inferSourceType(result)
    const baseReliability = this.options.defaultReliability ?? RELIABILITY_BY_TYPE[type]
    const relevance = clamp(1.05 - rank * 0.15)
    return {
      title: result.title,
      url: result.url,
      publisher: result.source,
      type,
      publishedAt: result.publishedAt,
      reliability: baseReliability,
      relevance,
      notes: `Analyzed as ${type}; relevance ${relevance.toFixed(2)} from search rank ${rank + 1}.`,
    }
  }
}
