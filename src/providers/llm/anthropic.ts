import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.js"
import { fetchWithRetry, HttpRequestError, type HttpResult } from "../http.js"

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
  readonly capabilities = { jsonSchema: true } as const

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

    let jsonSchemaApplied = Boolean(request.jsonSchema)
    let result: HttpResult
    try {
      result = await this.send(baseUrl, apiKey, bodyFor(request, model, this.options.maxTokens))
    } catch (error) {
      if (!request.jsonSchema || !isJsonSchemaRejection(error)) throw error
      result = await this.send(
        baseUrl,
        apiKey,
        bodyFor(request, model, this.options.maxTokens, false),
      )
      jsonSchemaApplied = false
    }

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
    return { text, jsonSchemaApplied }
  }

  private send(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
    return fetchWithRetry(
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: this.options.timeoutMs,
        maxRetries: this.options.maxRetries,
        fetch: this.options.fetch,
      },
    )
  }
}

function bodyFor(
  request: LLMRequest,
  model: string,
  maxTokens: number | undefined,
  useJsonSchema = Boolean(request.jsonSchema),
): Record<string, unknown> {
  const system = [
    request.system,
    request.format === "json" && !useJsonSchema
      ? "Return exactly one valid JSON object with no Markdown fences or surrounding prose."
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
  return {
    model,
    max_tokens: maxTokens ?? 4096,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: request.prompt }],
    ...(useJsonSchema && request.jsonSchema
      ? {
          output_config: {
            format: {
              type: "json_schema",
              schema: request.jsonSchema.schema,
            },
          },
        }
      : {}),
  }
}

function isJsonSchemaRejection(error: unknown): boolean {
  return (
    error instanceof HttpRequestError &&
    error.status === 400 &&
    /structured output|output_config|json_schema|schema/i.test(error.body ?? "")
  )
}
