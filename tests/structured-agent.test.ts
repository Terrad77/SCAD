import { describe, it, expect, vi } from "vitest"
import { StructuredAgent, StructuredError } from "../src/core/structured-agent.js"
import { EvidenceOutputSchema } from "../src/core/schemas.js"
import { HttpRequestError } from "../src/providers/http.js"
import type { LLMProvider } from "../src/providers/llm/llm.js"

const loadSystem = async (): Promise<string> => "system prompt"

describe("StructuredAgent", () => {
  it("fails fast on a non-retriable HTTP error without retrying", async () => {
    const generate = vi.fn<LLMProvider["generate"]>(async () => {
      throw new HttpRequestError(401, "unauthorized", false, "HTTP 401")
    })
    const provider: LLMProvider = { name: "throwing", generate }
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

  it("still retries transient (retriable) failures", async () => {
    const generate = vi.fn<LLMProvider["generate"]>(async () => {
      throw new HttpRequestError(503, "unavailable", true, "HTTP 503")
    })
    const provider: LLMProvider = { name: "throwing", generate }
    const agent = new StructuredAgent(provider, loadSystem)
    await expect(
      agent.run("evidence-extraction", EvidenceOutputSchema, {}, { maxRetries: 2, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(StructuredError)
    expect(generate).toHaveBeenCalledTimes(3)
  })
})
