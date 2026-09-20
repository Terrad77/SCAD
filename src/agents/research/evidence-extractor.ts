import { EvidenceOutputSchema } from "../../core/schemas.js"
import type { Evidence, EvidenceOutput } from "../../core/schemas.js"
import { StructuredAgent } from "../../core/structured-agent.js"
import { computeEvidenceConfidence, clamp } from "../../core/evidence/confidence.js"
import { EVIDENCE_PREFIX, makeId } from "./ids.js"

export interface EvidenceExtractionInput {
  question: string
  subquestion: string
  sources: Array<{
    id: string
    title: string
    url?: string
    snippet?: string
    reliability?: number
    /** Optional full page text from a ContentProvider. */
    content?: string
  }>
  /**
   * Index base for deterministic evidence ids. The engine threads this through
   * per-query so ids stay globally unique across queries and follow-up rounds.
   */
  evidenceIdStart?: number
}

/**
 * Extracts an explicit Evidence entity for each source. Evidence always
 * remains connected to its source. Raw LLM confidence is overridden by the
 * deterministic confidence calculator afterwards in `ResearchEngine`.
 */
export class EvidenceExtractor {
  constructor(private readonly agent: StructuredAgent) {}

  async run(input: EvidenceExtractionInput): Promise<Evidence[]> {
    // Evidence extraction has a deterministic fallback (`buildFallbackEvidence`),
    // so a single validated attempt is enough — never burn retries on it.
    const output = await this.agent.run<typeof EvidenceOutputSchema>(
      "evidence-extraction",
      EvidenceOutputSchema,
      {
        question: input.question,
        subquestion: input.subquestion,
        sources: input.sources,
      },
      { maxRetries: 0 },
    )
    return this.canonicize(output, input.sources, input.evidenceIdStart ?? 0)
  }

  private canonicize(
    output: EvidenceOutput,
    sources: EvidenceExtractionInput["sources"],
    evidenceIdStart: number,
  ): Evidence[] {
    const sourceById = new Map(sources.map((s) => [s.id, s]))
    return output.evidence.map((ev, index) => {
      const source = sourceById.get(ev.sourceId)
      const reliability = source?.reliability ?? 0.5
      return {
        ...ev,
        // Always re-key: the engine owns ids and keeps them unique across runs.
        id: makeId(EVIDENCE_PREFIX, evidenceIdStart + index + 1),
        confidence: computeEvidenceConfidence({ sourceReliability: reliability }),
      }
    })
  }
}

/**
 * Deterministic fallback: builds one evidence item per source from its title
 * and snippet, so the engine produces evidence even when the LLM stage is not
 * available (offline/no canned response).
 */
export function buildFallbackEvidence(input: EvidenceExtractionInput): Evidence[] {
  const evidenceIdStart = input.evidenceIdStart ?? 0
  return input.sources
    .filter((src) => src.title && src.title.length > 0)
    .map((src, index) => {
      const reliability = clamp(src.reliability ?? 0.5)
      return {
        id: makeId(EVIDENCE_PREFIX, evidenceIdStart + index + 1),
        sourceId: src.id,
        statement: `From "${src.title}": ${src.snippet ?? "available background material."}`,
        excerpt: src.snippet,
        location: src.url,
        supportsClaims: [],
        contradictsClaims: [],
        confidence: computeEvidenceConfidence({ sourceReliability: reliability }),
      }
    })
}
