import { describe, it, expect, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  extractPlainText,
  decodeHtmlEntities,
  extractTitle,
} from "../src/providers/content/html-text.js"
import {
  HttpContentProvider,
  isBinaryContentType,
} from "../src/providers/content/http-content-provider.js"
import {
  MockContentProvider,
  MOCK_CONTENT_FIXTURES,
} from "../src/providers/content/mock-content-provider.js"
import { NoopContentProvider, isContentResult } from "../src/providers/content/content-provider.js"
import { CachedContentProvider } from "../src/providers/content/cached-content-provider.js"
import { FileCache } from "../src/providers/cache/file-cache.js"

const ABORT_ERROR = () => new DOMException("aborted", "AbortError")

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function htmlFetch(html: string, options: { contentType?: string; status?: number } = {}): Fetcher {
  return async () =>
    new Response(html, {
      status: options.status ?? 200,
      headers: { "content-type": options.contentType ?? "text/html" },
    })
}

describe("html-text", () => {
  it("strips markup and collapses whitespace", () => {
    const html =
      "<html><head><title>T</title></head><body><h1>Hello</h1><p>World&nbsp;<b>!</b></p></body></html>"
    expect(extractPlainText(html)).toBe("Hello World !")
  })

  it("removes script and style blocks", () => {
    const html = "<script>const x = 1;</script><style>.a{}</style>Visible content"
    expect(extractPlainText(html)).toBe("Visible content")
  })

  it("decodes common entities", () => {
    expect(
      decodeHtmlEntities("a &amp; b &lt; c &gt; d &quot;q&quot; &apos;x&apos; &#65; &#x42;"),
    ).toBe("a & b < c > d \"q\" 'x' A B")
  })

  it("extracts the title tag", () => {
    const html = "<html><head><title>  A &amp; Study  </title></head></html>"
    expect(extractTitle(html)).toBe("A & Study")
  })
})

describe("HttpContentProvider", () => {
  const resolvePublic = async (): Promise<string> => "93.184.216.34"

  it("fetches and extracts readable text", async () => {
    const provider = new HttpContentProvider({
      fetch: htmlFetch("<title>Page</title><p>Body text.</p>"),
      resolveHostname: resolvePublic,
    })
    const content = await provider.fetchContent({ url: "https://example.com/a" })
    expect(content.text).toBe("Page Body text.")
    expect(content.truncated).toBe(false)
  })

  it("truncates oversized content", async () => {
    const longText = "<p>" + "x".repeat(1000) + "</p>"
    const provider = new HttpContentProvider({
      fetch: htmlFetch(longText),
      resolveHostname: resolvePublic,
    })
    const content = await provider.fetchContent({ url: "https://example.com/long", maxBytes: 100 })
    expect(content.truncated).toBe(true)
    expect(content.text.length).toBe(100)
  })

  it("returns empty text for binary content types", async () => {
    const provider = new HttpContentProvider({
      fetch: htmlFetch("PDFDATA", { contentType: "application/pdf" }),
      resolveHostname: resolvePublic,
    })
    const content = await provider.fetchContent({ url: "https://example.com/a.pdf" })
    expect(content.text).toBe("")
    expect(content.contentType).toBe("application/pdf")
    expect(isBinaryContentType("application/pdf")).toBe(true)
    expect(isBinaryContentType("text/html")).toBe(false)
  })

  it("surfaces timeouts as errors", async () => {
    const hanging: Fetcher = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(ABORT_ERROR()))
      })
    const provider = new HttpContentProvider({
      fetch: hanging,
      timeoutMs: 20,
      maxRetries: 0,
      resolveHostname: resolvePublic,
    })
    await expect(provider.fetchContent({ url: "https://example.com/slow" })).rejects.toThrow(
      /timed out/,
    )
  })

  it("rejects loopback and private-address destinations (SSRF guard)", async () => {
    const provider = new HttpContentProvider({
      fetch: htmlFetch("<p>x</p>"),
      resolveHostname: resolvePublic,
    })
    for (const url of [
      "http://127.0.0.1/internal",
      "http://localhost/internal",
      "http://169.254.169.254/meta",
      "http://192.168.1.1/admin",
    ]) {
      await expect(provider.fetchContent({ url })).rejects.toThrow(/SSRF/)
    }
  })
})

describe("MockContentProvider", () => {
  it("returns fixture text deterministically", async () => {
    const provider = new MockContentProvider()
    const url = Object.keys(MOCK_CONTENT_FIXTURES)[0]!
    const first = await provider.fetchContent({ url })
    const second = await provider.fetchContent({ url })
    expect(second).toEqual(first)
    expect(second.text.length).toBeGreaterThan(0)
  })

  it("returns empty text for unknown URLs", async () => {
    const provider = new MockContentProvider()
    const content = await provider.fetchContent({ url: "https://example.com/unknown" })
    expect(content.text).toBe("")
    expect(content.url).toBe("https://example.com/unknown")
  })
})

describe("NoopContentProvider", () => {
  it("produces empty content and validates as a ContentResult", async () => {
    const provider = new NoopContentProvider()
    const content = await provider.fetchContent({ url: "https://example.com/x" })
    expect(content.text).toBe("")
    expect(isContentResult(content)).toBe(true)
  })
})

describe("CachedContentProvider", () => {
  it("fetches each canonical URL only once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-content-cache-"))
    try {
      const inner = vi.fn(async () => ({
        url: "https://example.com/a",
        text: "extracted once",
        fetchedAt: new Date().toISOString(),
        truncated: false,
      }))
      const cache = new FileCache({ dir })
      const innerProvider = {
        name: "spy",
        fetchContent: inner,
      }
      const provider = new CachedContentProvider(innerProvider, cache)
      await provider.fetchContent({ url: "https://example.com/a?utm_source=x#frag" })
      await provider.fetchContent({ url: "https://example.com/a" })
      expect(inner).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
