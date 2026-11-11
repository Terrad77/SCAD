import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import {
  StructuredAgent,
  StructuredError,
  StructuredInvalidOutputError,
  StructuredRefusalError,
  StructuredTruncationError,
} from "../src/core/structured-agent.js"
import { EvidenceOutputSchema } from "../src/core/schemas.js"
import { HttpRequestError } from "../src/providers/http.js"
import type { LLMProvider } from "../src/providers/llm/llm.js"

const loadSystem = async (): Promise<string> => "system prompt"

describe("StructuredAgent", () => {
  it("fails fast on a non-retriable HTTP error without retrying", async () => {
    const generate = vi.fn<LLMProvider["generate"]>(async () => {
      throw new HttpRequestError(401, "unauthorized", false, "HTTP 401")
    })
    const provider: LLMProvider = { generate }
    const agent = new StructuredAgent(provider, loadSystem)
    const error = await agent
      .run("evidence-extraction", EvidenceOutputSchema, {}, { maxRetries: 3, baseDelayMs: 1 })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(StructuredError)
    expect(String(error)).toContain("HTTP 401")
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it("does not retry a provider failure after the transport retry budget is exhausted", async () => {
    const generate = vi.fn<LLMProvider["generate"]>(async () => {
      throw new HttpRequestError(503, "unavailable", true, "HTTP 503")
    })
    const provider: LLMProvider = { generate }
    const agent = new StructuredAgent(provider, loadSystem)
    const error = await agent
      .run("evidence-extraction", EvidenceOutputSchema, {}, { maxRetries: 2, baseDelayMs: 1 })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StructuredError)
    expect((error as StructuredError).cause1).toMatchObject({ status: 503, retriable: true })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it("retries malformed output while keeping output retries separate from transport", async () => {
    const generate = vi
      .fn<LLMProvider["generate"]>()
      .mockResolvedValueOnce({ text: "not json" })
      .mockResolvedValueOnce({ text: '{"ok":true}' })
    const provider: LLMProvider = { generate }
    const agent = new StructuredAgent(provider, loadSystem)

    await expect(
      agent.run("sample", z.object({ ok: z.boolean() }), {}, { maxRetries: 1, baseDelayMs: 1 }),
    ).resolves.toEqual({ ok: true })
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it("surfaces refusals without retrying", async () => {
    const generate = vi.fn<LLMProvider["generate"]>().mockResolvedValue({
      text: "I cannot help with that request.",
      finishReason: "refusal",
      refusal: "I cannot help with that request.",
    })
    const agent = new StructuredAgent({ generate }, loadSystem)

    await expect(
      agent.run("sample", z.object({ ok: z.boolean() }), {}, { maxRetries: 3, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(StructuredRefusalError)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it("surfaces truncated responses without retrying", async () => {
    const generate = vi.fn<LLMProvider["generate"]>().mockResolvedValue({
      text: '{"ok":',
      finishReason: "length",
      providerFinishReason: "max_tokens",
    })
    const agent = new StructuredAgent({ generate }, loadSystem)

    await expect(
      agent.run("sample", z.object({ ok: z.boolean() }), {}, { maxRetries: 3, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(StructuredTruncationError)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it("classifies malformed output after exhausting output retries", async () => {
    const generate = vi.fn<LLMProvider["generate"]>().mockResolvedValue({ text: "not json" })
    const agent = new StructuredAgent({ generate }, loadSystem)

    await expect(
      agent.run("sample", z.object({ ok: z.boolean() }), {}, { maxRetries: 1, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(StructuredInvalidOutputError)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it("passes native JSON Schema to capable providers and restores optional fields", async () => {
    const generate = vi.fn<LLMProvider["generate"]>().mockResolvedValue({
      text: '{"ok":true,"notes":null}',
      jsonSchemaApplied: true,
    })
    const provider: LLMProvider = { capabilities: { jsonSchema: true }, generate }
    const agent = new StructuredAgent(provider, loadSystem)

    await expect(
      agent.run(
        "native-schema",
        z.object({ ok: z.boolean(), notes: z.string().optional() }),
        {},
        { maxRetries: 0 },
      ),
    ).resolves.toEqual({ ok: true })
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchema: expect.objectContaining({
          name: "native-schema",
          schema: expect.objectContaining({ type: "object" }),
        }),
      }),
    )
  })

  it("applies the configured output token budget only to the matching stage", async () => {
    vi.stubEnv("SCAD_LLM_OUTPUT_TOKEN_BUDGETS", '{"sample":1536,"narrative":8192}')
    const generate = vi.fn<LLMProvider["generate"]>().mockResolvedValue({ text: '{"ok":true}' })
    const agent = new StructuredAgent(
      { capabilities: { maxOutputTokens: true }, generate },
      loadSystem,
    )

    try {
      await agent.run("sample", z.object({ ok: z.boolean() }), {}, { maxRetries: 0 })
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 1536 }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("rejects invalid per-stage output token configuration before calling the provider", async () => {
    vi.stubEnv("SCAD_LLM_OUTPUT_TOKEN_BUDGETS", '{"sample":0}')
    const generate = vi.fn<LLMProvider["generate"]>().mockResolvedValue({ text: '{"ok":true}' })
    const agent = new StructuredAgent(
      { capabilities: { maxOutputTokens: true }, generate },
      loadSystem,
    )

    try {
      await expect(
        agent.run("sample", z.object({ ok: z.boolean() }), {}, { maxRetries: 0 }),
      ).rejects.toThrow(/positive whole-number token limits/)
      expect(generate).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
