import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  BraveSearchProvider,
  parseBraveResponse,
} from "../src/providers/search/brave-search-provider.js"
import { HttpRequestError } from "../src/providers/http.js"

function bravePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { web: { results: [] }, ...over }
}

function braveResult(over: Record<string, string> = {}): Record<string, unknown> {
  return {
    title: "Neanderthal genome sequencing",
    url: "https://example.com/neanderthal",
    description: "Non-Africans carry 1-4% Neanderthal ancestry.",
    age: "2023-05-14",
    profile: { name: "Nature", long_name: "Nature", url: "https://example.com/nature" },
    ...over,
  }
}

describe("parseBraveResponse", () => {
  it("maps web.results to SCAD search results", () => {
    const results = parseBraveResponse(bravePayload({ web: { results: [braveResult()] } }))
    expect(results).toHaveLength(1)
    expect(results[0]!.title).toBe("Neanderthal genome sequencing")
    expect(results[0]!.url).toBe("https://example.com/neanderthal")
    expect(results[0]!.snippet).toContain("Non-Africans carry")
    expect(results[0]!.source).toBe("Nature")
    expect(results[0]!.publishedAt).toBe("2023-05-14")
  })

  it("drops entries without a usable title or url", () => {
    const payload = {
      web: {
        results: [braveResult(), { title: "", url: "https://example.com/x" }, { title: "No url" }],
      },
    }
    const results = parseBraveResponse(payload)
    expect(results).toHaveLength(1)
  })

  it("throws when web.results is missing", () => {
    expect(() => parseBraveResponse({ web: {} })).toThrow(/web.results/)
  })

  it("throws when the payload is not an object", () => {
    expect(() => parseBraveResponse("nope")).toThrow(/JSON object/)
  })

  it("throws when no usable results exist", () => {
    expect(() => parseBraveResponse(bravePayload())).toThrow(/no usable web results/)
  })
})

describe("BraveSearchProvider", () => {
  const previousKey = process.env.BRAVE_SEARCH_API_KEY

  beforeEach(() => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key"
  })

  afterEach(() => {
    if (previousKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY
    else process.env.BRAVE_SEARCH_API_KEY = previousKey
    vi.restoreAllMocks()
  })

  function stubFetch(handler: (url: string) => Promise<{ status: number; body: string }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        const result = await handler(url)
        return new Response(result.body, { status: result.status })
      }),
    )
  }

  it("requires an API key", async () => {
    delete process.env.BRAVE_SEARCH_API_KEY
    const provider = new BraveSearchProvider()
    await expect(provider.search({ query: "speciation", limit: 5 })).rejects.toThrow(/API key/)
  })

  it("calls the Brave endpoint and returns parsed results", async () => {
    let called = ""
    stubFetch((url) => {
      called = url
      return Promise.resolve({
        status: 200,
        body: JSON.stringify(bravePayload({ web: { results: [braveResult()] } })),
      })
    })
    const provider = new BraveSearchProvider({ apiKey: "abc" })
    const results = await provider.search({ query: "speciation", limit: 5 })
    expect(called).toContain("api.search.brave.com")
    expect(called).toContain("q=speciation")
    expect(called).toContain("count=5")
    expect(results[0]!.title).toBe("Neanderthal genome sequencing")
  })

  it("rejects invalid JSON payloads", async () => {
    stubFetch(() => Promise.resolve({ status: 200, body: "<html>not json</html>" }))
    const provider = new BraveSearchProvider({ apiKey: "abc" })
    await expect(provider.search({ query: "x" })).rejects.toThrow(/non-JSON/)
  })

  it("propagates non-retryable HTTP errors", async () => {
    stubFetch(() => Promise.resolve({ status: 401, body: "{}" }))
    const provider = new BraveSearchProvider({ apiKey: "abc" })
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      status: 401,
      retriable: false,
    })
  })

  it("fails cleanly when the upstream is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )
    const provider = new BraveSearchProvider({ apiKey: "abc", maxRetries: 1 })
    const error = await provider.search({ query: "x" }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpRequestError)
  })
})
