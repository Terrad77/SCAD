import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { z } from "zod"
import type { LLMProvider, LLMResponse } from "../providers/llm/llm.js"
import { normalizeJsonSchemaNulls, toLLMJsonSchema } from "./json-schema.js"
import { parseJsonObject } from "./json.js"

export class StructuredError extends Error {
  constructor(
    readonly stage: string,
    readonly cause1: unknown,
  ) {
    super(`Structured ${stage} output failed: ${String(cause1)}`)
    this.name = "StructuredError"
  }
}

export class StructuredInvalidOutputError extends StructuredError {
  constructor(stage: string, cause: unknown) {
    super(stage, cause)
    this.name = "StructuredInvalidOutputError"
  }
}

export class StructuredRefusalError extends StructuredError {
  constructor(
    stage: string,
    readonly refusal?: string,
  ) {
    super(
      stage,
      new Error(refusal ? `Provider refused: ${refusal}` : "Provider refused the request"),
    )
    this.name = "StructuredRefusalError"
  }
}

export class StructuredTruncationError extends StructuredError {
  constructor(
    stage: string,
    readonly providerFinishReason?: string,
  ) {
    const detail = providerFinishReason ? ` (${providerFinishReason})` : ""
    super(stage, new Error(`Provider truncated the response${detail}`))
    this.name = "StructuredTruncationError"
  }
}

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  backoffFactor?: number
}

/** Loads the system prompt for a pipeline stage. */
export type SystemPromptLoader = (stage: string) => Promise<string>

export const readPromptFile: SystemPromptLoader = (stage) =>
  readFile(join(process.cwd(), "prompts", `${stage}.md`), "utf8")

/**
 * Runs a single pipeline step: builds the prompt, calls the LLM provider,
 * parses the JSON object and validates it with a Zod schema. Invalid output
 * is retried with exponential backoff, then a StructuredInvalidOutputError is raised.
 * Provider failures are surfaced immediately because transport retries belong
 * to the provider adapter; retrying them here would multiply network attempts.
 */
export class StructuredAgent {
  private readonly promptCache = new Map<string, string>()

  constructor(
    protected readonly provider: LLMProvider,
    protected readonly loadSystem: SystemPromptLoader,
  ) {}

  async run<S extends z.ZodType>(
    stage: string,
    schema: S,
    input: unknown,
    options: RetryOptions = {},
  ): Promise<z.infer<S>> {
    const { maxRetries = 2, baseDelayMs = 500, backoffFactor = 2 } = options

    let cached = this.promptCache.get(stage)
    if (cached === undefined) {
      cached = await this.loadSystem(stage)
      this.promptCache.set(stage, cached)
    }

    const prompt = JSON.stringify(input, null, 2)
    const jsonSchema = this.provider.capabilities?.jsonSchema
      ? toLLMJsonSchema(schema, stage)
      : undefined
    const maxOutputTokens = this.provider.capabilities?.maxOutputTokens
      ? outputTokenLimitForStage(stage)
      : undefined
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response: LLMResponse
      try {
        response = await this.provider.generate({
          system: cached,
          prompt,
          format: "json",
          jsonSchema,
          maxOutputTokens,
          meta: { stage },
        })
      } catch (error) {
        throw new StructuredError(stage, error)
      }

      if (response.finishReason === "refusal" || response.refusal) {
        throw new StructuredRefusalError(stage, response.refusal)
      }
      if (response.finishReason === "length") {
        throw new StructuredTruncationError(stage, response.providerFinishReason)
      }
      if (response.finishReason === "other") {
        throw new StructuredError(
          stage,
          new Error(
            `Provider ended generation with ${response.providerFinishReason ?? "an unsupported reason"}`,
          ),
        )
      }

      try {
        const output = parseJsonObject(response.text)
        return schema.parse(
          response.jsonSchemaApplied ? normalizeJsonSchemaNulls(output, schema) : output,
        ) as z.infer<S>
      } catch (error) {
        lastError = error
        if (attempt < maxRetries) {
          const delay = baseDelayMs * backoffFactor ** attempt
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw new StructuredInvalidOutputError(stage, lastError)
  }
}

function outputTokenLimitForStage(stage: string): number | undefined {
  const raw = process.env.SCAD_LLM_OUTPUT_TOKEN_BUDGETS
  if (!raw) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error("SCAD_LLM_OUTPUT_TOKEN_BUDGETS must be a JSON object of stage token limits")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SCAD_LLM_OUTPUT_TOKEN_BUDGETS must be a JSON object of stage token limits")
  }

  const limits = parsed as Record<string, unknown>
  for (const [name, value] of Object.entries(limits)) {
    if (!name || typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        "SCAD_LLM_OUTPUT_TOKEN_BUDGETS values must be positive whole-number token limits",
      )
    }
  }
  return Object.hasOwn(limits, stage) ? (limits[stage] as number) : undefined
}
