import type {
  ClaimStatus,
  CompletenessStatus,
  HypothesisStatus,
  HypothesisVerificationStatus,
  KnowledgeLevel,
  UncertaintyKind,
} from "../types.js"
import type {
  ReasonCycleTrigger,
  ReasoningActionKind,
  ReasoningBudget,
  ReasoningStatus,
  StoppingKind,
} from "../reasoning/types.js"

/**
 * v0.7 — Reasoning → Production types.
 *
 * `ReasoningContext` is the ONE-WAY HANDOFF between the cognitive side
 * (research → evidence → claims → hypotheses → intelligence → reasoning) and the
 * production side (narrative → visual → selfCheck).
 *
 * It is deliberately NOT a second epistemic state:
 *   • it carries no evidence bodies, no source documents, no full claim text —
 *     only stable ids plus the classification production needs to obey;
 *   • every field is a pure derivation of already-persisted epistemic and
 *     reasoning artifacts, so it can always be recomputed byte-identically;
 *   • production may read it but may never write it back into the epistemic
 *     side (see `write-scope.ts`).
 *
 * Every production artifact records `inputSignature` + `reasoningCycleId`, so a
 * materially changed epistemic/reasoning state makes the artifact STALE instead
 * of silently valid (`staleness.ts`).
 */

export const REASONING_CONTEXT_VERSION = 1
export const PRODUCTION_PROVENANCE_VERSION = 1
export const PRODUCTION_MANIFEST_VERSION = 1

/**
 * The deterministic production-constraint taxonomy (§8). Each constraint is an
 * explicit, serializable object — the prompt is never the only carrier of an
 * epistemic rule.
 */
export const PRODUCTION_CONSTRAINT_KINDS = [
  "DO_NOT_PRESENT_AS_FACT",
  "QUALIFY_AS_HYPOTHESIS",
  "DO_NOT_RESOLVE_CONTRADICTION",
  "ACKNOWLEDGE_UNCERTAINTY",
  "DO_NOT_USE_UNSUPPORTED_CAUSAL_LANGUAGE",
  "NO_DEFINITIVE_CONCLUSION",
  "PRESERVE_RESEARCH_GAPS",
  "KEEP_TRACEABLE_TO_CLAIMS",
  "REQUIRE_HUMAN_APPROVAL",
] as const
export type ProductionConstraintKind = (typeof PRODUCTION_CONSTRAINT_KINDS)[number]

export const CONSTRAINT_SEVERITIES = ["critical", "warning", "info"] as const
export type ConstraintSeverity = (typeof CONSTRAINT_SEVERITIES)[number]

/** Where the rule comes from — epistemic state, reasoning result or governance. */
export type ProductionConstraintSource = "epistemic" | "reasoning" | "governance"

export interface ProductionConstraint {
  /** Stable, deterministic: `${kind}#${subjectId ?? "global"}`. */
  id: string
  kind: ProductionConstraintKind
  severity: ConstraintSeverity
  rule: string
  subjectIds: string[]
  source: ProductionConstraintSource
}

/** The reasoning result handed to production (cycle, decision, terminal verdict). */
export interface ReasoningDecision {
  cycleId: string | null
  sessionId: string | null
  stepId: string | null
  trigger: ReasonCycleTrigger | null
  actionKind: ReasoningActionKind | "NONE"
  actionTarget: string | null
  status: ReasoningStatus | "NONE"
  stoppingKind: StoppingKind | null
  stoppingReason: string | null
  humanInTheLoop: boolean
  /** The cycle reached a sealed terminal row in the immutable ledger. */
  cycleCompleted: boolean
}

/**
 * Per-claim classification for production. No statement text and no evidence:
 * narrative already receives the claims themselves (§13 — reference, do not
 * copy).
 */
export interface ContextClaimView {
  claimId: string
  knowledge: KnowledgeLevel
  status: ClaimStatus
  confidence: number
  /** May be narrated as established fact. */
  usable: boolean
  /** Must be hedged (contested / low confidence / gap- or uncertainty-laden). */
  requiresQualification: boolean
  contradictionIds: string[]
  gapIds: string[]
  uncertaintyIds: string[]
}

export interface ContextHypothesisView {
  hypothesisId: string
  versionId: string
  /**
   * The hypothesis assertion itself — the thing production must not present as
   * fact. v0.7: deliberately NOT concatenated with the verification rationale;
   * the two are separate fields so assertion matching stays exact.
   */
  statement: string
  /** Why the verifier reached `verificationStatus`. Never part of the assertion. */
  verificationRationale: string | null
  status: HypothesisStatus
  confidence: number
  verificationStatus: HypothesisVerificationStatus | "UNVERIFIED"
  supportingClaimIds: string[]
  contradictingClaimIds: string[]
  researchGapIds: string[]
  /** The hypothesis was itself generated as a competing explanation. */
  isAlternative: boolean
}

export interface ContextUncertaintyView {
  uncertaintyId: string
  kind: UncertaintyKind
  subjectType: "claim" | "hypothesis" | "evidence" | "research"
  subjectId: string
  detail: string
}

export interface EpistemicSummary {
  claimCount: number
  usableClaimCount: number
  qualifiedClaimCount: number
  unsupportedClaimCount: number
  hypothesisCount: number
  activeHypothesisCount: number
  contradictionCount: number
  openGapCount: number
  uncertaintyCount: number
  meanClaimConfidence: number
  completenessStatus: CompletenessStatus | "UNKNOWN"
  continueResearch: boolean
}

/**
 * v0.7 (M2) — the minimal claim → evidence → source edges production needs to
 * prove a FACT sentence is not merely well-referenced but genuinely backed.
 *
 * Without these, a sentence citing a claim id resolved fine even when the
 * research bundle behind that claim had no evidence at all. The edge is what
 * makes "traceable" a claim about the *chain* rather than about the reference.
 */
export interface ContextClaimTraceEdge {
  claimId: string
  evidenceIds: string[]
  sourceIds: string[]
  /** False when the claim resolves but nothing backs it. */
  supported: boolean
}

/** Back-references into the epistemic/reasoning graph (§13). Ids only. */
export interface ReasoningContextTraceRefs {
  reasoningCycleId: string | null
  reasoningSessionId: string | null
  reasoningStepId: string | null
  epistemicSignature: string
  stateSignature: string
  intelligenceInputSignature: string | null
  /**
   * v0.7 (H1) — how the intelligence projection was obtained. `recomputed`
   * means the persisted artifact did NOT verify and a read-only projection was
   * used instead, so the reason the film may look complete is auditable.
   */
  intelligenceFreshness: "fresh" | "recomputed" | "absent"
  /** v0.7 (H1) — the budget the intelligence signature was validated against. */
  intelligenceBudget: ReasoningBudget | null
  claimIds: string[]
  /** v0.7 (M2) — per-claim evidence and source edges. */
  claimTraceEdges: ContextClaimTraceEdge[]
  hypothesisVersionIds: string[]
  contradictionIds: string[]
  gapIds: string[]
  uncertaintyIds: string[]
  evidenceIds: string[]
  /**
   * Research source ids (`SRC_*`). A `Shot.source` in the production model is a
   * *source* reference, not an evidence reference, so the visual guard
   * validates provenance against this list as well as `evidenceIds`.
   */
  sourceIds: string[]
}

export interface ReasoningContext {
  version: typeof REASONING_CONTEXT_VERSION
  /** sha256 over (epistemic state, reasoning result, referenceDate). Drives staleness. */
  inputSignature: string
  /** sha256 over the context body itself (this field excluded). */
  contextSignature: string
  project: string
  question: string
  referenceDate: string
  reasoningCycleId: string | null
  decision: ReasoningDecision
  epistemicSummary: EpistemicSummary
  claims: ContextClaimView[]
  activeHypotheses: ContextHypothesisView[]
  uncertainties: ContextUncertaintyView[]
  constraints: ProductionConstraint[]
  traceRefs: ReasoningContextTraceRefs
}

// ---------------------------------------------------------------------------
// Production artifact provenance (§17)
// ---------------------------------------------------------------------------

export const PRODUCTION_NORMALIZATION_RULES = [
  "KNOWLEDGE_DOWNGRADE",
  "VISUAL_TYPE_DOWNGRADE",
  "SOURCE_DETACHED",
] as const
export type ProductionNormalizationRule = (typeof PRODUCTION_NORMALIZATION_RULES)[number]

/** A constraint the artifact broke; reported, never silently repaired in text. */
export interface ProductionViolation {
  kind: ProductionConstraintKind
  constraintId: string | null
  severity: ConstraintSeverity
  subjectIds: string[]
  detail: string
  /**
   * v0.7 (H6) — whether the guard was able to bring the artifact back inside the
   * constraint *without touching its text* (a deterministic label or visual-type
   * downgrade).
   *
   * This is a CLAIM BY THE GUARD, not proof. The audit re-derives the
   * postcondition from the artifact itself and never accepts this flag on
   * trust, so a persisted `resolved: true` on an artifact that still breaks the
   * constraint cannot buy a PASS.
   */
  resolved: boolean
  /** The deterministic postcondition the audit re-verifies (v0.7). */
  postcondition: string | null
}

/**
 * v0.7 (H3) — one upstream artifact an artifact was actually built from, with
 * the content signature it was built against. Recorded so staleness can be
 * detected per dependency, not merely per run: an unchanged `inputSignature`
 * alongside a changed dependency is exactly the drift signature comparison
 * alone cannot see.
 */
export interface ProductionDependency {
  artifact: string
  contentSignature: string
}

export const PRODUCTION_DEPENDENCIES = {
  narrative: ["reasoningContext"],
  visual: ["reasoningContext", "narrative"],
  selfCheck: ["reasoningContext", "narrative", "visual"],
} as const

/** A deterministic label correction applied by the guard (no text is rewritten). */
export interface ProductionNormalization {
  rule: ProductionNormalizationRule
  subjectId: string
  from: string
  to: string
  reason: string
}

/** Attached to `narrative`, `visual` and `selfCheck` (optional, v0.6 compatible). */
export interface ProductionProvenance {
  version: typeof PRODUCTION_PROVENANCE_VERSION
  contextVersion: number
  inputSignature: string
  contextSignature: string
  reasoningCycleId: string | null
  project: string
  question: string
  satisfiedConstraints: string[]
  violations: ProductionViolation[]
  normalizations: ProductionNormalization[]
  /** v0.7 (H3) — the artifacts this one was actually built from. */
  dependencies: ProductionDependency[]
}

// ---------------------------------------------------------------------------
// SelfCheck production report (§10, §11)
// ---------------------------------------------------------------------------

/** `UNKNOWN` remains a legal outcome (I11) — a check may be undecidable. */
export const PRODUCTION_CHECK_STATUSES = ["PASS", "WARN", "FAIL", "UNKNOWN"] as const
export type ProductionCheckStatus = (typeof PRODUCTION_CHECK_STATUSES)[number]

export const PRODUCTION_CHECK_IDS = [
  "EPISTEMIC_INTEGRITY",
  "TRACEABILITY",
  "UNSUPPORTED_STATEMENTS",
  "UNCERTAINTY_PRESERVATION",
  "CONTRADICTION_PRESERVATION",
  "HYPOTHESIS_INTEGRITY",
  "SCOPE_COMPLIANCE",
] as const
export type ProductionCheckId = (typeof PRODUCTION_CHECK_IDS)[number]

export const PRODUCTION_DIAGNOSTIC_KINDS = [
  "epistemic-integrity",
  "traceability",
  "unsupported-statement",
  "uncertainty-loss",
  "contradiction-suppression",
  "hypothesis-inflation",
  "hypothesis-inflation-ambiguous",
  "scope-violation",
] as const
export type ProductionDiagnosticKind = (typeof PRODUCTION_DIAGNOSTIC_KINDS)[number]

/**
 * Why a check is `UNKNOWN` — the distinction that decides whether a report may
 * be certified. This is per-check, never per-id: whether a given id is blocking
 * depends on WHY it was undecidable in that run.
 *
 *   not-applicable  the constraint is vacuous here. A context with no recorded
 *                   uncertainties has none to lose, so there is nothing to
 *                   verify and nothing is withheld.
 *   unverifiable    the constraint IS relevant, and the audit could not
 *                   establish it. This is absence of proof, and a certificate
 *                   is not issued on absence of proof.
 */
export type ProductionUnknownReason = "not-applicable" | "unverifiable"

export interface ProductionCheckResult {
  id: ProductionCheckId
  status: ProductionCheckStatus
  detail: string
  subjectIds: string[]
  /** Only meaningful when `status` is `UNKNOWN`; absent otherwise. */
  unknownReason?: ProductionUnknownReason
}

/**
 * A SelfCheck finding is a DIAGNOSTIC, routed to a human / reasoning decision
 * in a future cycle. It is never evidence, never a claim verification and never
 * a hypothesis verification (I4, I5).
 */
export interface SelfCheckDiagnostic {
  id: string
  kind: ProductionDiagnosticKind
  severity: "critical" | "warning" | "info"
  detail: string
  subjectIds: string[]
  route: "human" | "reasoning"
}

export interface SelfCheckProductionReport {
  inputSignature: string
  contextSignature: string
  reasoningCycleId: string | null
  verdict: ProductionCheckStatus
  checks: ProductionCheckResult[]
  diagnostics: SelfCheckDiagnostic[]
  /** Always the literal `false`: SelfCheck can never mutate epistemic state. */
  epistemicMutation: false
  /** v0.7 (H3) — the artifacts the audit actually read. */
  dependencies: ProductionDependency[]
}

// ---------------------------------------------------------------------------
// Staleness (§18) and the production manifest (§15)
// ---------------------------------------------------------------------------

export const ARTIFACT_STALENESS = ["CURRENT", "STALE", "MISSING", "UNKNOWN"] as const
export type ArtifactStaleness = (typeof ARTIFACT_STALENESS)[number]

/** Why an artifact is not CURRENT. Diagnostic only — never triggers a rebuild. */
export const STALENESS_REASONS = [
  "INPUT_SIGNATURE_CHANGED",
  "DEPENDENCY_CHANGED",
  "DEPENDENCY_MISSING",
  "CONTEXT_CORRUPT",
  "NO_CURRENT_SIGNATURE",
] as const
export type StalenessReason = (typeof STALENESS_REASONS)[number]

export interface ProductionArtifactStaleness {
  artifact: string
  status: ArtifactStaleness
  inputSignature: string | null
  reasoningCycleId: string | null
  /** v0.7 (H3) — the first dependency that failed, if any. */
  reason: StalenessReason | null
  /** The dependency artifact name behind `reason`, when it names one. */
  dependency: string | null
}

export interface ProductionStaleness {
  currentInputSignature: string | null
  currentContextSignature: string | null
  artifacts: ProductionArtifactStaleness[]
  stale: boolean
  /** v0.7 never regenerates on its own: detection and regeneration are separate. */
  autoRegenerate: false
}

export interface ProductionArtifactRef {
  artifact: string
  inputSignature: string | null
  contextSignature: string | null
  reasoningCycleId: string | null
  /** v0.7 (H3) — the dependencies this artifact was built from. */
  dependencies: ProductionDependency[]
}

export interface ProductionManifest {
  version: typeof PRODUCTION_MANIFEST_VERSION
  project: string
  question: string
  context: {
    version: number
    inputSignature: string
    contextSignature: string
    reasoningCycleId: string | null
    referenceDate: string
  }
  artifacts: ProductionArtifactRef[]
  constraints: ProductionConstraint[]
  selfCheck: { verdict: ProductionCheckStatus; checks: ProductionCheckResult[] } | null
  staleness: ProductionStaleness
}
