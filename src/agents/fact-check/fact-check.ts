import type {
  Claim,
  ClaimAssessment,
  ClaimStatus,
  ResearchOutput,
  Source,
} from "../../core/schemas.js"

const reliabilityOf = (source: Source): number => source.reliability ?? 0.5

/**
 * Deterministic fact checker. Verifies each claim's sources and evidence against
 * the research output and recomputes a source-aware confidence.
 */
export class FactCheckEngine {
  constructor(private readonly research: ResearchOutput) {}

  run(claims: Claim[]): ClaimAssessment[] {
    const sourceById = new Map<string, Source>(this.research.sources.map((s) => [s.id, s]))
    return claims.map((claim) => this.assess(claim, sourceById))
  }

  private assess(claim: Claim, sourceById: Map<string, Source>): ClaimAssessment {
    const owned = claim.sources.filter((id) => sourceById.has(id))
    const dangling = claim.sources.filter((id) => !sourceById.has(id))
    const evidence = claim.evidence.length
    const hasEvidence = evidence > 0

    let verdict: ClaimStatus = "SUPPORTED"
    const issues: string[] = []
    if (claim.sources.length === 0) {
      verdict = "UNSUPPORTED"
      issues.push("no source")
    } else if (owned.length === 0) {
      verdict = "PARTIAL"
      issues.push(`all sources unknown to research (${dangling.join(", ")})`)
    } else if (dangling.length > 0) {
      verdict = "PARTIAL"
      issues.push(`some sources unknown to research (${dangling.join(", ")})`)
    }
    if (!hasEvidence) {
      verdict = verdict === "SUPPORTED" ? "PARTIAL" : verdict
      issues.push("no evidence")
    }

    const reliability = owned.length
      ? owned.reduce((sum, id) => sum + reliabilityOf(sourceById.get(id)!), 0) / owned.length
      : 0.5
    const confidence = Math.max(0, Math.min(1, claim.confidence * (0.4 + 0.6 * reliability)))
    const notes = issues.length
      ? `[${verdict}] ${issues.join("; ")}`
      : `[${verdict}] source-aware confidence ${confidence.toFixed(2)}`

    return { claimId: claim.id, verdict, confidence, notes }
  }
}

/** Builds an evidence chain: narrative sentence → claim → evidence → source. */
export function buildEvidenceChain(
  claims: Claim[],
  research: ResearchOutput,
): Array<{ claimId: string; evidence: string[]; sources: string[] }> {
  const sourceById = new Map(research.sources.map((s) => [s.id, s.title]))
  return claims.map((claim) => ({
    claimId: claim.id,
    evidence: claim.evidence,
    sources: claim.sources.map((id) => sourceById.get(id) ?? id),
  }))
}
