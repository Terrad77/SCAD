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
export type { HypothesisVerificationInput } from "./agents/hypothesis/verify.js"
export { TraceService } from "./core/trace.js"
export { SourceRegistry } from "./core/sources/source-registry.js"
export {
  computeEvidenceConfidence,
  computeClaimConfidence,
  computeAgreement,
  clamp,
} from "./core/evidence/confidence.js"
export { normalizeUrl, canonicalUrl, requestCacheKey } from "./providers/search/normalize.js"
export { MockSearchProvider } from "./providers/search/mock-search-provider.js"
export type { SearchProvider, SearchResult } from "./providers/search/search-provider.js"
export {
  CachedSearchProvider,
  MemorySearchCache,
} from "./providers/search/cached-search-provider.js"
export { createSearchProvider } from "./providers/search/factory.js"
export * from "./providers/llm/llm.js"
export { OpenCodeProvider } from "./providers/llm/opencode.js"
export { OllamaProvider } from "./providers/llm/ollama.js"
export { MockLLMProvider, bySubstring, byKeyword } from "./providers/llm/mock.js"
export * as schemas from "./core/schemas.js"
export * from "./core/types.js"
