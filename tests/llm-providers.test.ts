import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { OpenAIProvider } from "../src/providers/llm/openai.js"
import { AnthropicProvider } from "../src/providers/llm/anthropic.js"
import type { LLMRequest } from "../src/providers/llm/llm.js"

interface StubOptions {
  status?: number
  body?: string
  lastRequest?: { url: string; init: RequestInit }
}

function stubFetch(options: StubOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.lastRequest)
      Object.assign(options.lastRequest, { url: String(input), init: init ?? {} })
    return new Response(options.body ?? "{}", {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function jsonRequest(request: LLMRequest): LLMRequest {
  return { ...request, format: "json" }
}

const stored: Record<string, string | undefined> = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test"
  process.env.OPENAI_MODEL = "gpt-4o-test"
  process.env.ANTHROPIC_API_KEY = "ant-test"
  process.env.ANTHROPIC_MODEL = "claude-sonnet-test"
})

afterEach(() => {
  for (const [key, value] of Object.entries(stored)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

describe("OpenAIProvider", () => {
  it("sends messages to chat/completions and parses the text content", async () => {
    const lastRequest: StubOptions["lastRequest"] = {}
    stubFetch({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
      lastRequest,
    })
    const provider = new OpenAIProvider()
    const response = await provider.generate(
      jsonRequest({ system: "System", prompt: "Do it", format: "json" }),
    )
    expect(response.text).toBe('{"ok":true}')
    expect(lastRequest?.url).toContain("chat/completions")
    const payload = JSON.parse(String((lastRequest?.init.body as string) ?? "")) as {
      model: string
      messages: Array<{ role: string; content: string }>
      response_format?: { type: string }
    }
    expect(payload.model).toBe("gpt-4o-test")
    expect(payload.response_format?.type).toBe("json_object")
    expect(payload.messages.map((m) => m.role)).toEqual(["system", "user"])
  })

  it("requires an API key", async () => {
    delete process.env.OPENAI_API_KEY
    await expect(new OpenAIProvider().generate({ prompt: "x" })).rejects.toThrow(/API key/)
  })

  it("requires a model", async () => {
    delete process.env.OPENAI_MODEL
    await expect(new OpenAIProvider().generate({ prompt: "x" })).rejects.toThrow(/model/)
  })

  it("rejects non-JSON responses", async () => {
    stubFetch({ status: 200, body: "not json" })
    await expect(new OpenAIProvider().generate({ prompt: "x" })).rejects.toThrow(/non-JSON/)
  })

  it("rejects responses without text content", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ choices: [] }) })
    await expect(new OpenAIProvider().generate({ prompt: "x" })).rejects.toThrow(/no text content/)
  })
})

describe("AnthropicProvider", () => {
  it("sends messages to /v1/messages and parses the text content", async () => {
    const lastRequest: StubOptions["lastRequest"] = {}
    stubFetch({
      status: 200,
      body: JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }),
      lastRequest,
    })
    const provider = new AnthropicProvider()
    const response = await provider.generate({ system: "S", prompt: "P" })
    expect(response.text).toBe('{"ok":true}')
    expect(lastRequest?.url).toContain("/v1/messages")
    expect((lastRequest?.init.headers as Record<string, string>)["x-api-key"]).toBe("ant-test")
    expect((lastRequest?.init.headers as Record<string, string>)["anthropic-version"]).toBe(
      "2023-06-01",
    )
    const payload = JSON.parse(String((lastRequest?.init.body as string) ?? "")) as {
      model: string
    }
    expect(payload.model).toBe("claude-sonnet-test")
  })

  it("requires an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(new AnthropicProvider().generate({ prompt: "x" })).rejects.toThrow(/API key/)
  })

  it("requires a model", async () => {
    delete process.env.ANTHROPIC_MODEL
    await expect(new AnthropicProvider().generate({ prompt: "x" })).rejects.toThrow(/model/)
  })

  it("rejects non-JSON responses", async () => {
    stubFetch({ status: 200, body: "not json" })
    await expect(new AnthropicProvider().generate({ prompt: "x" })).rejects.toThrow(/non-JSON/)
  })

  it("rejects responses without text content", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ content: [{ type: "tool_use" }] }) })
    await expect(new AnthropicProvider().generate({ prompt: "x" })).rejects.toThrow(
      /no text content/,
    )
  })
})
