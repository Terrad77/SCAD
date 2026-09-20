/**
 * Content extraction abstraction for the research engine.
 *
 * Search providers return snippets; a `ContentProvider` optionally fetches the
 * full page and extracts readable text so evidence extraction works on real
 * source content instead of search blurbs. Vendors can implement `HttpContentProvider`
 * or `MockContentProvider`; the abstraction keeps the engine vendor-agnostic.
 */

export interface ContentRequest {
  url: string
  /** Hard cap on extracted text length, in characters. */
  maxBytes?: number
}

export interface ContentResult {
  url: string
  title?: string
  text: string
  fetchedAt: string
  truncated: boolean
  contentType?: string
}

export interface ContentProvider {
  readonly name: string
  fetchContent(request: ContentRequest): Promise<ContentResult>
}

/**
 * No-op content provider used in offline mode. Returns empty text so evidence
 * extraction degrades to search snippets — no network, no errors.
 */
export class NoopContentProvider implements ContentProvider {
  readonly name = "noop"

  async fetchContent(request: ContentRequest): Promise<ContentResult> {
    return {
      url: request.url,
      text: "",
      fetchedAt: new Date().toISOString(),
      truncated: false,
    }
  }
}

export function isContentResult(value: unknown): value is ContentResult {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.url === "string" &&
    typeof v.text === "string" &&
    typeof v.fetchedAt === "string" &&
    typeof v.truncated === "boolean"
  )
}
