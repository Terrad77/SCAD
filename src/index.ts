export { runDocumentaryPipeline, renderScript } from "./core/documentary.js"
export type { DocumentaryOptions, DocumentaryResult } from "./core/documentary.js"
export { Pipeline, AutoApprover, StageRejectedError, PIPELINE_ORDER } from "./core/pipeline.js"
export type { ApprovalGate, PipelineArtifacts, ApprovalDecision } from "./core/pipeline.js"
export { StructuredAgent, StructuredError, readPromptFile } from "./core/structured-agent.js"
export { buildTraceabilityReport } from "./core/traceability.js"
export type { TraceabilityReport, TraceEntry } from "./core/traceability.js"
export { JsonMemoryStore } from "./core/memory/json-memory.js"
export { FactCheckEngine } from "./agents/fact-check/fact-check.js"
export { SelfCheckEngine, summarizeSelfCheck } from "./agents/self-check/self-check.js"
export { ResearchEngine } from "./agents/research/research-engine.js"
export type { ResearchEngineOptions } from "./agents/research/research-engine.js"
export { ResearchPlanner } from "./agents/research/research-planner.js"
export { SourceAnalyzer } from "./agents/research/source-analyzer.js"
export { EvidenceExtractor } from "./agents/research/evidence-extractor.js"
export { ClaimExtractor, deriveClaimsFromEvidence } from "./agents/research/claim-extractor.js"
export { detectContradictions } from "./agents/research/contradiction-detector.js"
export { detectResearchGaps } from "./agents/research/gap-detector.js"
export { renderResearchReport } from "./agents/research/research-report.js"
export { makeId } from "./agents/research/ids.js"
export { verifyHypotheses } from "./agents/hypothesis/verify.js"
export type {
  HypothesisVerificationInput,
  VerificationEnrichmentInput,
} from "./agents/hypothesis/verify.js"
export {
  ResearchIntelligenceEngine,
  researchIntelligence,
} from "./agents/research/research-intelligence.js"
export type { ResearchIntelligenceOptions } from "./agents/research/research-intelligence.js"
export { TraceService } from "./core/trace.js"
export { SourceRegistry } from "./core/sources/source-registry.js"
export {
  computeEvidenceConfidence,
  computeClaimConfidence,
  computeAgreement,
  clamp,
} from "./core/evidence/confidence.js"
export { computeEvidenceQuality } from "./core/evidence/evidence-quality.js"
export {
  pairRelationship,
  analyzeSourceIndependence,
  independentSourcesFor,
  mergeRelationships,
  buildSourceRelationships,
  profileFromRelationships,
} from "./core/evidence/source-independence.js"
export { assessClaim, assessClaims } from "./core/evidence/claim-assessment.js"
export {
  analyzeContradiction,
  analyzeContradictions,
} from "./core/evidence/contradiction-analysis.js"
export {
  computeResearchCompleteness,
  evaluateStoppingCriteria,
} from "./core/evidence/completeness.js"
export {
  collectUncertainties,
  classifyClaimUncertainty,
  hypothesisUncertainty,
} from "./core/evidence/uncertainty.js"
export { normalizeUrl, canonicalUrl, requestCacheKey } from "./providers/search/normalize.js"
export { MockSearchProvider } from "./providers/search/mock-search-provider.js"
export type { SearchProvider, SearchResult } from "./providers/search/search-provider.js"
export {
  CachedSearchProvider,
  MemorySearchCache,
  FileSearchCache,
} from "./providers/search/cached-search-provider.js"
export {
  BraveSearchProvider,
  parseBraveResponse,
} from "./providers/search/brave-search-provider.js"
export { createSearchProvider } from "./providers/search/factory.js"
export type { SearchFactoryConfig } from "./providers/search/factory.js"
export { fetchWithRetry, HttpRequestError } from "./providers/http.js"
export type { RetryOptions, HttpResult } from "./providers/http.js"
export { FileCache } from "./providers/cache/file-cache.js"
export type { CacheStore } from "./providers/cache/file-cache.js"
export { NoopContentProvider, isContentResult } from "./providers/content/content-provider.js"
export type {
  ContentProvider,
  ContentRequest,
  ContentResult,
} from "./providers/content/content-provider.js"
export { HttpContentProvider } from "./providers/content/http-content-provider.js"
export { MockContentProvider } from "./providers/content/mock-content-provider.js"
export { CachedContentProvider } from "./providers/content/cached-content-provider.js"
export { createContentProvider } from "./providers/content/factory.js"
export { extractPlainText, decodeHtmlEntities } from "./providers/content/html-text.js"
export { OpenAIProvider } from "./providers/llm/openai.js"
export { AnthropicProvider } from "./providers/llm/anthropic.js"
export * from "./providers/llm/llm.js"
export { OpenCodeProvider } from "./providers/llm/opencode.js"
export { OllamaProvider } from "./providers/llm/ollama.js"
export { MockLLMProvider, bySubstring, byKeyword } from "./providers/llm/mock.js"
export * as schemas from "./core/schemas.js"
export * from "./core/types.js"

// v0.5 — Reasoning & Hypothesis Evolution
export { ReasoningEngine } from "./agents/reasoning/reasoning-engine.js"
export type { ReasoningEngineOptions, ExecuteResult } from "./agents/reasoning/reasoning-engine.js"
export { planReasoning, repeatKeyOf } from "./agents/reasoning/action-selection.js"
export { assessSituation } from "./agents/reasoning/situation-assessment.js"
export type { SituationInput } from "./agents/reasoning/situation-assessment.js"
export {
  generateAlternative,
  buildRevision,
  buildRejection,
  alternativeReasonFor,
} from "./agents/reasoning/hypothesis-lifecycle.js"
export type { HypothesisLifecycleContext } from "./agents/reasoning/hypothesis-lifecycle.js"
export { runFollowUpResearch } from "./agents/reasoning/follow-up.js"
export type { FollowUpOptions, FollowUpResult } from "./agents/reasoning/follow-up.js"
export { buildReasoningTrace, renderReasoningTrace } from "./agents/reasoning/reasoning-trace.js"
export type { ReasoningTrace, ReasoningStepTrace } from "./agents/reasoning/reasoning-trace.js"
export { computeStateSignature } from "./core/reasoning/state-signature.js"
export type { SignatureInput } from "./core/reasoning/state-signature.js"
export {
  verifySingleHypothesis,
  verifyPureHypotheses,
} from "./core/reasoning/hypothesis-verification.js"
export {
  appendVersion,
  importHypotheses,
  toActiveHypotheses,
  latestVersion,
  activeVersions,
  versionIdOf,
  versionCount,
  buildVersion,
} from "./core/reasoning/hypothesis-version.js"
export {
  ScopedMemory,
  ACTION_WRITE_SCOPE,
  WriteScopeViolationError,
  EPISTEMIC_WRITE_KEYS,
  CONTROL_WRITE_KEYS,
  readScopeFor,
} from "./core/memory/scoped-memory.js"
export { describeStopping, STOPPING_KIND_LABELS } from "./core/reasoning/stopping.js"
export * from "./core/reasoning/types.js"
export * from "./core/reasoning/schemas.js"

// v0.7 — Reasoning-to-Production Pipeline Integration
export { buildReasoningContext } from "./agents/production/reasoning-context.js"
export type { BuildReasoningContextInput } from "./agents/production/reasoning-context.js"
export {
  ProductionEngine,
  PRODUCTION_ARTIFACTS,
  artifactRefs,
} from "./agents/production/production-engine.js"
export type { ProductionInputs } from "./agents/production/production-engine.js"
export { guardNarrative, guardVisual } from "./core/production/guards.js"
export type { GuardResult } from "./core/production/guards.js"
export { auditProduction } from "./core/production/self-check-rules.js"
export type { ProductionAuditInput } from "./core/production/self-check-rules.js"
export {
  deriveProductionConstraints,
  findConstraint,
  constraintIdOf,
  claimIsUsableForFact,
  sortConstraints,
  CRITICAL_GAP_IMPORTANCE,
  QUALIFIED_CLAIM_CONFIDENCE,
} from "./core/production/constraints.js"
export type { ConstraintInput } from "./core/production/constraints.js"
export {
  ASSERTIVENESS_RANK,
  KNOWLEDGE_BY_RANK,
  rankOfKnowledge,
  knowledgeAtLeastAsAssertive,
  knowledgeCeilingFor,
  enforceKnowledgeCeiling,
  PERMITTED_VISUAL_TYPES,
  isVisualTypePermitted,
  visualTypeFallback,
  weakestPosture,
  strongestPosture,
} from "./core/production/integrity.js"
export type { KnowledgeCeiling } from "./core/production/integrity.js"
export {
  detectProductionStaleness,
  artifactStaleness,
  stalenessOf,
} from "./core/production/staleness.js"
export type { StalenessInput, StalenessMarker } from "./core/production/staleness.js"
export {
  reasoningContextInputSignature,
  computeReasoningContextSignature,
  sha256,
} from "./core/production/signature.js"
export {
  STAGE_WRITE_SCOPE,
  PRODUCTION_WRITE_KEYS,
  EPISTEMIC_PIPELINE_KEYS,
  REASONING_ARTIFACT_KEYS,
  GOVERNANCE_WRITE_KEYS,
  writeScopeForStage,
  protectedKeys,
} from "./core/production/write-scope.js"
export {
  REASONING_CONTEXT_VERSION,
  PRODUCTION_PROVENANCE_VERSION,
  PRODUCTION_MANIFEST_VERSION,
  PRODUCTION_CONSTRAINT_KINDS,
  PRODUCTION_CHECK_IDS,
  PRODUCTION_CHECK_STATUSES,
  PRODUCTION_DIAGNOSTIC_KINDS,
  PRODUCTION_NORMALIZATION_RULES,
  CONSTRAINT_SEVERITIES,
} from "./core/production/types.js"
export * from "./core/production/schemas.js"

export {
  ProductionRevisionEngine,
  REVISION_STAGES,
  REVISION_KEY,
  revisionDiff,
} from "./core/production/revisions.js"
export type {
  ProductionRevision,
  RevisionPlan,
  RevisionGenerator,
  RevisionStage,
  ProductionSnapshot,
  RevisionDifference,
} from "./core/production/revisions.js"
export { createRevisionGenerator } from "./agents/production/revision-generator.js"
