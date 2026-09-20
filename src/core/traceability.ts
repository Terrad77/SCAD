import type {
  Claim,
  ClaimConfidenceAssessment,
  Contradiction,
  Evidence,
  HypothesisVerification,
  Narrative,
  ResearchIntelligenceReport,
  ResearchOutput,
  ResearchGap,
  Shot,
  Source,
} from "./schemas.js"

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
  /** Evidence Engine extras (optional for backward compatibility). */
  evidenceIds?: string[]
  evidenceStatements?: string[]
  contradictionIds?: string[]
  gapIds?: string[]
  verification?: { status: string; confidence: number }
  /** v0.4 intelligence: claim confidence assessment + explicit uncertainty. */
  assessment?: { status: string; confidence: number }
  uncertainties?: Array<{ kind: string; detail: string }>
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

export interface TraceExtras {
  evidence?: Evidence[]
  contradictions?: Contradiction[]
  gaps?: ResearchGap[]
  verifications?: HypothesisVerification[]
  sources?: Source[]
  intelligence?: ResearchIntelligenceReport
}

function findVerification(
  claimIds: string[],
  claimEvidenceIds: string[],
  verifications: HypothesisVerification[],
): HypothesisVerification | undefined {
  if (claimEvidenceIds.length === 0) {
    return verifications.find((v) => claimIds.includes(v.hypothesisId))
  }
  return verifications.find((v) => {
    if (claimIds.includes(v.hypothesisId)) return true
    return (
      v.supportingEvidence.some((eid) => claimEvidenceIds.includes(eid)) ||
      v.contradictingEvidence.some((eid) => claimEvidenceIds.includes(eid))
    )
  })
}

function verificationSummary(
  v: HypothesisVerification | undefined,
): { status: string; confidence: number } | undefined {
  return v ? { status: v.status, confidence: v.confidence } : undefined
}

function findAssessment(
  claimIds: string[],
  intelligence: ResearchIntelligenceReport,
): ClaimConfidenceAssessment | undefined {
  for (const id of claimIds) {
    const assessment = intelligence.claims.find((a) => a.claimId === id)
    if (assessment) return assessment
  }
  return undefined
}

/**
 * Builds a full traceability chain:
 * Shot → Narrative sentence → Claim → Evidence → Source.
 * When a ResearchBundle (evidence, gaps, contradictions, verifications) is
 * provided every entry is enriched with the evidence statements that back its
 * claims, plus any contradictions or research gaps touching those claims.
 */
export function buildTraceabilityReport(
  shots: Shot[],
  narrative: Narrative,
  claims: Claim[],
  research: ResearchOutput,
  extras: TraceExtras = {},
): TraceabilityReport {
  const claimMap = new Map(claims.map((c) => [c.id, c]))
  const sourceMap = new Map(research.sources.map((s) => [s.id, s]))
  const evidenceById = new Map((extras.evidence ?? []).map((e) => [e.id, e]))
  const sentenceMap = new Map(
    narrative.sections.flatMap((s) => s.sentences.map((sn) => [sn.id, sn])),
  )

  const entries: TraceEntry[] = shots.map((shot) => {
    const sentenceId = shot.narrativeSentenceIds[0] ?? ""
    const sentence = sentenceMap.get(sentenceId)
    const claimIds = sentence?.claimIds ?? []
    const resolvedClaims = claimIds.map((id) => claimMap.get(id)).filter(Boolean) as Claim[]

    const resolvedEvidence = extras.evidence
      ? resolvedClaims.flatMap((c) =>
          (c.evidenceIds ?? [])
            .map((id) => evidenceById.get(id))
            .filter((e): e is Evidence => Boolean(e)),
        )
      : []
    const contradictionIds = extras.contradictions
      ? extras.contradictions
          .filter((c) => claimIds.includes(c.claimA) || claimIds.includes(c.claimB))
          .map((c) => c.id)
      : []
    const gapIds = extras.gaps
      ? extras.gaps
          .filter((g) => g.relatedClaims.some((id) => claimIds.includes(id)))
          .map((g) => g.id)
      : []
    const claimEvidenceIds = resolvedClaims.flatMap((c) => c.evidenceIds ?? [])
    const verification = extras.verifications
      ? verificationSummary(findVerification(claimIds, claimEvidenceIds, extras.verifications))
      : undefined
    const assessment = extras.intelligence
      ? findAssessment(claimIds, extras.intelligence)
      : undefined
    const uncertainties = extras.intelligence
      ? extras.intelligence.uncertainties.filter((u) => claimIds.includes(u.subjectId))
      : undefined

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
      ...(extras.evidence
        ? {
            evidenceIds: resolvedEvidence.map((e) => e.id),
            evidenceStatements: resolvedEvidence.map((e) => e.statement),
          }
        : {}),
      ...(extras.contradictions ? { contradictionIds } : {}),
      ...(extras.gaps ? { gapIds } : {}),
      ...(extras.verifications && verification ? { verification } : {}),
      ...(assessment ? { assessment } : {}),
      ...(uncertainties && uncertainties.length > 0
        ? { uncertainties: uncertainties.map((u) => ({ kind: u.kind, detail: u.detail })) }
        : {}),
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
