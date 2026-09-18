import type { SearchProvider } from "./search-provider.js"
import { NoopSearchProvider } from "./search-provider.js"
import { MockSearchProvider } from "./mock-search-provider.js"
import { MemorySearchCache, CachedSearchProvider } from "./cached-search-provider.js"

/**
 * Builds the search provider used by the pipeline. The provider is selected by
 * the `SEARCH_PROVIDER` environment variable (`mock` is the default and works
 * fully offline). Future values: `tavily`, `brave`, `google`, etc.
 */
export function createSearchProvider(config?: {
  provider?: string
  cache?: boolean
}): SearchProvider {
  const providerName = (config?.provider ?? process.env.SEARCH_PROVIDER ?? "mock").toLowerCase()

  let base: SearchProvider
  switch (providerName) {
    case "mock":
      base = new MockSearchProvider()
      break
    case "noop":
    case "none":
      base = new NoopSearchProvider()
      break
    default:
      // The task only ships `mock` and `noop`. Unknown providers fall back to
      // mock so the CLI still works offline instead of hard-failing.
      base = new MockSearchProvider()
  }

  const wantCache = config?.cache ?? process.env.SCAD_SEARCH_CACHE !== "0"
  return wantCache ? new CachedSearchProvider(base, new MemorySearchCache()) : base
}
