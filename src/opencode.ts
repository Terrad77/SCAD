import { spawn } from "node:child_process";
import type { LlmClient } from "./ollama.js";

export interface OpenCodeClientOptions {
  model: string;
  timeoutMs?: number;
}

type OpenCodeEvent = {
  type?: string;
  part?: { type?: string; text?: string };
};

/** Invokes an already-authenticated OpenCode CLI without storing credentials in this project. */
export class OpenCodeClient implements LlmClient {
  constructor(private readonly options: OpenCodeClientOptions) {}

  complete(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("opencode", ["run", "--format", "json", "--model", this.options.model, prompt], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill(), this.options.timeoutMs ?? 120_000);

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Could not start OpenCode: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr || stdout}`));
          return;
        }
        const text = stdout
          .split(/\r?\n/)
          .flatMap((line) => {
            try { return [JSON.parse(line) as OpenCodeEvent]; } catch { return []; }
          })
          .filter((event) => event.type === "text" && event.part?.type === "text")
          .map((event) => event.part?.text ?? "")
          .join("\n");
        if (!text) {
          reject(new Error(`OpenCode returned no text event: ${stdout || stderr}`));
          return;
        }
        resolve(text);
      });
    });
  }
}
