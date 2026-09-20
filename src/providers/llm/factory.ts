import type { LLMProvider, LLMRequest } from "./llm.js"
import { OpenCodeProvider } from "./opencode.js"
import { OllamaProvider } from "./ollama.js"
import { OpenAIProvider } from "./openai.js"
import { AnthropicProvider } from "./anthropic.js"
import { MockLLMProvider } from "./mock.js"
import { DEMO_STAGE_RESPONSES } from "./mockFixtures.js"

export interface LLMInstance {
  provider: LLMProvider
  name: string
  model?: string
}

export interface LLMFactoryConfig {
  provider: string
  opencodeModel?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
  openaiModel?: string
  anthropicModel?: string
}

export function createLLMProvider(config: LLMFactoryConfig): LLMInstance {
  switch (config.provider) {
    case "ollama": {
      const provider = new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
      })
      return { provider, name: "ollama", model: config.ollamaModel }
    }
    case "openai": {
      const provider = new OpenAIProvider({ model: config.openaiModel })
      return { provider, name: "openai", model: config.openaiModel }
    }
    case "anthropic": {
      const provider = new AnthropicProvider({ model: config.anthropicModel })
      return { provider, name: "anthropic", model: config.anthropicModel }
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
