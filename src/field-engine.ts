import type { FieldState, Proposal } from "./schemas.js";

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/** Keeps the architecture's shared, bounded cognitive field. */
export class FieldEngine {
  constructor(private state: FieldState) {}

  snapshot(): FieldState {
    return structuredClone(this.state);
  }

  apply(proposals: Proposal[], consensus: number): FieldState {
    const next = this.snapshot();
    const totals = new Map<string, number>();
    const counts = new Map<string, number>();

    for (const proposal of proposals) {
      for (const [dimension, delta] of Object.entries(proposal.fieldUpdates) as Array<[string, number]>) {
        totals.set(dimension, (totals.get(dimension) ?? 0) + delta * proposal.confidence);
        counts.set(dimension, (counts.get(dimension) ?? 0) + proposal.confidence);
      }
    }

    for (const [dimension, total] of totals) {
      const weight = counts.get(dimension) ?? 1;
      const current = next.dimensions[dimension] ?? 0;
      // An inertial field avoids one agent causing abrupt state swings.
      next.dimensions[dimension] = clamp(current * 0.65 + (total / weight) * 0.35);
    }

    next.iteration += 1;
    next.lastConsensus = consensus;
    next.memory = [...next.memory, ...proposals.map((p) => `${p.role}: ${p.summary}`)].slice(-20);
    this.state = next;
    return this.snapshot();
  }
}
