import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.js"
import { fetchWithRetry } from "../http.js"

export interface AnthropicProviderOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof fetch
}

interface AnthropicMessagesPayload {
  content?: Array<{ type?: string; text?: string }>
}

/** Default Anthropic API version used for /v1/messages. */
const ANTHROPIC_VERSION = "2023-06-01"

/**
 * LLM provider backed by the Anthropic Messages API. Model and endpoint are
 * configured through environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
 * `ANTHROPIC_BASE_URL`) or constructor options.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic"

  constructor(private readonly options: AnthropicProviderOptions = {}) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const apiKey = this.options.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("Anthropic provider requires an API key (ANTHROPIC_API_KEY)")

    const model = request.model ?? this.options.model ?? process.env.ANTHROPIC_MODEL
    if (!model) throw new Error("Anthropic provider requires a model (ANTHROPIC_MODEL)")

    const baseUrl = (
      this.options.baseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com"
    ).replace(/\/$/, "")

    const result = await fetchWithRetry(
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: this.options.maxTokens ?? 4096,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
        }),
      },
      {
        timeoutMs: this.options.timeoutMs,
        maxRetries: this.options.maxRetries,
        fetch: this.options.fetch,
      },
    )

    let payload: unknown
    try {
      payload = JSON.parse(result.body) as unknown
    } catch {
      throw new Error(`Anthropic returned non-JSON response (HTTP ${result.status})`)
    }
    const messages = payload as AnthropicMessagesPayload
    const text = (messages.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
    if (text.length === 0) {
      throw new Error("Anthropic returned no text content")
    }
    return { text }
  }
}
