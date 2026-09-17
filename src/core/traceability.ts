import type { Claim, Narrative, ResearchOutput, Shot } from "./schemas.js"

export interface TraceEntry {
  shotId: string
  narrativeSentenceId: string
  narrativeText: string
  knowledge: string
  claimIds: string[]
  claimStatements: string[]
  sourceIds: string[]
  sourceTitles: string[]
  evidence: string[]
  confidence: number
}

export interface TraceabilityReport {
  entries: TraceEntry[]
  summary: {
    totalShots: number
    fullyTraced: number
    partiallyTraced: number
    untraced: number
  }
}

/**
 * Builds a full traceability chain:
 * Shot → Narrative sentence → Claim → Evidence → Source.
 */
export function buildTraceabilityReport(
  shots: Shot[],
  narrative: Narrative,
  claims: Claim[],
  research: ResearchOutput,
): TraceabilityReport {
  const claimMap = new Map(claims.map((c) => [c.id, c]))
  const sourceMap = new Map(research.sources.map((s) => [s.id, s]))
  const sentenceMap = new Map(
    narrative.sections.flatMap((s) => s.sentences.map((sn) => [sn.id, sn])),
  )

  const entries: TraceEntry[] = shots.map((shot) => {
    const sentenceId = shot.narrativeSentenceIds[0] ?? ""
    const sentence = sentenceMap.get(sentenceId)
    const claimIds = sentence?.claimIds ?? []
    const resolvedClaims = claimIds.map((id) => claimMap.get(id)).filter(Boolean) as Claim[]

    return {
      shotId: shot.id,
      narrativeSentenceId: sentenceId,
      narrativeText: sentence?.text ?? "",
      knowledge: sentence?.knowledge ?? "",
      claimIds,
      claimStatements: resolvedClaims.map((c) => c.statement),
      sourceIds: resolvedClaims.flatMap((c) => c.sources),
      sourceTitles: resolvedClaims.flatMap((c) =>
        c.sources.map((sid) => sourceMap.get(sid)?.title ?? sid),
      ),
      evidence: resolvedClaims.flatMap((c) => c.evidence),
      confidence: resolvedClaims.length
        ? resolvedClaims.reduce((s, c) => s + c.confidence, 0) / resolvedClaims.length
        : 0,
    }
  })

  const fullyTraced = entries.filter((e) => e.claimIds.length > 0 && e.sourceIds.length > 0).length
  const partiallyTraced = entries.filter(
    (e) => e.claimIds.length > 0 !== e.sourceIds.length > 0,
  ).length
  const untraced = entries.filter((e) => e.claimIds.length === 0 && e.sourceIds.length === 0).length

  return {
    entries,
    summary: { totalShots: shots.length, fullyTraced, partiallyTraced, untraced },
  }
}
