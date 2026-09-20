import { describe, it, expect, vi } from "vitest"
import {
  fetchWithRetry,
  HttpRequestError,
  assertSafeHttpUrl,
  isUnsafeAddress,
} from "../src/providers/http.js"

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface FakeResponse {
  status: number
  body: string
  headers?: Headers
}

/** Builds a fake global-style fetcher from a response handler. */
function fakeFetch(handler: (url: string, init: RequestInit) => Promise<FakeResponse>): Fetcher {
  const impl: Fetcher = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString()
    const result = await handler(url, init ?? {})
    return new Response(result.body, { status: result.status, headers: result.headers })
  }
  return impl
}

const jsonHeaders = (): Headers => new Headers({ "content-type": "application/json" })

const abortError = () => new DOMException("aborted", "AbortError")

describe("fetchWithRetry", () => {
  it("returns the body and status for a successful request", async () => {
    const fetch = fakeFetch(async () => ({ status: 200, body: "ok", headers: new Headers() }))
    const result = await fetchWithRetry("https://example.com", { method: "GET" }, { fetch })
    expect(result.status).toBe(200)
    expect(result.body).toBe("ok")
  })

  it("retries once on 429 and succeeds on the second attempt", async () => {
    const calls = vi.fn()
    const fetch = fakeFetch(async () => {
      calls()
      if (calls.mock.calls.length === 1) {
        return { status: 429, body: "slow down", headers: new Headers({ "retry-after": "0" }) }
      }
      return { status: 200, body: "finally", headers: new Headers() }
    })
    const result = await fetchWithRetry(
      "https://example.com",
      {},
      { fetch, maxRetries: 2, baseDelayMs: 1 },
    )
    expect(result.status).toBe(200)
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it("honors a retry-after header above the backoff delay", async () => {
    const fetch = fakeFetch(async () => ({
      status: 503,
      body: "",
      headers: new Headers({ "retry-after": "1" }),
    }))
    const started = Date.now()
    await expect(
      fetchWithRetry("https://example.com", {}, { fetch, maxRetries: 1, baseDelayMs: 1 }),
    ).rejects.toThrow(Error)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it("throws HttpRequestError after exhausting retryable 5xx responses", async () => {
    const fetch = fakeFetch(async () => ({ status: 500, body: "boom", headers: new Headers() }))
    const error = await fetchWithRetry(
      "https://example.com",
      {},
      { fetch, maxRetries: 2, baseDelayMs: 1 },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpRequestError)
    const httpError = error as HttpRequestError
    expect(httpError.status).toBe(500)
    expect(httpError.retriable).toBe(true)
    expect(httpError.message).toContain("retries exhausted")
  })

  it("fails immediately on a non-retryable 4xx", async () => {
    const fetch = fakeFetch(async () => ({
      status: 400,
      body: "bad request",
      headers: new Headers(),
    }))
    const error = await fetchWithRetry("https://example.com", {}, { fetch }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpRequestError)
    expect((error as HttpRequestError).retriable).toBe(false)
    expect((error as HttpRequestError).message).toContain("HTTP 400")
  })

  it("times out after the configured timeout and reports it", async () => {
    const fetch: Fetcher = async (_input, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()))
      })
      throw abortError()
    }
    const error = await fetchWithRetry(
      "https://example.com",
      {},
      { fetch, timeoutMs: 20, maxRetries: 1, baseDelayMs: 1 },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpRequestError)
    expect((error as HttpRequestError).status).toBeNull()
    expect((error as HttpRequestError).message).toContain("timed out")
  })

  it("retries transient network errors then surfaces the transport failure", async () => {
    const calls = vi.fn()
    const fetch: Fetcher = async () => {
      calls()
      if (calls.mock.calls.length < 3) throw new TypeError("fetch failed")
      return new Response("ok", { status: 200 })
    }
    const result = await fetchWithRetry(
      "https://example.com",
      {},
      { fetch, timeoutMs: 500, maxRetries: 3, baseDelayMs: 1 },
    )
    expect(result.body).toBe("ok")
    expect(calls).toHaveBeenCalledTimes(3)
  })

  it("surfaces a persistent network error as HttpRequestError", async () => {
    const fetch: Fetcher = async () => {
      throw new TypeError("network down")
    }
    const error = await fetchWithRetry(
      "https://example.com",
      {},
      { fetch, maxRetries: 1, baseDelayMs: 1 },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpRequestError)
    expect((error as HttpRequestError).status).toBeNull()
    expect((error as HttpRequestError).message).toContain("network error")
  })

  it("passes a JSON body through unchanged", async () => {
    const json = JSON.stringify({ a: 1 })
    const fetch = fakeFetch(async () => ({ status: 200, body: json, headers: jsonHeaders() }))
    const result = await fetchWithRetry("https://example.com", {}, { fetch })
    expect(JSON.parse(result.body)).toEqual({ a: 1 })
  })
})

describe("SSRF guard", () => {
  const resolvePublic = async (): Promise<string> => "93.184.216.34"

  it("accepts public http(s) destinations", async () => {
    const url = await assertSafeHttpUrl("https://example.com/page", resolvePublic)
    expect(url.origin).toBe("https://example.com")
  })

  it("rejects loopback and private IP literals", async () => {
    for (const value of [
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://172.16.0.1/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/x",
      "http://100.64.0.1/x",
      "http://[::1]/x",
      "http://0.0.0.0/x",
    ]) {
      await expect(assertSafeHttpUrl(value, resolvePublic)).rejects.toThrow(/SSRF/)
    }
  })

  it("rejects localhost without touching DNS", async () => {
    const dns = vi.fn(async (): Promise<string> => "93.184.216.34")
    await expect(assertSafeHttpUrl("http://localhost/x", dns)).rejects.toThrow(/SSRF/)
    expect(dns).not.toHaveBeenCalled()
  })

  it("rejects private addresses returned by DNS lookup", async () => {
    await expect(
      assertSafeHttpUrl("http://internal.lan/x", async () => "10.1.2.3"),
    ).rejects.toThrow(/SSRF/)
  })

  it("rejects non-http schemes", async () => {
    await expect(assertSafeHttpUrl("file:///etc/passwd")).rejects.toThrow(/scheme/)
    await expect(assertSafeHttpUrl("ftp://host/x")).rejects.toThrow(/scheme/)
  })

  it("classifies IPv4-mapped IPv6 addresses", () => {
    expect(isUnsafeAddress("::ffff:169.254.169.254")).toBe(true)
    expect(isUnsafeAddress("::ffff:10.0.0.5")).toBe(true)
    expect(isUnsafeAddress("::ffff:93.184.216.34")).toBe(false)
    expect(isUnsafeAddress("::")).toBe(true)
    expect(isUnsafeAddress("fe80::1")).toBe(true)
    expect(isUnsafeAddress("fc00::1")).toBe(true)
  })
})

describe("fetchWithRetry manual redirects + body cap", () => {
  const resolvePublic = async (): Promise<string> => "93.184.216.34"

  it("follows a redirect chain with per-hop re-validation", async () => {
    const calls: string[] = []
    const fetch: Fetcher = async (input) => {
      const url = typeof input === "string" ? input : input.toString()
      calls.push(url)
      if (url === "https://example.com/start") {
        return new Response("", { status: 302, headers: { location: "https://example.com/final" } })
      }
      return new Response("done", { status: 200 })
    }
    const result = await fetchWithRetry(
      "https://example.com/start",
      {},
      { fetch, manualRedirects: true, resolveHostname: resolvePublic },
    )
    expect(result.body).toBe("done")
    expect(calls).toEqual(["https://example.com/start", "https://example.com/final"])
  })

  it("rejects a redirect that lands on a private address", async () => {
    const fetch: Fetcher = async () =>
      new Response("", { status: 302, headers: { location: "http://169.254.169.254/meta" } })
    const error = await fetchWithRetry(
      "https://example.com/start",
      {},
      { fetch, manualRedirects: true, resolveHostname: resolvePublic },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpRequestError)
    expect((error as HttpRequestError).message).toContain("SSRF")
  })

  it("enforces the redirect limit", async () => {
    let calls = 0
    const fetch: Fetcher = async () => {
      calls += 1
      return new Response("", {
        status: 302,
        headers: { location: `https://example.com/${calls}` },
      })
    }
    await expect(
      fetchWithRetry(
        "https://example.com/1",
        {},
        { fetch, manualRedirects: true, resolveHostname: resolvePublic },
      ),
    ).rejects.toThrow(/too many redirects/)
  })

  it("caps the response body and flags truncation", async () => {
    const fetch = fakeFetch(async () => ({
      status: 200,
      body: "x".repeat(1000),
      headers: new Headers(),
    }))
    const result = await fetchWithRetry("https://example.com", {}, { fetch, maxBodyBytes: 100 })
    expect(result.truncated).toBe(true)
    expect(result.body.length).toBeLessThanOrEqual(100)
  })

  it("bails out early when content-length already exceeds the cap", async () => {
    const fetch = fakeFetch(async () => ({
      status: 200,
      body: "y".repeat(500),
      headers: new Headers({ "content-length": "500" }),
    }))
    const result = await fetchWithRetry("https://example.com", {}, { fetch, maxBodyBytes: 10 })
    expect(result.truncated).toBe(true)
    expect(result.body).toBe("")
  })
})
