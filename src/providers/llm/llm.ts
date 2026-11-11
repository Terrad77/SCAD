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
  /** Normalized reason generation stopped. Providers may omit this when unavailable. */
  finishReason?: LLMFinishReason
  /** Provider's original finish reason for diagnostics. */
  providerFinishReason?: string
  /** Refusal explanation, when the provider supplies one. */
  refusal?: string
}

export type LLMFinishReason = "stop" | "length" | "refusal" | "other"

export function normalizeLLMFinishReason(reason: unknown): LLMFinishReason | undefined {
  if (typeof reason !== "string" || reason.length === 0) return undefined
  if (["stop", "end_turn", "stop_sequence"].includes(reason)) return "stop"
  if (["length", "max_tokens", "model_context_window_exceeded"].includes(reason)) {
    return "length"
  }
  if (reason === "refusal") return "refusal"
  return "other"
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
