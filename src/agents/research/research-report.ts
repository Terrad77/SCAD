import type { Evidence, Hypothesis, ResearchBundle } from "../../core/schemas.js"

/**
 * Renders a human-readable markdown research report from a ResearchBundle.
 * Machine-readable JSON files are exported separately by the storage layer.
 */
export function renderResearchReport(
  bundle: ResearchBundle,
  hypotheses: Hypothesis[] = [],
): string {
  const lines: string[] = []
  lines.push(`# Research Report`)
  lines.push("")
  lines.push(`**Research Question:** ${bundle.question}`)
  lines.push("")
  lines.push(`## Research Scope`)
  lines.push("")
  lines.push(`Plan: ${bundle.plan.id} — ${bundle.plan.scope ?? bundle.plan.question}`)
  lines.push(`Sub-questions: ${bundle.plan.subQuestions.length}`)
  lines.push(`Search queries: ${bundle.queries.length}`)
  lines.push(`Sources collected: ${bundle.sources.length}`)
  lines.push(`Evidence extracted: ${bundle.evidence.length}`)
  lines.push(`Claims: ${bundle.claims.length}`)
  lines.push(`Contradictions: ${bundle.contradictions.length}`)
  lines.push(`Research gaps: ${bundle.gaps.length}`)
  lines.push("")
  lines.push(`## Sources`)
  lines.push("")
  if (bundle.sources.length === 0) lines.push("No sources were collected.")
  for (const source of bundle.sources) {
    const reliability = source.reliability?.toFixed(2) ?? "n/a"
    const relevance = source.relevance?.toFixed(2) ?? "n/a"
    lines.push(
      `- **[${source.id}]** ${source.title} (${source.type}) — reliability ${reliability}, relevance ${relevance}${source.url ? ` — ${source.url}` : ""}`,
    )
  }
  lines.push("")
  lines.push(`## Key Findings`)
  lines.push("")
  if (bundle.evidence.length === 0) lines.push("No evidence was extracted.")
  for (const evidence of bundle.evidence) {
    const source = bundle.sources.find((s) => s.id === evidence.sourceId)
    lines.push(
      `- **Evidence [${evidence.id}]** (source ${evidence.sourceId}${source ? `: ${source.title}` : ""}) — ${evidence.statement}`,
    )
  }
  lines.push("")
  lines.push(`## Claims`)
  lines.push("")
  if (bundle.claims.length === 0) lines.push("No claims were extracted.")
  for (const claim of bundle.claims) {
    lines.push(
      `- **${claim.id}** [${claim.knowledge}] (${claim.status}, confidence ${claim.confidence.toFixed(2)}) — ${claim.statement}`,
    )
    if (claim.evidenceIds?.length) lines.push(`  - Evidence: ${claim.evidenceIds.join(", ")}`)
  }
  lines.push("")
  lines.push(`## Conflicting Evidence`)
  lines.push("")
  if (bundle.contradictions.length === 0) lines.push("No contradictions detected.")
  for (const c of bundle.contradictions) {
    lines.push(
      `- **[${c.id}]** ${c.claimA} vs ${c.claimB} — ${c.severity} (${c.classification}) — ${c.explanation}`,
    )
  }
  lines.push("")
  lines.push(`## Research Gaps`)
  lines.push("")
  if (bundle.gaps.length === 0) lines.push("No research gaps detected.")
  for (const gap of bundle.gaps) {
    lines.push(`- **[${gap.id}]** (importance ${gap.importance.toFixed(2)}) — ${gap.question}`)
    for (const q of gap.suggestedResearchQueries.slice(0, 2)) {
      lines.push(`  - Query: ${q}`)
    }
  }
  lines.push("")
  if (hypotheses.length > 0) {
    lines.push(`## Hypotheses`)
    lines.push("")
    for (const h of hypotheses) {
      lines.push(
        `- **${h.id}** [${h.status}] (confidence ${h.confidence.toFixed(2)}) — ${h.statement}`,
      )
      if (h.supportingEvidence.length)
        lines.push(`  - Supporting evidence: ${h.supportingEvidence.join(", ")}`)
      if (h.contradictingEvidence.length)
        lines.push(`  - Contradicting evidence: ${h.contradictingEvidence.join(", ")}`)
      if (h.researchGaps.length) lines.push(`  - Research gaps: ${h.researchGaps.join(", ")}`)
    }
    lines.push("")
  }
  lines.push(`## Confidence & Limitations`)
  lines.push("")
  lines.push("Confidence values are computed deterministically from source reliability,")
  lines.push("evidence agreement and evidence strength. They do not represent absolute")
  lines.push("truth. This report preserves the evidence chain so every claim can be traced")
  lines.push("back to its sources.")
  lines.push("")
  lines.push(`*Report generated for SCAD project. Question: ${bundle.question}*`)
  return lines.join("\n")
}

export function summarizeEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) return "No evidence."
  return `${evidence.length} pieces of evidence across ${new Set(evidence.map((e) => e.sourceId)).size} sources.`
}
