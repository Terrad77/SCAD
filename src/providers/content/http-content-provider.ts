import type { ContentProvider, ContentRequest, ContentResult } from "./content-provider.js"
import { fetchWithRetry, type RetryOptions } from "../http.js"
import { extractPlainText, extractTitle } from "./html-text.js"

export interface HttpContentProviderOptions {
  timeoutMs?: number
  maxRetries?: number
  defaultMaxBytes?: number
  fetch?: typeof fetch
  /** DNS resolver for SSRF re-validation (tests must inject this to stay offline). */
  resolveHostname?: (hostname: string) => Promise<string>
}

const BINARY_CONTENT_RE = /^application\/(pdf|octet-stream)|^image\/|^audio\/|^video\//
/** Raw HTML is larger than the extracted text, so the body cap is padded. */
const RAW_BODY_MULTIPLIER = 4
const RAW_BODY_PADDING = 2_048

/**
 * Fetches a source URL over HTTP and extracts readable text. Timeout, retry
 * and 5xx/429 handling come from `fetchWithRetry`. Redirects are followed
 * manually with SSRF re-validation on every hop; the raw HTML body is capped
 * before parsing. Binary payloads and fetch failures raise errors that
 * callers catch and turn into snippet-only fallback.
 */
export class HttpContentProvider implements ContentProvider {
  readonly name = "http"

  constructor(private readonly options: HttpContentProviderOptions = {}) {}

  async fetchContent(request: ContentRequest): Promise<ContentResult> {
    const maxBytes = request.maxBytes ?? this.options.defaultMaxBytes ?? 8_000
    const retryOptions: RetryOptions = {
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      fetch: this.options.fetch,
      maxBodyBytes: maxBytes * RAW_BODY_MULTIPLIER + RAW_BODY_PADDING,
      manualRedirects: true,
      ...(this.options.resolveHostname ? { resolveHostname: this.options.resolveHostname } : {}),
    }
    const result = await fetchWithRetry(
      request.url,
      { headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.8" } },
      retryOptions,
    )
    const contentType = result.headers.get("content-type") ?? ""
    const fetchedAt = new Date().toISOString()
    if (result.truncated) {
      return { url: request.url, text: "", fetchedAt, truncated: true, contentType }
    }
    if (BINARY_CONTENT_RE.test(contentType)) {
      return { url: request.url, text: "", fetchedAt, truncated: false, contentType }
    }
    const text = extractPlainText(result.body)
    const truncated = text.length > maxBytes
    return {
      url: request.url,
      title: extractTitle(result.body),
      text: text.slice(0, maxBytes),
      fetchedAt,
      truncated,
      contentType,
    }
  }
}

export function isBinaryContentType(contentType: string): boolean {
  return BINARY_CONTENT_RE.test(contentType)
}
