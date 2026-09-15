import { ProposalSchema, type AgentRole, type FieldState, type Proposal } from "./schemas.js";
import type { LlmClient } from "./ollama.js";
import { parseJsonObject } from "./json.js";

const specialties: Record<AgentRole, string> = {
  architect: "You design coherent system architecture and sequencing.",
  coder: "You focus on concrete implementation, interfaces, and testable steps.",
  reviewer: "You expose assumptions, failure modes, safety concerns, and acceptance criteria.",
  researcher: "You identify unknowns, evidence needs, alternatives, and validation experiments."
};

export class SpecialistAgent {
  constructor(readonly role: AgentRole, private readonly client: LlmClient) {}

  async deliberate(goal: string, field: FieldState): Promise<Proposal> {
    const prompt = `${specialties[this.role]}
You are one independent specialist in a multi-agent system. Goal: ${goal}
Shared field (read-only for this turn): ${JSON.stringify(field)}
Return ONLY a JSON object matching exactly this shape:
{"role":"${this.role}","summary":"...","reasoning":"...","actions":["..."],"risks":["..."],"confidence":0.0,"fieldUpdates":{"dimension":0.0}}
confidence and fieldUpdates must be numbers in [-1,1], with confidence in [0,1].`;
    const raw = await this.client.complete(prompt);
    return ProposalSchema.parse(parseJsonObject(raw));
  }
}
