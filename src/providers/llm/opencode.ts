import { spawn } from "node:child_process"
import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.js"

export interface OpenCodeOptions {
  model?: string
  timeoutMs?: number
  timeout?: number
}

type OpenCodeEvent = {
  type?: string
  part?: { type?: string; text?: string }
}

/** Invokes an already-authenticated OpenCode CLI (opencode run --format json). */
export class OpenCodeProvider implements LLMProvider {
  readonly name = "opencode"

  constructor(private readonly options: OpenCodeOptions = {}) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    return new Promise((resolve, reject) => {
      const args = ["run", "--format", "json"]
      if (this.options.model ?? request.model) {
        args.push("--model", (this.options.model ?? request.model)!)
      }
      const fullPrompt = `${request.system ? `${request.system}\n\n` : ""}${request.prompt}`
      args.push(fullPrompt)

      const child = spawn("opencode", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      let stdout = ""
      let stderr = ""
      const timeoutMs = this.options.timeoutMs ?? this.options.timeout ?? 120_000
      const timer = setTimeout(() => child.kill(), timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on("error", (error) => {
        clearTimeout(timer)
        reject(new Error(`Could not start OpenCode: ${error.message}`))
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr || stdout}`))
          return
        }
        const text = stdout
          .split(/\r?\n/)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as OpenCodeEvent]
            } catch {
              return []
            }
          })
          .filter((event) => event.type === "text" && event.part?.type === "text")
          .map((event) => event.part?.text ?? "")
          .join("\n")
        if (!text) {
          reject(new Error(`OpenCode returned no text event: ${stdout || stderr}`))
          return
        }
        resolve({ text })
      })
    })
  }
}
