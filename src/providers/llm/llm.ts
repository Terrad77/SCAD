export interface LLMRequest {
  /** System-level instruction such as role and output constraints. */
  system?: string
  /** The task-specific user prompt. */
  prompt: string
  /** Hint to the provider that structured (JSON) output is required. */
  format?: "json"
  model?: string
  /** Provider-neutral metadata (e.g. pipeline stage) that mock providers can key on. */
  meta?: Record<string, string>
}

export interface LLMResponse {
  text: string
}

/**
 * Provider abstraction. SCAD must never be coupled to a single AI vendor.
 * OpenAI, Anthropic, local servers and mock providers implement this interface.
 */
export interface LLMProvider {
  generate(request: LLMRequest): Promise<LLMResponse>
}
