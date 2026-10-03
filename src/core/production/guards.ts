import type { KnowledgeLevel, Narrative, Shot, VisualOutput } from "../types.js"
import { findConstraint } from "./constraints.js"
import { claimTraceEdges, edgeIsBacked } from "./coverage.js"
import { artifactContentSignature } from "./signature.js"
import {
  enforceKnowledgeCeiling,
  isVisualTypePermitted,
  visualTypeFallback,
  weakestPosture,
} from "./integrity.js"
import {
  PRODUCTION_PROVENANCE_VERSION,
  type ProductionDependency,
  type ProductionNormalization,
  type ProductionProvenance,
  type ProductionViolation,
  type ReasoningContext,
} from "./types.js"

/**
 * v0.7 — Deterministic production guards (§9).
 *
 * The guards run AFTER the LLM and BEFORE persistence, so a generated artifact
 * can never enter production carrying a claim stronger than the reasoning
 * context permits. They are the machine-checkable counterpart of the prompt
 * instructions in `prompts/narrative.md` / `prompts/visual.md`.
 *
 * Two rules define their limits:
 *
 *  1. ONLY DOWNGRADE. A guard may weaken a knowledge label, replace an
 *     impermissible visual type with the weakest permitted one, or detach an
 *     unbacked provenance reference. It never adds, deletes or rewrites text —
 *     so uncertainty, gaps and contradictions cannot vanish by being
 *     "cleaned up" (I12, I13).
 *  2. REPORT, DON'T HIDE. Every correction is recorded as a
 *     `ProductionNormalization`; every unfixable break is recorded as a
 *     `ProductionViolation`. Both land in the artifact's provenance and are
 *     re-audited independently by SelfCheck (§10).
 */

export interface GuardResult<T> {
  artifact: T
  provenance: ProductionProvenance
}

function provenanceBase(
  context: ReasoningContext,
  violations: ProductionViolation[],
  normalizations: ProductionNormalization[],
  satisfied: Set<string>,
  dependencies: ProductionDependency[],
): ProductionProvenance {
  return {
    version: PRODUCTION_PROVENANCE_VERSION,
    contextVersion: context.version,
    inputSignature: context.inputSignature,
    contextSignature: context.contextSignature,
    reasoningCycleId: context.reasoningCycleId,
    project: context.project,
    question: context.question,
    satisfiedConstraints: [...satisfied].sort(),
    violations,
    normalizations,
    dependencies,
  }
}

function satisfiedFrom(
  context: ReasoningContext,
  violations: ProductionViolation[],
  kind: Parameters<typeof findConstraint>[1],
): string[] {
  const ids = context.constraints.filter((c) => c.kind === kind).map((c) => c.id)
  const broken = new Set(violations.filter((v) => v.kind === kind).map((v) => v.constraintId ?? ""))
  return ids.filter((id) => !broken.has(id))
}

/**
 * The constraints a violation actually broke.
 *
 * Most production constraints are per-subject (`...#CLM_002`), so looking one
 * up by kind alone finds nothing and every violation would be attributed to
 * `null` — making it impossible to tell a satisfied constraint from a broken
 * one. This resolves the constraint for each subject, and falls back to the
 * global constraint of that kind when one exists.
 */
function constraintsForSubjects(
  context: ReasoningContext,
  kind: Parameters<typeof findConstraint>[1],
  subjects: readonly string[],
): Array<string | null> {
  const specific = subjects
    .map((subjectId) => findConstraint(context.constraints, kind, subjectId)?.id)
    .filter((id): id is string => id !== undefined)
  if (specific.length > 0) return specific
  return [findConstraint(context.constraints, kind)?.id ?? null]
}

// ---------------------------------------------------------------------------
// Narrative guard (§9.1)
// ---------------------------------------------------------------------------

export function guardNarrative(
  narrative: Narrative,
  context: ReasoningContext,
): GuardResult<Narrative> {
  const violations: ProductionViolation[] = []
  const normalizations: ProductionNormalization[] = []

  const sections = narrative.sections.map((section) => ({
    ...section,
    sentences: section.sentences.map((sentence) => {
      const { level, ceiling, changed } = enforceKnowledgeCeiling(
        sentence.knowledge,
        sentence.claimIds,
        context,
        sentence.text,
        sentence.hypothesisIds,
      )
      if (changed) {
        normalizations.push({
          rule: "KNOWLEDGE_DOWNGRADE",
          subjectId: sentence.id,
          from: sentence.knowledge,
          to: level,
          reason: `knowledge ceiling ${ceiling.level}: ${ceiling.reason}`,
        })
      }

      const label = constraintsForSubjects(context, "DO_NOT_PRESENT_AS_FACT", ceiling.subjectIds)
      if (sentence.knowledge === "FACT" && level !== "FACT") {
        for (const constraintId of label) {
          violations.push({
            kind: "DO_NOT_PRESENT_AS_FACT",
            constraintId,
            severity: "critical",
            subjectIds: [sentence.id, ...ceiling.subjectIds],
            detail: `Sentence ${sentence.id} claimed FACT but rests on ${ceiling.reason}; downgraded to ${level}.`,
            // The downgrade IS the fix, and the postcondition is mechanical:
            // the subject may no longer carry a label more assertive than the
            // ceiling. The audit re-checks it against the persisted artifact
            // rather than believing this flag.
            resolved: changed,
            postcondition: `no sentence in [${[sentence.id, ...ceiling.subjectIds].join(", ")}] is labelled FACT`,
          })
        }
      }

      // Traceability: a FACT sentence must reference claims the context knows
      // AND that reach a source. The claim→evidence→source edge is part of the
      // check, so a claim that resolves but has no evidence cannot pass.
      if (level === "FACT") {
        const unknown = sentence.claimIds.filter(
          (id) => !context.claims.some((claim) => claim.claimId === id),
        )
        const edges = claimTraceEdges(context)
        const unbacked =
          // Only assert an unbacked chain when the context actually carries
          // chain data. A context without edges (older version, hand-edited,
          // mid-flight) tells us nothing about the chain, and inventing a
          // critical violation there would be a fabricated defect.
          edges.length === 0
            ? []
            : sentence.claimIds.filter((id) => {
                const edge = edges.find((e) => e.claimId === id)
                return edge === undefined || !edgeIsBacked(edge)
              })
        if (sentence.claimIds.length === 0 || unknown.length > 0 || unbacked.length > 0) {
          const reasons: string[] = []
          if (sentence.claimIds.length === 0) reasons.push("references no claim")
          if (unknown.length > 0) reasons.push(`unknown claims ${unknown.join(", ")}`)
          if (unbacked.length > 0)
            reasons.push(`claims without an evidence→source chain: ${unbacked.join(", ")}`)
          violations.push({
            kind: "KEEP_TRACEABLE_TO_CLAIMS",
            constraintId:
              findConstraint(context.constraints, "KEEP_TRACEABLE_TO_CLAIMS")?.id ?? null,
            severity: "critical",
            subjectIds: [sentence.id, ...unknown, ...unbacked],
            detail: `Sentence ${sentence.id} is FACT but ${reasons.join("; ")}.`,
            // A label downgrade does NOT make an unbacked reference backed, so
            // this one is never self-resolving.
            resolved: false,
            postcondition: `every claim cited by ${sentence.id} reaches at least one source`,
          })
        }
      }

      // A definitive conclusion is forbidden unless reasoning actually sealed a
      // confident terminal verdict.
      if (
        level !== "FICTION" &&
        /^(conclusion|in conclusion|ultimately|definitively)\b/i.test(sentence.text)
      ) {
        const definitive = findConstraint(context.constraints, "NO_DEFINITIVE_CONCLUSION")
        if (definitive) {
          violations.push({
            kind: "NO_DEFINITIVE_CONCLUSION",
            constraintId: definitive.id,
            severity: definitive.severity,
            subjectIds: [sentence.id],
            detail: `Sentence ${sentence.id} reads as a definitive conclusion while reasoning ended as ${
              context.decision.stoppingKind ?? "unresolved"
            }.`,
            // The guard may not rewrite prose, so this is never self-resolved.
            resolved: false,
            postcondition: `no sentence in [${sentence.id}] reads as a definitive conclusion`,
          })
        }
      }

      return changed ? { ...sentence, knowledge: level as KnowledgeLevel } : sentence
    }),
  }))

  const satisfied = new Set([
    ...satisfiedFrom(context, violations, "DO_NOT_PRESENT_AS_FACT"),
    ...satisfiedFrom(context, violations, "KEEP_TRACEABLE_TO_CLAIMS"),
    ...satisfiedFrom(context, violations, "NO_DEFINITIVE_CONCLUSION"),
  ])
  const dependencies: ProductionDependency[] = [
    { artifact: "reasoningContext", contentSignature: artifactContentSignature(context) },
  ]
  const provenance = provenanceBase(context, violations, normalizations, satisfied, dependencies)

  return {
    artifact: { ...narrative, sections, production: provenance },
    provenance,
  }
}

// ---------------------------------------------------------------------------
// Visual guard (§9.2)
// ---------------------------------------------------------------------------

export function guardVisual(
  visual: VisualOutput,
  narrative: Narrative,
  context: ReasoningContext,
): GuardResult<VisualOutput> {
  const violations: ProductionViolation[] = []
  const normalizations: ProductionNormalization[] = []

  const sentenceById = new Map(
    narrative.sections.flatMap((section) => section.sentences).map((s) => [s.id, s]),
  )
  // A `Shot.source` may reference a research source or a specific piece of
  // evidence; both are legitimate provenance handles in this model.
  const knownSourceIds = new Set([...context.traceRefs.sourceIds, ...context.traceRefs.evidenceIds])
  const claimsById = new Map(context.claims.map((claim) => [claim.claimId, claim]))

  const shots: Shot[] = visual.shots.map((shot) => {
    // Epistemic posture = the weakest sentence this shot narrates.
    const postures = shot.narrativeSentenceIds
      .map((id) => sentenceById.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => s.knowledge)
    const posture: KnowledgeLevel = postures.length ? weakestPosture(postures) : "FICTION"

    let visualType = shot.visualType
    if (!isVisualTypePermitted(posture, visualType)) {
      normalizations.push({
        rule: "VISUAL_TYPE_DOWNGRADE",
        subjectId: shot.id,
        from: visualType,
        to: visualTypeFallback(posture),
        reason: `${visualType} presents ${posture} as documented footage`,
      })
      violations.push({
        kind: "DO_NOT_PRESENT_AS_FACT",
        constraintId: findConstraint(context.constraints, "DO_NOT_PRESENT_AS_FACT")?.id ?? null,
        severity: "warning",
        subjectIds: [shot.id],
        detail: `Shot ${shot.id} used ${visualType} for ${posture} material; downgraded to ${visualTypeFallback(posture)}.`,
        resolved: true,
        postcondition: `shot ${shot.id} uses a visual type permitted for ${posture}`,
      })
      visualType = visualTypeFallback(posture)
    }

    // Provenance: a `source` reference must exist in the evidence chain.
    let source = shot.source
    if (source !== undefined && !knownSourceIds.has(source)) {
      violations.push({
        kind: "KEEP_TRACEABLE_TO_CLAIMS",
        constraintId: findConstraint(context.constraints, "KEEP_TRACEABLE_TO_CLAIMS")?.id ?? null,
        severity: "warning",
        subjectIds: [shot.id],
        detail: `Shot ${shot.id} references unknown provenance ${source}; the reference was detached.`,
        resolved: true,
        postcondition: `shot ${shot.id} carries no unresolvable source reference`,
      })
      normalizations.push({
        rule: "SOURCE_DETACHED",
        subjectId: shot.id,
        from: source,
        to: "(detached)",
        reason: "no matching source or evidence id in the reasoning context",
      })
      source = undefined
    }

    // A FACT shot may not carry more assertiveness than its claims allow.
    if (posture === "FACT") {
      const narrative_claimIds = shot.narrativeSentenceIds.flatMap(
        (id) => sentenceById.get(id)?.claimIds ?? [],
      )
      for (const claimId of new Set(narrative_claimIds)) {
        const claim = claimsById.get(claimId)
        if (claim && !claim.usable) {
          violations.push({
            kind: "DO_NOT_PRESENT_AS_FACT",
            constraintId: findConstraint(context.constraints, "DO_NOT_PRESENT_AS_FACT")?.id ?? null,
            severity: "warning",
            subjectIds: [shot.id, claimId],
            detail: `Shot ${shot.id} documents claim ${claimId} (${claim.knowledge}/${claim.status}) as fact.`,
            // The shot's posture is the weakest narrated sentence, and the
            // narrative guard has already downgraded that sentence. Re-verified
            // independently by the audit.
            resolved: true,
            postcondition: `no sentence narrated by shot ${shot.id} presents ${claimId} as FACT`,
          })
        }
      }
    }

    return source === undefined && shot.source !== undefined
      ? { ...shot, visualType, source: undefined }
      : { ...shot, visualType, source }
  })

  const satisfied = new Set([
    ...satisfiedFrom(context, violations, "DO_NOT_PRESENT_AS_FACT"),
    ...satisfiedFrom(context, violations, "KEEP_TRACEABLE_TO_CLAIMS"),
  ])
  const dependencies: ProductionDependency[] = [
    { artifact: "reasoningContext", contentSignature: artifactContentSignature(context) },
    { artifact: "narrative", contentSignature: artifactContentSignature(narrative) },
  ]
  const provenance = provenanceBase(context, violations, normalizations, satisfied, dependencies)

  return {
    artifact: { ...visual, shots, production: provenance },
    provenance,
  }
}
