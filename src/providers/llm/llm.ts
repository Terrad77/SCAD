export interface LLMRequest {
  /** System-level instruction such as role and output constraints. */
  system?: string
  /** The task-specific user prompt. */
  prompt: string
  /** Request a JSON object; providers use native mode where available. */
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
  /**
   * Generate one response. Implementations own transport concerns such as
   * timeouts and transient network retries; callers may retry invalid output,
   * but must not retry a failed provider call.
   */
  generate(request: LLMRequest): Promise<LLMResponse>
}
