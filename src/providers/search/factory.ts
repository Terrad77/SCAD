import type { SearchProvider } from "./search-provider.js"
import { NoopSearchProvider } from "./search-provider.js"
import { MockSearchProvider } from "./mock-search-provider.js"
import {
  CachedSearchProvider,
  MemorySearchCache,
  FileSearchCache,
} from "./cached-search-provider.js"
import { BraveSearchProvider } from "./brave-search-provider.js"
import { FileCache, defaultCacheDir } from "../cache/file-cache.js"

export interface SearchFactoryConfig {
  provider?: string
  /** Disable result caching entirely (default enabled). */
  cache?: boolean
  /** Directory for JSON file cache; undefined → in-memory per run. */
  cacheDir?: string
}

/**
 * Builds the search provider used by the pipeline. The provider is selected by
 * the `SEARCH_PROVIDER` environment variable (`mock` is the default and works
 * fully offline; `brave` uses the Brave Search API; `noop` disables search).
 * When a real provider is used, results are cached to JSON files under
 * `SCAD_CACHE_DIR` so identical queries are not re-fetched.
 */
export function createSearchProvider(config?: SearchFactoryConfig): SearchProvider {
  const providerName = (config?.provider ?? process.env.SEARCH_PROVIDER ?? "mock").toLowerCase()

  let base: SearchProvider
  switch (providerName) {
    case "brave":
      base = new BraveSearchProvider()
      break
    case "mock":
      base = new MockSearchProvider()
      break
    case "noop":
    case "none":
      base = new NoopSearchProvider()
      break
    default:
      // Unknown providers fall back to mock so the CLI still works offline.
      base = new MockSearchProvider()
  }

  const wantCache = config?.cache ?? process.env.SCAD_SEARCH_CACHE !== "0"
  if (!wantCache) return base

  const cacheDir = config?.cacheDir ?? defaultCacheDir()
  if (providerName === "brave") {
    const fileCache = new FileCache({ dir: `${cacheDir}/search` })
    return new CachedSearchProvider(base, new FileSearchCache(fileCache, providerName))
  }
  // Mock results are deterministic already; an in-memory cache is enough.
  return new CachedSearchProvider(base, new MemorySearchCache())
}
