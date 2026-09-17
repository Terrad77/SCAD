import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.js"

export interface MockSelectionResult {
  text: string
}

export interface MockSelection {
  select(request: LLMRequest): MockSelectionResult | null
}

/**
 * Deterministic, offline provider used by tests and demos.
 * A selection function maps an incoming request to a canned textual response.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock"

  constructor(
    private readonly select: MockSelection["select"],
    private readonly delayMs = 0,
  ) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    const result = this.select(request)
    if (!result)
      throw new Error(`MockLLMProvider: no canned response for prompt:\n${request.prompt}`)
    return { text: result.text }
  }
}

/** Picks the canned answer by matching a literal substring in the prompt. */
export function bySubstring(substring: string, response: string): MockSelection {
  return {
    select(request) {
      return request.prompt.includes(substring) ? { text: response } : null
    },
  }
}

/** Picks the canned answer whose key appears first in the prompt. */
export function byKeyword(keywords: Array<[substring: string, response: string]>): MockSelection {
  return {
    select(request) {
      const hit = keywords.find(([substring]) => request.prompt.includes(substring))
      return hit ? { text: hit[1] } : null
    },
  }
}
