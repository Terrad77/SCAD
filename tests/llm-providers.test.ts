import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { OpenAIProvider } from "../src/providers/llm/openai.js"
import { AnthropicProvider } from "../src/providers/llm/anthropic.js"
import type { LLMRequest } from "../src/providers/llm/llm.js"

/** Slot the stub fills in with the request it intercepted. */
interface CapturedRequest {
  url?: string
  init?: RequestInit
}

interface StubOptions {
  status?: number
  body?: string
  lastRequest?: CapturedRequest
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
    const lastRequest: CapturedRequest = {}
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
    const { url, init } = lastRequest
    if (!init) throw new Error("expected the provider to issue a request")
    expect(url).toContain("chat/completions")
    const payload = JSON.parse(String(init.body ?? "")) as {
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

  it("uses native strict JSON Schema output when one is supplied", async () => {
    const lastRequest: CapturedRequest = {}
    stubFetch({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      lastRequest,
    })
    const provider = new OpenAIProvider()
    await provider.generate({
      prompt: "Do it",
      format: "json",
      jsonSchema: {
        name: "test_output",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    })
    const payload = JSON.parse(String(lastRequest.init?.body ?? "")) as {
      response_format?: { type: string; json_schema?: { name: string; strict: boolean } }
    }
    expect(payload.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "test_output", strict: true },
    })
  })

  it("falls back to JSON mode when the model rejects JSON Schema mode", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "response_format json_schema is unsupported" } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
          status: 200,
        }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const response = await new OpenAIProvider().generate({
      prompt: "Do it",
      format: "json",
      jsonSchema: { name: "test_output", schema: { type: "object" } },
    })
    const fallback = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "")) as {
      response_format?: { type: string }
      messages: Array<{ role: string; content: string }>
    }
    expect(response.jsonSchemaApplied).toBe(false)
    expect(fallback.response_format).toEqual({ type: "json_object" })
    expect(fallback.messages[0]?.content).toContain("valid JSON object")
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
    const lastRequest: CapturedRequest = {}
    stubFetch({
      status: 200,
      body: JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }),
      lastRequest,
    })
    const provider = new AnthropicProvider()
    const response = await provider.generate({ system: "S", prompt: "P", format: "json" })
    expect(response.text).toBe('{"ok":true}')
    const { url, init } = lastRequest
    if (!init) throw new Error("expected the provider to issue a request")
    expect(url).toContain("/v1/messages")
    const headers = init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("ant-test")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    const payload = JSON.parse(String(init.body ?? "")) as {
      model: string
      system: string
    }
    expect(payload.model).toBe("claude-sonnet-test")
    expect(payload.system).toContain("S")
    expect(payload.system).toContain("valid JSON object")
  })

  it("requires an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(new AnthropicProvider().generate({ prompt: "x" })).rejects.toThrow(/API key/)
  })

  it("sends a native JSON Schema output configuration when one is supplied", async () => {
    const lastRequest: CapturedRequest = {}
    stubFetch({
      status: 200,
      body: JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }),
      lastRequest,
    })
    const provider = new AnthropicProvider()
    await provider.generate({
      system: "System",
      prompt: "Do it",
      format: "json",
      jsonSchema: {
        name: "test_output",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    })
    const payload = JSON.parse(String(lastRequest.init?.body ?? "")) as {
      output_config?: { format?: { type: string; schema?: Record<string, unknown> } }
      system?: string
    }
    expect(payload.output_config?.format).toMatchObject({
      type: "json_schema",
      schema: { type: "object", required: ["ok"] },
    })
    expect(payload.system).toBe("System")
  })

  it("falls back to prompted JSON when the model rejects structured outputs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "Structured outputs are not supported by this model" },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }), {
          status: 200,
        }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const response = await new AnthropicProvider().generate({
      prompt: "Do it",
      format: "json",
      jsonSchema: { name: "test_output", schema: { type: "object" } },
    })
    const fallback = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "")) as {
      system: string
      output_config?: unknown
    }
    expect(response.jsonSchemaApplied).toBe(false)
    expect(fallback.output_config).toBeUndefined()
    expect(fallback.system).toContain("valid JSON object")
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
