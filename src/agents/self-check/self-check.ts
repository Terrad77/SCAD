import type { Claim, Narrative, SelfCheckItem, SelfCheckOutput, Shot } from "../../core/schemas.js"

const SUPPORTED_VERDICTS = new Set(["SUPPORTED", "PARTIAL"])

/**
 * Deterministic self-check engine. Runs structural rules over claims, narrative
 * and shots to surface unsupported claims, contradictions, speculation presented
 * as fact, missing evidence and narrative problems.
 */
export class SelfCheckEngine {
  run(input: {
    claims: Claim[]
    narrative: Narrative
    shots: Shot[]
    assessments?: Array<{ claimId: string; verdict: string }>
  }): SelfCheckOutput {
    const critical: SelfCheckItem[] = []
    const warnings: SelfCheckItem[] = []
    const info: SelfCheckItem[] = []

    const verdictByClaim = new Map((input.assessments ?? []).map((a) => [a.claimId, a.verdict]))

    // Unsupported claims
    for (const claim of input.claims) {
      if (claim.sources.length === 0) {
        critical.push({
          severity: "critical",
          type: "unsupported-claim",
          detail: `Claim ${claim.id} has no source: ${claim.statement}`,
          claimIds: [claim.id],
        })
      } else if (claim.evidence.length === 0) {
        warnings.push({
          severity: "warning",
          type: "missing-evidence",
          detail: `Claim ${claim.id} lists sources but no evidence: ${claim.statement}`,
          claimIds: [claim.id],
        })
      }
      const verdict = verdictByClaim.get(claim.id)
      if (verdict && !SUPPORTED_VERDICTS.has(verdict)) {
        warnings.push({
          severity: "warning",
          type: "fact-check-verdict",
          detail: `Claim ${claim.id} failed fact check with verdict ${verdict}: ${claim.statement}`,
          claimIds: [claim.id],
        })
      }
      if (claim.confidence < 0.5) {
        info.push({
          severity: "info",
          type: "low-confidence",
          detail: `Claim ${claim.id} has low confidence (${claim.confidence.toFixed(2)}): ${claim.statement}`,
          claimIds: [claim.id],
        })
      }
    }

    // Contradictions: claims that assert opposite statements on the same topic.
    const contradictions = this.findContradictions(input.claims)
    for (const { a, b } of contradictions) {
      warnings.push({
        severity: "warning",
        type: "contradiction",
        detail: `Claims ${a.id} and ${b.id} may contradict each other.`,
        claimIds: [a.id, b.id],
      })
    }

    // Speculation presented as fact in narrative
    for (const section of input.narrative.sections) {
      for (const sentence of section.sentences) {
        if (sentence.knowledge === "SPECULATION") {
          const looksFinal = /(is|will be|are|always|never)\b/i.test(sentence.text)
          if (looksFinal) {
            warnings.push({
              severity: "warning",
              type: "speculation-as-fact",
              detail: `Sentence ${sentence.id} is SPECULATION but reads as definitive: ${sentence.text}`,
              claimIds: sentence.claimIds,
            })
          }
        }
        if (sentence.claimIds.length === 0) {
          info.push({
            severity: "info",
            type: "unlinked-sentence",
            detail: `Narrative sentence ${sentence.id} has no supporting claim: ${sentence.text}`,
          })
        }
      }
    }

    // Repeated headings
    const headings = input.narrative.sections.map((s) => s.heading.toLowerCase())
    const duplicates = headings.filter((h, i) => headings.indexOf(h) !== i)
    if (duplicates.length) {
      warnings.push({
        severity: "warning",
        type: "repetition",
        detail: `Repeated narrative headings: ${[...new Set(duplicates)].join(", ")}`,
      })
    }

    // Unsupported claims referenced by narrative but absent from the claim set
    const knownClaimIds = new Set(input.claims.map((c) => c.id))
    for (const section of input.narrative.sections) {
      for (const sentence of section.sentences) {
        const danglingIds = sentence.claimIds.filter((id) => !knownClaimIds.has(id))
        if (danglingIds.length) {
          critical.push({
            severity: "critical",
            type: "dangling-claim-reference",
            detail: `Sentence ${sentence.id} references unknown claim ids: ${danglingIds.join(", ")}`,
            claimIds: danglingIds,
          })
        }
      }
    }

    // Shots reference valid narrative sentences
    const sentenceIds = new Set(
      input.narrative.sections.flatMap((s) => s.sentences.map((sn) => sn.id)),
    )
    for (const shot of input.shots) {
      const dangling = shot.narrativeSentenceIds.filter((id) => !sentenceIds.has(id))
      if (dangling.length) {
        warnings.push({
          severity: "warning",
          type: "dangling-shot-reference",
          detail: `Shot ${shot.id} references unknown narrative sentence ids: ${dangling.join(", ")}`,
        })
      }
    }

    return { critical, warnings, info }
  }

  private findContradictions(claims: Claim[]): Array<{ a: Claim; b: Claim }> {
    const negation = /(^|\s)(not|never|no more|instead of)(\s|$)/i
    const results: Array<{ a: Claim; b: Claim }> = []
    for (let i = 0; i < claims.length; i += 1) {
      for (let j = i + 1; j < claims.length; j += 1) {
        const a = claims[i]!
        const b = claims[j]!
        const aNeg = negation.test(a.statement)
        const bNeg = negation.test(b.statement)
        if ((aNeg && !bNeg) || (!aNeg && bNeg)) {
          const topicA = a.statement.replace(negation, " ").split(" ").slice(0, 6).join(" ")
          const topicB = b.statement.replace(negation, " ").split(" ").slice(0, 6).join(" ")
          if (topicA === topicB) results.push({ a, b })
        }
      }
    }
    return results
  }
}

/** Summarizes the self-check report into the CLI-facing text. */
export function summarizeSelfCheck(output: SelfCheckOutput): {
  critical: number
  warnings: number
  info: number
} {
  return {
    critical: output.critical.length,
    warnings: output.warnings.length,
    info: output.info.length,
  }
}
