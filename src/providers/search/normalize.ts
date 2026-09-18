import type { SearchResult } from "./search-provider.js"

/** Query parameters that are pure tracking noise and can be dropped safely. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "ref",
  "source",
  "spm",
  "sc_campaign",
  "sc_channel",
])

function stripTrailingSlash(path: string): string {
  if (path.length <= 1) return path
  return path.replace(/\/+$/, "")
}

/**
 * Deterministically normalizes a URL:
 * scheme+host lowercased, fragment removed, tracking parameters dropped,
 * duplicate-resolving query parameters removed, trailing slash trimmed.
 * Returns an empty string for clearly invalid URLs.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? "").trim()
  if (trimmed === "") return ""
  try {
    const url = new URL(trimmed)
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ""

    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key)
    }

    const out = new URL(url.toString())
    out.pathname = stripTrailingSlash(out.pathname)
    // Remove obvious duplicate-value query params (e.g. ?id=1&id=2 keeps the first).
    const seen = new Set<string>()
    for (const key of [...out.searchParams.keys()]) {
      if (key in seen) {
        out.searchParams.delete(key)
        continue
      }
      seen.add(key)
    }

    return out.toString().replace(/\/$/, "")
  } catch {
    // Not parseable as a URL — strip fragments and trailing slashes textually.
    const noFragment = trimmed.split("#")[0] ?? ""
    return noFragment.replace(/\/+$/, "")
  }
}

/** Best-effort canonical identity of a URL after normalization. */
export function canonicalUrl(raw: string): string {
  return normalizeUrl(raw)
}

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
