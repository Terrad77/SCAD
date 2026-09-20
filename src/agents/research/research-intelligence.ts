import type {
  EvidenceQuality,
  HypothesisVerification,
  ResearchBundle,
  ResearchIntelligenceReport,
  SourceRelationshipRecord,
  VerificationResult,
} from "../../core/schemas.js"
import { computeEvidenceQuality } from "../../core/evidence/evidence-quality.js"
import {
  analyzeSourceIndependence,
  mergeRelationships,
} from "../../core/evidence/source-independence.js"
import { assessClaims } from "../../core/evidence/claim-assessment.js"
import { analyzeContradictions } from "../../core/evidence/contradiction-analysis.js"
import {
  computeResearchCompleteness,
  evaluateStoppingCriteria,
} from "../../core/evidence/completeness.js"
import { collectUncertainties } from "../../core/evidence/uncertainty.js"
import { enrichVerification } from "../hypothesis/verify.js"
import { getLogger } from "../../core/log.js"

export interface ResearchIntelligenceOptions {
  research: ResearchBundle
  /** Base verifications produced by the hypotheses stage (may be empty). */
  verifications?: HypothesisVerification[]
  /** ISO date for freshness + generatedAt (defaults to run time). */
  referenceDate?: string
  /** Resource caps so the stopping criteria never force an endless loop. */
  limits?: {
    maxSources?: number
    maxSubQuestions?: number
    maxFollowUpRounds?: number
    maxIterations?: number
  }
  /** Optional structured source relationships from an LLM stage (validated). */
  relationshipOverrides?: SourceRelationshipRecord[]
}

const MAX_RECOMMENDATIONS = 8

/**
 * Research Intelligence engine (v0.4).
 *
 * Turns a ResearchBundle + verifications into a deterministic, explainable
 * intelligence report: evidence quality, source independence, claim
 * confidence 2.0, contradiction analysis, research completeness, hypothesis
 * verification 2.0 and explicit uncertainty — plus a stopping-criteria
 * recommendation. All calculations are pure and offline-capable; the LLM never
 * drives these scores.
 */
export class ResearchIntelligenceEngine {
  constructor(private readonly options: ResearchIntelligenceOptions) {}

  run(): ResearchIntelligenceReport {
    const { research, referenceDate } = this.options
    const { plan, sources, evidence, claims, contradictions, gaps, queries } = research
    const sourceById = new Map(sources.map((s) => [s.id, s]))

    // 1. Evidence quality for every evidence item.
    const evidenceQuality = evidence.map((ev) =>
      computeEvidenceQuality({
        evidence: ev,
        source: sourceById.get(ev.sourceId),
        referenceDate,
      }),
    )
    const qualityByEvidence = new Map<string, EvidenceQuality>(
      evidenceQuality.map((q) => [q.evidenceId, q]),
    )

    // 2. Source independence (deterministic; LLM overrides merge on top).
    const baseIndependence = analyzeSourceIndependence(sources)
    const independence = this.options.relationshipOverrides?.length
      ? mergeRelationships(
          baseIndependence.relationships,
          this.options.relationshipOverrides,
          sources,
        )
      : baseIndependence

    // 3. Claim Confidence 2.0.
    const claimAssessments = assessClaims({
      claims,
      evidence,
      sources,
      qualityByEvidence,
      contradictions,
      gaps,
    })

    // 4. Contradiction Analysis 2.0 (claim support strength feeds the context call).
    const claimQuality = new Map(claimAssessments.map((a) => [a.claimId, a.supportStrength]))
    const contradictionAnalyses = analyzeContradictions(
      contradictions,
      claims,
      evidence,
      qualityByEvidence,
      claimQuality,
    )

    // 5. Research completeness.
    const completeness = computeResearchCompleteness({
      plan,
      claims,
      evidence,
      sources,
      gaps,
      contradictions,
      contradictionsAnalysis: contradictionAnalyses,
      claimAssessments,
      independence,
      qualityByEvidence,
    })

    // 6. Explicit uncertainty across claims and the research as a whole.
    const researchId = plan?.id ?? research.question
    const uncertainties = collectUncertainties({
      claims,
      evidence,
      claimAssessments,
      contradictionAnalyses,
      researchGaps: gaps,
      qualityByEvidence,
      researchId,
    })

    // 7. Hypothesis Verification 2.0.
    const hypotheses: VerificationResult[] = (this.options.verifications ?? []).map(
      (verification, index) =>
        enrichVerification({
          verification,
          sources,
          qualityByEvidence,
          contradictionsAnalysis: contradictionAnalyses,
          index,
        }),
    )

    // 8. Stopping criteria against the resources that were actually used.
    const stopping = evaluateStoppingCriteria({
      completeness,
      claims: claimAssessments,
      resources: {
        sourcesUsed: sources.length,
        queriesUsed: queries.length,
        followUpRoundsUsed: queries.length > plan.subQuestions.length ? 1 : 0,
      },
      limits: this.options.limits,
    })

    const recommendations = this.buildRecommendations(completeness, stopping.reasons)

    return {
      question: research.question,
      questionId: researchId,
      generatedAt: referenceDate ?? new Date().toISOString(),
      completeness,
      claims: claimAssessments,
      evidenceQuality,
      sourceIndependence: independence,
      contradictions: contradictionAnalyses,
      hypotheses,
      unresolvedGaps: completeness.unresolvedGaps,
      unresolvedContradictions: completeness.unresolvedContradictions,
      uncertainties,
      continueResearch: stopping.continueResearch,
      stopping,
      recommendations,
    }
  }

  /** Deduped, capped, deterministic recommendation list. */
  private buildRecommendations(
    completeness: ResearchIntelligenceReport["completeness"],
    stoppingReasons: string[],
  ): string[] {
    const seen = new Set<string>()
    const ordered = [
      ...completeness.recommendations,
      ...stoppingReasons.filter((r) => !r.startsWith("research stopped:")),
    ]
    const result: string[] = []
    for (const item of ordered) {
      if (seen.has(item) || result.length >= MAX_RECOMMENDATIONS) continue
      seen.add(item)
      result.push(item)
    }
    return result
  }
}

/** Convenience wrapper: builds a report without keeping an engine instance. */
export function researchIntelligence(
  research: ResearchBundle,
  verifications: HypothesisVerification[] = [],
  referenceDate?: string,
): ResearchIntelligenceReport {
  const report = new ResearchIntelligenceEngine({
    research,
    verifications,
    referenceDate,
  }).run()
  getLogger().info(
    "intelligence",
    `completeness ${report.completeness.status} (${report.completeness.score.toFixed(2)}); continueResearch ${report.continueResearch}`,
  )
  return report
}
