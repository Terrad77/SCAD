/** Stable id prefixes used across the Evidence & Research Engine. */
export const PLAN_PREFIX = "PLAN"
export const RESEARCH_SUBQUESTION_PREFIX = "SUB_Q"
export const QUERY_PREFIX = "QRY"
export const EVIDENCE_PREFIX = "EVID"
export const CLAIM_PREFIX = "CLM"
export const CONTRADICTION_PREFIX = "CTR"
export const GAP_PREFIX = "GAP"

export function makeId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`
}
