import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.js"

export interface OllamaOptions {
  baseUrl?: string
  model?: string
}

/** LLM provider backed by a local Ollama server (http://127.0.0.1:11434). */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama"

  constructor(private readonly options: OllamaOptions = {}) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.options.model
    if (!model) throw new Error("Ollama provider requires a model name")
    const base = (this.options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "")
    const system = request.system ? `\n\n${request.system}` : ""
    const response = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: `${system}\n\n${request.prompt}`,
        stream: false,
        format: request.format,
      }),
    })
    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`)
    }
    const payload = (await response.json()) as { response?: string }
    if (typeof payload.response !== "string") {
      throw new Error("Ollama returned no text response")
    }
    return { text: payload.response }
  }
}
