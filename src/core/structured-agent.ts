import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { z } from "zod"
import type { LLMProvider } from "../providers/llm/llm.js"
import { parseJsonObject } from "./json.js"

export class StructuredError extends Error {
  constructor(
    readonly stage: string,
    readonly cause1: unknown,
  ) {
    super(`Structured ${stage} output failed validation: ${String(cause1)}`)
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
 * is retried with exponential backoff, then a StructuredError is raised.
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
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await this.provider.generate({
          system: cached,
          prompt,
          format: "json",
          meta: { stage },
        })
        return schema.parse(parseJsonObject(response.text)) as z.infer<S>
      } catch (error) {
        lastError = error
        if (attempt < maxRetries) {
          const delay = baseDelayMs * backoffFactor ** attempt
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw new StructuredError(stage, lastError)
  }
}
