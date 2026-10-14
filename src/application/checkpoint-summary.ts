import type { PipelineStage } from "../core/pipeline.js"
import type {
  ClaimsOutput,
  HypothesesOutput,
  FactCheckOutput,
  Narrative,
  VisualOutput,
  SelfCheckOutput,
  ResearchBundle,
} from "../core/schemas.js"
import type { ReasoningContext } from "../core/production/types.js"
import type { EpistemicPreparationResult } from "../agents/production/epistemic-prep.js"

/** Summaries supplement the complete raw candidate; they never change its verdict. */
export function checkpointSummary(stage: PipelineStage, value: unknown): string[] {
  switch (stage) {
    case "research":
      return [(value as ResearchBundle).summary]
    case "claims":
      return (value as ClaimsOutput).claims.map((c) => `${c.id} · ${c.knowledge}: ${c.statement}`)
    case "hypotheses":
      return (value as HypothesesOutput).hypotheses.map(
        (h) => `${h.id} · ${h.status}: ${h.statement}`,
      )
    case "factCheck":
      return (value as FactCheckOutput).assessments.map(
        (a) => `${a.claimId} · ${a.verdict}${a.notes ? ": " + a.notes : ""}`,
      )
    case "epistemicPreparation": {
      const p = value as EpistemicPreparationResult
      return [
        "Reference date: " + p.referenceDate,
        "Intelligence source: " + p.resolution.source,
        p.report
          ? "Completeness: " + p.report.completeness.status
          : "Intelligence report unavailable",
      ]
    }
    case "reasoningContext": {
      const c = value as ReasoningContext
      return [
        c.question,
        `${c.claims.length} claims · ${c.activeHypotheses.length} active hypotheses · ${c.uncertainties.length} uncertainties · ${c.constraints.length} constraints`,
      ]
    }
    case "narrative": {
      const n = value as Narrative
      return [
        n.title,
        n.logline,
        n.thesis,
        ...n.sections.flatMap((s) => [
          s.heading,
          ...s.sentences.map(
            (sentence) => `${sentence.id} · ${sentence.knowledge}: ${sentence.text}`,
          ),
        ]),
      ]
    }
    case "visual":
      return (value as VisualOutput).shots.map(
        (s) => `${s.id} · ${s.visualType}: ${s.description} · Narration: ${s.narration}`,
      )
    case "selfCheck": {
      const s = value as SelfCheckOutput
      return [
        "Production audit: " + (s.production?.verdict ?? "UNVERIFIED"),
        ...(s.production?.checks ?? []).map(
          (check) => `${check.id} · ${check.status}: ${check.detail}`,
        ),
        ...(s.production?.narrativeReferences
          ? [
              "Narrative references: structure " +
                s.production.narrativeReferences.structuralStatus +
                "; semantics " +
                s.production.narrativeReferences.semanticStatus,
            ]
          : []),
        ...[...s.critical, ...s.warnings, ...s.info].map(
          (i) => `${i.severity} · ${i.type}: ${i.detail}`,
        ),
      ]
    }
  }
}
