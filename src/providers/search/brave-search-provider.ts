import type { SearchProvider, SearchRequest, SearchResult } from "./search-provider.js"
import { fetchWithRetry, type RetryOptions } from "../http.js"

export interface BraveSearchProviderOptions {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof fetch
}

/** Brave web search result shape (a subset; unknown fields are ignored). */
export interface BraveWebResult {
  title?: string
  url?: string
  description?: string
  age?: string
  page_age?: string
  language?: string
  profile?: { name?: string; long_name?: string; url?: string }
  extra_snippets?: string[]
}

export interface BraveApiPayload {
  web?: { results?: BraveWebResult[] }
}

/**
 * Real web search via the Brave Search API. Used by the research engine when
 * `SEARCH_PROVIDER=brave` and `BRAVE_SEARCH_API_KEY` are configured.
 * Network behavior (timeout, retries, 429/5xx) is handled by `fetchWithRetry`.
 */
export class BraveSearchProvider implements SearchProvider {
  readonly name = "brave"

  constructor(private readonly options: BraveSearchProviderOptions = {}) {}

  async search(request: SearchRequest): Promise<SearchResult[]> {
    const apiKey = this.options.apiKey ?? process.env.BRAVE_SEARCH_API_KEY
    if (!apiKey) {
      throw new Error("BraveSearchProvider requires an API key (BRAVE_SEARCH_API_KEY)")
    }
    const base = (
      this.options.baseUrl ??
      process.env.BRAVE_BASE_URL ??
      "https://api.search.brave.com/res/v1/web/search"
    ).replace(/\/$/, "")

    const url = new URL(base)
    url.searchParams.set("q", request.query)
    url.searchParams.set("count", String(request.limit ?? 8))
    if (request.language) url.searchParams.set("search_lang", request.language)
    if (request.domains && request.domains.length > 0) {
      url.searchParams.set("extra_snippets", "true")
      // Brave has no native multiple-domain filter; hint via query qualifiers.
      url.searchParams.set("q", `${request.query} site:${request.domains.join(" OR site:")}`)
    }

    const options: RetryOptions = {
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      fetch: this.options.fetch,
    }
    const result = await fetchWithRetry(
      url,
      { headers: { accept: "application/json", "x-subscription-token": apiKey } },
      options,
    )

    let payload: unknown
    try {
      payload = JSON.parse(result.body) as unknown
    } catch {
      throw new Error(`Brave returned non-JSON response (HTTP ${result.status})`)
    }
    const results = parseBraveResponse(payload)
    return results.slice(0, request.limit ?? 8)
  }
}

/**
 * Validates and normalizes a Brave API payload into SCAD `SearchResult`s.
 * Extraction is defensive: malformed entries are dropped, never thrown on.
 * A response with no usable `web.results` is an error, not empty success.
 */
export function parseBraveResponse(payload: unknown): SearchResult[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Brave response is not a JSON object")
  }
  const api = payload as BraveApiPayload
  if (typeof api.web !== "object" || api.web === null || !Array.isArray(api.web.results)) {
    throw new Error("Brave response is missing web.results")
  }

  const results: SearchResult[] = []
  for (const entry of api.web.results) {
    const title = entry.title
    const url = entry.url
    if (typeof title !== "string" || title.length === 0) continue
    if (typeof url !== "string" || url.length === 0) continue
    results.push({
      id: url,
      title,
      url,
      snippet: typeof entry.description === "string" ? entry.description : undefined,
      source:
        typeof entry.profile?.name === "string"
          ? entry.profile.name
          : typeof entry.profile?.long_name === "string"
            ? entry.profile.long_name
            : undefined,
      publishedAt: extractPublishedAt(entry),
    })
  }

  if (results.length === 0) {
    throw new Error("Brave response contained no usable web results")
  }
  return results
}

/** Brave exposes `page_age` (date-ish) or `age` (human readable) — best effort. */
function extractPublishedAt(entry: BraveWebResult): string | undefined {
  const candidates = [entry.page_age, entry.age]
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue
    if (/^\d{4}-\d{2}-\d{2}/.test(candidate)) return candidate.slice(0, 10)
  }
  return undefined
}
