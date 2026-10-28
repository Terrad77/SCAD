export interface LLMRequest {
  /** System-level instruction such as role and output constraints. */
  system?: string
  /** The task-specific user prompt. */
  prompt: string
  /** Request a JSON object; providers use native mode where available. */
  format?: "json"
  /** Native constrained output format, when the provider supports it. */
  jsonSchema?: LLMJsonSchema
  model?: string
  /** Provider-neutral metadata (e.g. pipeline stage) that mock providers can key on. */
  meta?: Record<string, string>
}

export interface LLMResponse {
  text: string
  /** True only when the provider accepted and applied the supplied JSON Schema. */
  jsonSchemaApplied?: boolean
}

export interface LLMJsonSchema {
  name: string
  schema: Record<string, unknown>
}

export interface LLMProviderCapabilities {
  /** Provider supports constrained JSON Schema output for compatible models. */
  jsonSchema?: boolean
}

/**
 * Provider abstraction. SCAD must never be coupled to a single AI vendor.
 * OpenAI, Anthropic, local servers and mock providers implement this interface.
 */
export interface LLMProvider {
  readonly capabilities?: LLMProviderCapabilities
  /**
   * Generate one response. Implementations own transport concerns such as
   * timeouts and transient network retries; callers may retry invalid output,
   * but must not retry a failed provider call.
   */
  generate(request: LLMRequest): Promise<LLMResponse>
}
