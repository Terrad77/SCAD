import type { SearchProvider, SearchRequest, SearchResult } from "./search-provider.js"
import { requestCacheKey, DEFAULT_SEARCH_LIMIT } from "./normalize.js"
import type { CacheStore } from "../cache/file-cache.js"

/** Cache store for repeated search queries (keyed by a stable query hash). */
export interface SearchCache {
  get(key: string): Promise<SearchResult[] | null>
  set(key: string, results: SearchResult[]): Promise<void>
}

/** In-memory cache — useful within a single run. */
export class MemorySearchCache implements SearchCache {
  private readonly map = new Map<string, SearchResult[]>()
  async get(key: string): Promise<SearchResult[] | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, results: SearchResult[]): Promise<void> {
    this.map.set(key, results)
  }
}

/**
 * Wraps a search provider with deterministic query caching to avoid repeated
 * network/API calls and make development reproducible. The cache key is a
 * stable serialization of the request.
 */
export class CachedSearchProvider implements SearchProvider {
  readonly name: string
  private readonly hitLog: string[] = []

  constructor(
    private readonly inner: SearchProvider,
    private readonly cache: SearchCache = new MemorySearchCache(),
  ) {
    this.name = inner.name
  }

  get hits(): string[] {
    return [...this.hitLog]
  }

  async search(request: SearchRequest): Promise<SearchResult[]> {
    const key = requestCacheKey({ ...request, limit: request.limit ?? DEFAULT_SEARCH_LIMIT })
    const cached = await this.cache.get(key)
    if (cached !== null) return cached
    const results = await this.inner.search(request)
    this.hitLog.push(key)
    await this.cache.set(key, results)
    return results
  }

  /** Clears the internal hit log (used by tests to assert cache behavior). */
  resetLog(): void {
    this.hitLog.length = 0
  }
}

/**
 * Search cache persisted as JSON files on disk. Keys are prefixed by the
 * enclosing provider name so two providers never share a query entry.
 */
export class FileSearchCache implements SearchCache {
  constructor(
    private readonly backing: CacheStore,
    private readonly providerName = "search",
  ) {}

  async get(key: string): Promise<SearchResult[] | null> {
    const value = await this.backing.get<SearchResult[]>(`${this.providerName}:${key}`)
    return Array.isArray(value) ? value : null
  }

  async set(key: string, results: SearchResult[]): Promise<void> {
    await this.backing.set(`${this.providerName}:${key}`, results)
  }
}
