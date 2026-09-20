import type { ContentProvider, ContentRequest, ContentResult } from "./content-provider.js"
import type { CacheStore } from "../cache/file-cache.js"
import { canonicalUrl } from "../../core/url.js"

/**
 * Wraps a content provider with deterministic URL caching. Extraction for the
 * same canonical URL is not repeated within the configured TTL, satisfying the
 * "no repeat extraction per canonical URL" rule.
 */
export class CachedContentProvider implements ContentProvider {
  readonly name: string

  constructor(
    private readonly inner: ContentProvider,
    private readonly cache: CacheStore,
    private readonly cachePrefix = "content",
  ) {
    this.name = inner.name
  }

  async fetchContent(request: ContentRequest): Promise<ContentResult> {
    const key = canonicalUrl(request.url)
    if (key) {
      const cached = await this.cache.get<ContentResult>(`${this.cachePrefix}:${key}`)
      if (cached) return cached
    }
    const result = await this.inner.fetchContent(request)
    if (key) await this.cache.set(`${this.cachePrefix}:${key}`, result)
    return result
  }
}
