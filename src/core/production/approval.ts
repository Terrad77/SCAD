import { createHash } from "node:crypto"
import type { MemoryStore } from "../memory/json-memory.js"
import { GOVERNANCE_WRITE_KEYS } from "./write-scope.js"
import { ScopedMemory } from "../memory/scoped-memory.js"

/**
 * v0.7 (H7) — the approval ledger.
 *
 * The defect this fixes: the pipeline persisted an artifact BEFORE reviewing it,
 * and treated the mere presence of that file as proof the stage was finished. A
 * crash inside the review therefore resumed with an UNAPPROVED artifact already
 * handed downstream — for `reasoningContext` that means the production half was
 * built from a handoff no human ever agreed to.
 *
 * The fix is to make "approved" a fact that has to be *recorded against the
 * exact thing that was reviewed*, rather than inferred from a file's existence:
 *
 *   ARTIFACT SIGNATURE   — sha256 of the content put in front of the reviewer.
 *   DEPENDENCY SIGNATURE — sha256 over the content signatures of the upstream
 *                          artifacts the decision was made against.
 *
 * Both must match for a resume to skip the checkpoint. Any change to the
 * artifact or to what it was built from invalidates the approval and forces a
 * fresh review, which is the only safe reading: an approval is consent to
 * *something specific*, and "something" has an identity.
 *
 * `authority` records WHO decided. `auto` is a machine disposition, never a
 * human one, and the two are kept distinguishable so an automated run can never
 * be read as though a person signed it off.
 */

export type ApprovalAuthority = "human" | "auto"

export interface StageApprovalRecord {
  stage: string
  /** sha256 of the reviewed artifact content. */
  artifactSignature: string
  /** sha256 over the content signatures of the upstream artifacts. */
  dependencySignature: string
  decidedAt: string
  authority: ApprovalAuthority
  /** True when the reviewer hand-edited the artifact before approving. */
  modified: boolean
}

/** The identity of a proposal, as put to the reviewer. */
export interface StageProposal {
  stage: string
  artifactSignature: string
  dependencySignature: string
}

export type ApprovalLedgerFile = Record<string, StageApprovalRecord>

/** sha256 of any JSON-serializable value, stable under key reordering. */
export function contentSignature(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

/**
 * A dependency signature over the upstream artifacts actually consumed.
 *
 * Derived from the stages already completed in this run, in pipeline order, so
 * it changes if and only if what the stage was built from changed. An empty
 * upstream (the first stage) yields the hash of `[]`, never an empty string, so
 * "no dependencies" is a real value and not a missing one.
 */
export function dependencySignature(dependencies: Readonly<Record<string, unknown>>): string {
  return contentSignature(
    Object.keys(dependencies)
      .sort()
      .map((key) => [key, contentSignature(dependencies[key])]),
  )
}

/**
 * Reads and writes approvals through a governance-scoped store, so recording a
 * decision is itself subject to the same physical boundary as everything else:
 * a production stage cannot forge an approval by writing the key directly.
 */
export class ApprovalLedger {
  private readonly store: MemoryStore

  constructor(memory: MemoryStore) {
    this.store = new ScopedMemory(memory, new Set(GOVERNANCE_WRITE_KEYS))
  }

  async get(stage: string): Promise<StageApprovalRecord | null> {
    const all = (await this.store.get<ApprovalLedgerFile>("approved")) ?? {}
    return all[stage] ?? null
  }

  async record(record: StageApprovalRecord): Promise<void> {
    const all = (await this.store.get<ApprovalLedgerFile>("approved")) ?? {}
    all[record.stage] = record
    await this.store.save("approved", all)
  }

  /**
   * Whether this exact proposal was already decided.
   *
   * Returns false — "must be reviewed" — for every case that is not a confirmed
   * match: no record, a different artifact, changed dependencies, or a record in
   * the legacy timestamp-only shape that predates content binding. A decision we
   * cannot attribute to specific content is not a decision we can honour.
   */
  async isApproved(proposal: StageProposal): Promise<boolean> {
    const record = await this.get(proposal.stage)
    if (record === null) return false
    if (record.authority !== "human" || record.stage !== proposal.stage) return false
    if (typeof record.artifactSignature !== "string") return false
    if (typeof record.dependencySignature !== "string") return false
    return (
      record.artifactSignature === proposal.artifactSignature &&
      record.dependencySignature === proposal.dependencySignature
    )
  }

  /** Every approval on record, for inspection. */
  async all(): Promise<ApprovalLedgerFile> {
    return (await this.store.get<ApprovalLedgerFile>("approved")) ?? {}
  }
}

/** JSON with object keys sorted recursively, so signatures are order-independent. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null"
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== "object") return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const result: Record<string, unknown> = {}
  for (const [key, entry] of entries) result[key] = sortValue(entry)
  return result
}
