import { z } from "zod";

export const AgentRoleSchema = z.enum(["architect", "coder", "reviewer", "researcher"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const ProposalSchema = z.object({
  role: AgentRoleSchema,
  summary: z.string().min(1),
  reasoning: z.string().min(1),
  actions: z.array(z.string()).min(1),
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  fieldUpdates: z.record(z.number().min(-1).max(1)).default({})
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const FieldStateSchema = z.object({
  iteration: z.number().int().nonnegative(),
  goal: z.string().min(1),
  dimensions: z.record(z.number().min(-1).max(1)),
  memory: z.array(z.string()),
  lastConsensus: z.number().min(0).max(1)
});
export type FieldState = z.infer<typeof FieldStateSchema>;

export const FusionResultSchema = z.object({
  decision: z.string().min(1),
  actionPlan: z.array(z.string()).min(1),
  consensus: z.number().min(0).max(1),
  rationale: z.string().min(1)
});
export type FusionResult = z.infer<typeof FusionResultSchema>;
