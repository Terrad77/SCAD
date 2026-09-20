/**
 * Shared HTTP transport for SCAD provider integrations.
 *
 * All real providers (Brave, OpenAI, Anthropic, content fetch) go through
 * `fetchWithRetry` so timeout, retry and error handling behave identically:
 *
 * - a single timeout per attempt (AbortSignal),
 * - exponential backoff between attempts,
 * - 429 / 5xx are retried up to `maxRetries`,
 * - `Retry-After` is honored when the server sends it,
 * - non-retryable 4xx raises `HttpRequestError` immediately,
 * - network/timeout failures are retried, then surface as `HttpRequestError`.
 *
 * The content-fetch path additionally opts into `manualRedirects`, which
 * re-validates every redirect hop against the SSRF guard (`assertSafeHttpUrl`),
 * and caps the response body read size with `maxBodyBytes`.
 */

import { lookup } from "node:dns/promises"

export class HttpRequestError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: string | null,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message)
    this.name = "HttpRequestError"
  }
}

export interface RetryOptions {
  /** Per-attempt timeout in milliseconds (default 30_000). */
  timeoutMs?: number
  /** Number of retry attempts after the first try (default 3). */
  maxRetries?: number
  /** Delay before the first retry in milliseconds (default 500). */
  baseDelayMs?: number
  /** Backoff multiplier per additional retry (default 2). */
  backoffFactor?: number
  /** Fetcher override for tests (default `globalThis.fetch`). */
  fetch?: typeof fetch
  /** Status codes that are worth retrying (default 408/429/500/502/503/504). */
  retryableStatuses?: ReadonlySet<number>
  /** Response body read cap in bytes; larger bodies are truncated. */
  maxBodyBytes?: number
  /**
   * When true, redirects are followed manually so each hop is re-validated
   * by the SSRF guard. When false (default), `fetch` follows redirects natively
   * and no DNS/SSRF validation is performed.
   */
  manualRedirects?: boolean
  /** DNS resolver used by SSRF checks (default `dns/promises.lookup`); tests inject this. */
  resolveHostname?: ResolveHostname
}

export interface HttpResult {
  status: number
  body: string
  headers: Headers
  /** True when the body was cut short by `maxBodyBytes`. */
  truncated: boolean
}

export type ResolveHostname = (hostname: string) => Promise<string>

const DEFAULT_RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

const DEFAULT_RESOLVE_HOSTNAME: ResolveHostname = async (hostname) => {
  try {
    return (await lookup(hostname, { family: 0 })).address
  } catch {
    return ""
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Performs an HTTP request with timeout, exponential backoff and retry on
 * transient failures. Resolves with the raw text body so callers validate the
 * payload themselves; throws `HttpRequestError` on persistent failure.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 500
  const backoffFactor = options.backoffFactor ?? 2
  const retryable = options.retryableStatuses ?? DEFAULT_RETRYABLE
  const manualRedirects = options.manualRedirects ?? false
  const resolveHostname = options.resolveHostname ?? DEFAULT_RESOLVE_HOSTNAME
  const fetchImpl =
    options.fetch ?? ((input: RequestInfo | URL, init2?: RequestInit) => fetch(input, init2))

  let attempt = 0
  for (;;) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await performFetch(url, init, {
        fetchImpl,
        signal: controller.signal,
        manualRedirects,
        resolveHostname,
      })
      const { body, truncated } = await readBodyCapped(response, options.maxBodyBytes)
      const status = response.status
      if (status >= 200 && status < 300) {
        return { status, body, headers: response.headers, truncated }
      }
      if (retryable.has(status) && attempt < maxRetries) {
        await delayForAttempt(status, response.headers, baseDelayMs, backoffFactor, attempt)
        attempt += 1
        continue
      }
      throw new HttpRequestError(
        status,
        body,
        retryable.has(status),
        retryable.has(status)
          ? `HTTP ${status} (retryable, ${maxRetries} retries exhausted)`
          : `HTTP ${status}${body ? `: ${trimForMessage(body)}` : ""}`,
      )
    } catch (error) {
      if (error instanceof HttpRequestError) throw error
      const timedOut = error instanceof Error && error.name === "AbortError"
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * backoffFactor ** attempt)
        attempt += 1
        continue
      }
      throw new HttpRequestError(
        null,
        null,
        true,
        timedOut ? `request timed out after ${timeoutMs}ms` : `network error: ${String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

interface FetchDeps {
  fetchImpl: (input: RequestInfo | URL, init2?: RequestInit) => Promise<Response>
  signal: AbortSignal
  manualRedirects: boolean
  resolveHostname: ResolveHostname
}

/** Single attempt: plain fetch, or a manual redirect walk with SSRF re-validation. */
async function performFetch(
  url: string | URL,
  init: RequestInit,
  deps: FetchDeps,
): Promise<Response> {
  if (!deps.manualRedirects) {
    return deps.fetchImpl(url, { ...init, signal: deps.signal })
  }
  let current = new URL(url)
  for (let hop = -1; ; hop += 1) {
    await assertSafeHttpUrl(current, deps.resolveHostname)
    const response = await deps.fetchImpl(current, {
      ...init,
      redirect: "manual",
      signal: deps.signal,
    })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get("location")
    if (location === null) return response
    if (hop >= MAX_REDIRECTS) {
      throw new HttpRequestError(
        response.status,
        null,
        true,
        `too many redirects (limit ${MAX_REDIRECTS})`,
      )
    }
    current = new URL(location, current)
  }
}

/** Reads a response body, capping the byte size when asked. */
async function readBodyCapped(
  response: Response,
  maxBytes: number | undefined,
): Promise<{ body: string; truncated: boolean }> {
  if (maxBytes === undefined) {
    return { body: await readBody(response), truncated: false }
  }
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { body: "", truncated: true }
  }
  if (!response.body) {
    return { body: await readBody(response), truncated: false }
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - size
    if (value.byteLength > remaining) {
      parts.push(value.slice(0, remaining))
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    parts.push(value)
    size += value.byteLength
  }
  return { body: Buffer.concat(parts).toString("utf8"), truncated }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

/** Backoff delay for a retryable status, honoring `Retry-After`. */
async function delayForAttempt(
  status: number,
  headers: Headers,
  baseDelayMs: number,
  backoffFactor: number,
  attempt: number,
): Promise<void> {
  let delay = baseDelayMs * backoffFactor ** attempt
  if (status === 429 || status === 503) {
    const retryAfter = headers.get("retry-after")
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) delay = Math.max(delay, seconds * 1000)
  }
  await sleep(delay)
}

function trimForMessage(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim()
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed
}

/**
 * SSRF guard: rejects non-http(s) schemes and destinations whose hostname
 * resolves to a loopback, private, link-local, reserved or multicast address.
 * Returns the parsed URL when the destination is considered safe.
 */
export async function assertSafeHttpUrl(
  url: string | URL,
  resolveHostname: ResolveHostname = DEFAULT_RESOLVE_HOSTNAME,
): Promise<URL> {
  const parsed = typeof url === "string" ? new URL(url) : new URL(url.toString())
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpRequestError(
      null,
      null,
      false,
      `SSRF guard: unsupported scheme "${parsed.protocol}" (http/https only)`,
    )
  }
  const hostname = parsed.hostname.toLowerCase()
  const literal = hostnameAsIp(hostname)
  const ip = literal ?? (hostname === "localhost" ? "127.0.0.1" : await resolveHostname(hostname))
  if (ip && isUnsafeAddress(ip)) {
    throw new HttpRequestError(
      null,
      null,
      false,
      `SSRF guard: "${hostname}" resolves to a private/reserved address (${ip})`,
    )
  }
  return parsed
}

/** True for loopback, private, link-local, reserved and multicast IP addresses. */
export function isUnsafeAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const oct1 = Number(v4[1])
    const oct2 = Number(v4[2])
    if (oct1 === 0 || oct1 === 10 || oct1 === 127) return true
    if (oct1 === 100 && oct2 >= 64 && oct2 <= 127) return true
    if (oct1 === 169 && oct2 === 254) return true
    if (oct1 === 192 && oct2 === 168) return true
    if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) return true
    if (oct1 >= 224) return true
    return false
  }
  const v6 = ip.toLowerCase()
  if (v6 === "::" || v6 === "::1") return true
  if (v6.startsWith("::ffff:")) return isUnsafeAddress(v6.slice("::ffff:".length))
  const hextet = v6.split(":")[0] ?? ""
  if (hextet.startsWith("fc") || hextet.startsWith("fd")) return true // fc00::/7
  if (/^fe[89ab]/.test(hextet)) return true // fe80::/10
  return false
}

function hostnameAsIp(hostname: string): string | null {
  const inner =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(inner)) return inner
  if (inner.includes(":")) return inner.toLowerCase()
  return null
}
