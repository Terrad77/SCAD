import type { Hypothesis, HypothesisVerification, ResearchBundle } from "../schemas.js"
import type { HypothesisVersion } from "./types.js"

/**
 * v0.5 — Hypothesis version log helpers.
 *
 * Versions are immutable: nothing ever mutates an existing entry. The active
 * `hypotheses` artifact is derived from the log (latest version per
 * hypothesis, rejecting REJECTED ones). Because rejected versions stay in the
 * log, the reasoning trace remains complete even when a hypothesis is dropped
 * from the active set.
 */

export function versionIdOf(hypothesisId: string, version: number): string {
  return `${hypothesisId}_V${version}`
}

export function latestVersion(
  versions: HypothesisVersion[],
  hypothesisId: string,
): HypothesisVersion | null {
  const candidates = versions.filter((v) => v.hypothesisId === hypothesisId)
  if (candidates.length === 0) return null
  let latest = candidates[0]!
  for (const candidate of candidates) {
    if (candidate.version > latest.version) latest = candidate
  }
  return latest
}

export function versionCount(versions: HypothesisVersion[], hypothesisId: string): number {
  return versions.filter((v) => v.hypothesisId === hypothesisId).length
}

/**
 * Active hypotheses: latest version per hypothesis, excluding REJECTED.
 * Returns the pointer objects exactly as they should be published under the
 * `hypotheses` store key (full Hypothesis shape, carrying version bookkeeping).
 */
export function activeVersions(versions: HypothesisVersion[]): HypothesisVersion[] {
  const byId = new Map<string, HypothesisVersion>()
  for (const version of versions) {
    const current = byId.get(version.hypothesisId)
    if (!current || version.version > current.version) byId.set(version.hypothesisId, version)
  }
  return [...byId.values()]
    .filter((v) => v.status !== "REJECTED")
    .sort((a, b) => a.hypothesisId.localeCompare(b.hypothesisId))
}

/** Loses the version bookkeeping, returning plain Hypothesis-shaped pointers. */
export function toActiveHypotheses(versions: HypothesisVersion[]): Hypothesis[] {
  return activeVersions(versions).map((v) => ({
    id: v.hypothesisId,
    statement: v.statement,
    basis: v.basis,
    supportingClaims: v.supportingClaims,
    contradictingClaims: v.contradictingClaims,
    supportingEvidence: v.supportingEvidence,
    contradictingEvidence: v.contradictingEvidence,
    researchGaps: v.researchGaps,
    confidence: v.confidence,
    status: v.status,
    assumptions: v.assumptions,
    missingInfo: v.missingInfo,
    verificationTasks: v.verificationTasks,
  }))
}

/**
 * Appends a new version and marks the previously-latest version superseded.
 * Returns a new log array; the input array and its entries are never mutated.
 */
export function appendVersion(
  versions: HypothesisVersion[],
  next: HypothesisVersion,
): HypothesisVersion[] {
  const prior = latestVersion(versions, next.hypothesisId)
  if (!prior) return [...versions, next]
  if (prior.version >= next.version) {
    throw new Error(
      `appendVersion: version ${next.version} would not follow ${prior.hypothesisId} v${prior.version}`,
    )
  }
  return [
    ...versions.map((v) =>
      v.versionId === prior.versionId ? { ...v, supersededByVersionId: next.versionId } : v,
    ),
    next,
  ]
}

/**
 * Imports existing (v0.4-shaped) hypotheses into the version log as their
 * first immutable entry, preserving ids, status and confidence.
 */
export function importHypotheses(hypotheses: Hypothesis[], stepId: string): HypothesisVersion[] {
  return hypotheses.map((h) => toVersion(h, 1, stepId, "imported from the hypotheses stage"))
}

function toVersion(
  h: Hypothesis,
  version: number,
  stepId: string,
  reason: string,
): HypothesisVersion {
  return {
    ...h,
    versionId: versionIdOf(h.id, version),
    hypothesisId: h.id,
    version,
    reason,
    createdAfterStep: stepId,
  }
}

/** Builds a version from a plain Hypothesis with fresh bookkeeping. */
export function buildVersion(
  hypothesis: Hypothesis,
  version: number,
  stepId: string,
  reason: string,
  extra: Partial<HypothesisVersion> = {},
): HypothesisVersion {
  return { ...toVersion(hypothesis, version, stepId, reason), ...extra }
}

/** Convenience: derive verifications and active hypotheses in one import. */
export function activeVerifications(
  versions: HypothesisVersion[],
  research: Pick<ResearchBundle, "claims" | "evidence" | "gaps" | "contradictions">,
  verify: (hypotheses: Hypothesis[], research: ResearchBundle) => HypothesisVerification[],
): HypothesisVerification[] {
  return verify(toActiveHypotheses(versions), research as ResearchBundle)
}
