import { FusionResultSchema, type FusionResult, type Proposal } from "./schemas.js";
import type { LlmClient } from "./ollama.js";
import { parseJsonObject } from "./json.js";

export class FusionEngine {
  constructor(private readonly client: LlmClient) {}

  async fuse(goal: string, proposals: Proposal[]): Promise<FusionResult> {
    const prompt = `You are a fusion engine. Synthesize independent expert proposals for this goal: ${goal}
Proposals: ${JSON.stringify(proposals)}
Return ONLY JSON: {"decision":"...","actionPlan":["..."],"consensus":0.0,"rationale":"..."}.
Consensus is 0..1: score agreement on the next action, not average confidence. Preserve material risks.`;
    const raw = await this.client.complete(prompt);
    return FusionResultSchema.parse(parseJsonObject(raw));
  }
}
