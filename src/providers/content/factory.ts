import type { ContentProvider } from "./content-provider.js"
import { NoopContentProvider } from "./content-provider.js"
import { HttpContentProvider } from "./http-content-provider.js"
import { MockContentProvider } from "./mock-content-provider.js"

/**
 * Builds the content provider used by the research engine. Selected by the
 * `CONTENT_PROVIDER` environment variable: `noop` (default, offline), `mock`
 * (deterministic fixtures) or `http` (real page fetch + text extraction).
 */
export function createContentProvider(config?: { provider?: string }): ContentProvider {
  const providerName = (config?.provider ?? process.env.CONTENT_PROVIDER ?? "noop").toLowerCase()
  switch (providerName) {
    case "http":
      return new HttpContentProvider()
    case "mock":
      return new MockContentProvider()
    case "noop":
    case "none":
    default:
      return new NoopContentProvider()
  }
}
