/**
 * Search provider abstraction for the Evidence & Research Engine.
 *
 * SCAD must never depend on a single search vendor. Web search, Google, Bing,
 * Brave, Tavily, SerpAPI and custom APIs can all implement `SearchProvider`
 * and be selected through the factory (`SEARCH_PROVIDER`).
 */
export interface SearchRequest {
  query: string
  limit?: number
  domains?: string[]
  language?: string
}

export interface SearchResult {
  id: string
  title: string
  url: string
  snippet?: string
  source?: string
  publishedAt?: string
}

export interface SearchProvider {
  readonly name: string
  search(request: SearchRequest): Promise<SearchResult[]>
}

/** No-op provider used when no real search backend is configured. */
export class NoopSearchProvider implements SearchProvider {
  readonly name = "noop"
  async search(_request: SearchRequest): Promise<SearchResult[]> {
    return []
  }
}

export function isSearchResult(value: unknown): value is SearchResult {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.url === "string" &&
    (v.snippet === undefined || typeof v.snippet === "string")
  )
}
