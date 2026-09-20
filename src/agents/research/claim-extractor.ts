import { ClaimsOutputSchema } from "../../core/schemas.js"
import type { Claim, ClaimsOutput, Evidence } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import { getLogger } from "../../core/log.js"
import { CLAIM_PREFIX, makeId } from "./ids.js"

export interface ClaimExtractionInput {
  question: string
  evidence: Evidence[]
  /**
   * Index base for deterministic claim ids. The engine threads this through
   * so ids stay globally unique across the initial and follow-up rounds.
   */
  claimIdStart?: number
}

/**
 * Extracts claims from evidence. Claims must cite their supporting evidence
 * ids and sources; the engine re-links evidence back to claims afterwards.
 */
export class ClaimExtractor {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: ClaimExtractionInput): Promise<Claim[]> {
    // Claim extraction has a deterministic fallback (`deriveClaimsFromEvidence`),
    // so a single validated attempt is enough.
    const output = await this.agent.run<typeof ClaimsOutputSchema>(
      "claim-extraction",
      ClaimsOutputSchema,
      {
        question: input.question,
        evidence: input.evidence.map((ev) => ({
          id: ev.id,
          sourceId: ev.sourceId,
          statement: ev.statement,
          location: ev.location,
        })),
      },
      { maxRetries: 0 },
    )
    return this.normalize(output, input.evidence, input.claimIdStart ?? 0)
  }

  private normalize(output: ClaimsOutput, evidence: Evidence[], claimIdStart: number): Claim[] {
    const evidenceById = new Map(evidence.map((ev) => [ev.id, ev]))
    return output.claims.map((claim, index) => {
      const ids = (claim.evidenceIds ?? []).filter((id) => evidenceById.has(id))
      if (ids.length === 0) {
        getLogger().warn(
          "claims",
          `Claim ${claim.id} references no known evidence; keeping source list only.`,
        )
      }
      const sources =
        claim.sources.length > 0
          ? claim.sources
          : dedupeSources(ids.map((id) => evidenceById.get(id)!.sourceId))
      return {
        ...claim,
        // Always re-key: the engine owns ids and keeps them unique across runs.
        id: makeId(CLAIM_PREFIX, claimIdStart + index + 1),
        evidenceIds: ids,
        sources,
      }
    })
  }
}

function dedupeSources(ids: string[]): string[] {
  return [...new Set(ids)]
}

/**
 * Deterministic fallback: derives one claim per piece of evidence. Used when
 * the LLM claim-extraction stage is unavailable or its output is invalid, so
 * the research reports still list every evidence-backed claim.
 */
export function deriveClaimsFromEvidence(evidence: Evidence[], claimIdStart = 0): Claim[] {
  let counter = 0
  return evidence
    .map((ev): Claim | null => {
      if (ev.confidence < 0.5) return null
      counter += 1
      return {
        id: makeId(CLAIM_PREFIX, claimIdStart + counter),
        statement: ev.statement,
        sources: [ev.sourceId],
        evidence: [ev.statement],
        evidenceIds: [ev.id],
        confidence: ev.confidence,
        status: ev.confidence >= 0.7 ? "SUPPORTED" : "PARTIAL",
        knowledge: ev.confidence >= 0.7 ? "FACT" : "SCIENTIFIC_HYPOTHESIS",
      }
    })
    .filter((claim): claim is Claim => Boolean(claim))
}
