import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.js"
import { fetchWithRetry, HttpRequestError, type HttpResult } from "../http.js"

export interface OpenAIProviderOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof fetch
}

interface OpenAICompletionPayload {
  choices?: Array<{ message?: { content?: string } }>
}

/**
 * LLM provider backed by the OpenAI Chat Completions API. Model and endpoint
 * are configured through environment (`OPENAI_API_KEY`, `OPENAI_MODEL`,
 * `OPENAI_BASE_URL`) or constructor options; no model is hardcoded.
 * Structured output requests use strict JSON Schema, with JSON mode as a
 * compatibility fallback when the selected model rejects schema mode.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai"
  readonly capabilities = { jsonSchema: true } as const

  constructor(private readonly options: OpenAIProviderOptions = {}) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OpenAI provider requires an API key (OPENAI_API_KEY)")

    const model = request.model ?? this.options.model ?? process.env.OPENAI_MODEL
    if (!model) throw new Error("OpenAI provider requires a model (OPENAI_MODEL)")

    const baseUrl = (
      this.options.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/$/, "")

    const body: Record<string, unknown> = {
      model,
      messages: messagesFor(request),
      temperature: 0,
    }
    if (request.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.jsonSchema.name,
          strict: true,
          schema: request.jsonSchema.schema,
        },
      }
    } else if (request.format === "json") {
      body.response_format = { type: "json_object" }
    }

    let jsonSchemaApplied = Boolean(request.jsonSchema)
    let result: HttpResult
    try {
      result = await this.send(baseUrl, apiKey, body)
    } catch (error) {
      if (!request.jsonSchema || !isJsonSchemaRejection(error)) throw error
      body.response_format = { type: "json_object" }
      body.messages = messagesFor(request, true)
      result = await this.send(baseUrl, apiKey, body)
      jsonSchemaApplied = false
    }

    let payload: unknown
    try {
      payload = JSON.parse(result.body) as unknown
    } catch {
      throw new Error(`OpenAI returned non-JSON response (HTTP ${result.status})`)
    }
    const completion = payload as OpenAICompletionPayload
    const content = completion.choices?.[0]?.message?.content
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("OpenAI returned no text content")
    }
    return { text: content, jsonSchemaApplied }
  }

  private send(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
    return fetchWithRetry(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
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

function messagesFor(request: LLMRequest, addJsonInstruction = false) {
  const system = [
    request.system,
    addJsonInstruction
      ? "Return exactly one valid JSON object with no Markdown fences or surrounding prose."
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
  return [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: request.prompt },
  ]
}

function isJsonSchemaRejection(error: unknown): boolean {
  return (
    error instanceof HttpRequestError &&
    error.status === 400 &&
    /json_schema|response_format|structured output/i.test(error.body ?? "")
  )
}
