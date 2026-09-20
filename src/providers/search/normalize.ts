import type { SearchResult } from "./search-provider.js"
import { canonicalUrl } from "../../core/url.js"

export { normalizeUrl, canonicalUrl } from "../../core/url.js"

/**
 * Deduplicates search results by their normalized/canonical URL. The first
 * occurrence wins; later mirrors are dropped. Empty canonical URLs are kept
 * only if no other result shares the same title.
 */
export function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, number>()
  const deduped: SearchResult[] = []
  for (const result of results) {
    const key = canonicalUrl(result.url)
    if (key === "") {
      const titleKey = result.title.trim().toLowerCase()
      if (seen.has(titleKey)) continue
      seen.set(titleKey, deduped.length)
      deduped.push(result)
      continue
    }
    const existing = seen.get(key)
    if (existing !== undefined) {
      const prev = deduped[existing]
      if (prev && !prev.snippet && result.snippet) deduped[existing] = result
      continue
    }
    seen.set(key, deduped.length)
    deduped.push(result)
  }
  return deduped
}

/** Collapses a `domains` filter into part of a cache key. */
export function requestCacheKey(request: {
  query: string
  limit?: number
  domains?: string[]
  language?: string
}): string {
  const { query, limit = 8, domains = [], language = "en" } = request
  const domainPart = domains.length ? `|${[...domains].sort().join(",")}` : ""
  return `${language}:${limit}:${domainPart}:${query.trim().toLowerCase()}`
}

export const DEFAULT_SEARCH_LIMIT = 8
