import { SpecialistAgent } from "./agents.js";
import { FieldEngine } from "./field-engine.js";
import { FusionEngine } from "./fusion-engine.js";
import { OllamaClient } from "./ollama.js";
import { OpenCodeClient } from "./opencode.js";
import { Stellarator } from "./orchestrator.js";
import type { AgentRole, FieldState } from "./schemas.js";

const goal = process.argv.slice(2).join(" ");
if (!goal) {
  console.error('Usage: npm run dev -- "Your goal" [maxIterations] [threshold]');
  process.exitCode = 1;
} else {
  const maxIterations = Number(process.argv[3] ?? 3);
  const threshold = Number(process.argv[4] ?? 0.8);
  const client = process.env.LLM_BACKEND === "ollama"
    ? new OllamaClient({
        baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
        model: process.env.OLLAMA_MODEL ?? "llama3.2"
      })
    : new OpenCodeClient({ model: process.env.OPENCODE_MODEL ?? "opencode/big-pickle" });
  const initialField: FieldState = {
    iteration: 0,
    goal,
    dimensions: { clarity: 0, feasibility: 0, risk: 0, novelty: 0 },
    memory: [],
    lastConsensus: 0
  };
  const roles: AgentRole[] = ["architect", "coder", "reviewer", "researcher"];
  const app = new Stellarator(roles.map((role) => new SpecialistAgent(role, client)), new FusionEngine(client), new FieldEngine(initialField));
  const result = await app.run(goal, maxIterations, threshold);
  console.log(JSON.stringify(result, null, 2));
}
