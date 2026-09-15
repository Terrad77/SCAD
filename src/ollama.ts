export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
}

export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

export class OllamaClient implements LlmClient {
  constructor(private readonly options: OllamaClientOptions) {}

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.options.model, prompt, stream: false, format: "json" })
    });
    if (!response.ok) throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
    const payload = (await response.json()) as { response?: unknown };
    if (typeof payload.response !== "string") throw new Error("Ollama returned no text response");
    return payload.response;
  }
}
