import { SpecialistAgent } from "./agents.js";
import { FieldEngine } from "./field-engine.js";
import { FusionEngine } from "./fusion-engine.js";
import type { FieldState, FusionResult, Proposal } from "./schemas.js";

export interface RunResult {
  converged: boolean;
  iterations: Array<{ field: FieldState; proposals: Proposal[]; fusion: FusionResult }>;
}

export class Stellarator {
  constructor(
    private readonly agents: SpecialistAgent[],
    private readonly fusion: FusionEngine,
    private readonly field: FieldEngine
  ) {}

  async run(goal: string, maxIterations = 3, threshold = 0.8): Promise<RunResult> {
    const iterations: RunResult["iterations"] = [];
    for (let index = 0; index < maxIterations; index += 1) {
      const before = this.field.snapshot();
      const proposals = await Promise.all(this.agents.map((agent) => agent.deliberate(goal, before)));
      const fusion = await this.fusion.fuse(goal, proposals);
      const field = this.field.apply(proposals, fusion.consensus);
      iterations.push({ field, proposals, fusion });
      if (fusion.consensus >= threshold) return { converged: true, iterations };
    }
    return { converged: false, iterations };
  }
}
