import type { LLMProvider, LLMRequest } from "./llm.js"
import { OpenCodeProvider } from "./opencode.js"
import { OllamaProvider } from "./ollama.js"
import { MockLLMProvider } from "./mock.js"
import { DEMO_STAGE_RESPONSES } from "./mockFixtures.js"

export interface LLMInstance {
  provider: LLMProvider
  name: string
  model?: string
}

export function createLLMProvider(config: {
  provider: string
  opencodeModel?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
}): LLMInstance {
  switch (config.provider) {
    case "ollama": {
      const provider = new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
      })
      return { provider, name: "ollama", model: config.ollamaModel }
    }
    case "mock": {
      // Serve canned demo output per stage so the CLI works fully offline.
      const provider = new MockLLMProvider((request: LLMRequest) => {
        const json = DEMO_STAGE_RESPONSES[request.meta?.stage ?? ""]
        return json ? { text: json } : null
      })
      return { provider, name: "mock" }
    }
    case "opencode":
    default: {
      const provider = new OpenCodeProvider({ model: config.opencodeModel })
      return { provider, name: "opencode", model: config.opencodeModel }
    }
  }
}
