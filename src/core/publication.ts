import { z } from "zod"
import { contentSignature } from "./production/approval.js"
import type { ProductionSnapshot } from "./production/revisions.js"
import type { ResearchBundle } from "./schemas.js"

const linked = (length: number) =>
  z
    .object({
      text: z.string().max(length),
      sentenceIds: z.array(z.string().min(1).max(128)).max(20),
    })
    .strict()
export const PublicationDocumentSchema = z
  .object({
    audienceQuestion: z.string().max(500),
    titles: z.array(linked(200)).min(1).max(5),
    summary: linked(2000),
    description: linked(6000),
    thumbnailBrief: linked(2000),
    chapters: z.array(linked(200)).min(1).max(12),
  })
  .strict()
export type PublicationDocument = z.infer<typeof PublicationDocumentSchema>
export type PublicationSource = {
  id: string
  label: string
  proofSignature: string
  dependencySignature: string
  snapshot: { [Key in keyof ProductionSnapshot]: NonNullable<ProductionSnapshot[Key]> }
  research: ResearchBundle
}
export type PublicationFinding = {
  code: string
  status: "PASS" | "WARN" | "FAIL" | "UNKNOWN"
  detail: string
}
export function publicationContentSignature(
  source: PublicationSource,
  document: PublicationDocument,
) {
  return contentSignature({ source, document })
}
export function publicationFields(document: PublicationDocument) {
  return [
    ...document.titles.map((value, index) => ({ label: `Title ${index + 1}`, value })),
    { label: "Summary", value: document.summary },
    { label: "Description", value: document.description },
    { label: "Thumbnail brief", value: document.thumbnailBrief },
    ...document.chapters.map((value, index) => ({ label: `Planned segment ${index + 1}`, value })),
  ]
}
/** Mechanical reference audit only: prose support remains UNKNOWN. */
export function inspectPublication(source: PublicationSource, document: PublicationDocument) {
  const findings: PublicationFinding[] = [
    {
      code: "SEMANTIC_SUPPORT",
      status: "UNKNOWN",
      detail:
        "Links locate source material; they do not prove that titles, descriptions or thumbnail promises are supported. Human editorial review is required.",
    },
  ]
  const sentences =
    source.snapshot.narrative?.sections.flatMap((section) => section.sentences) ?? []
  if (
    !document.audienceQuestion.trim() ||
    document.titles.length < 2 ||
    publicationFields(document).some((field) => !field.value.text.trim())
  )
    findings.push({
      code: "REQUIRED_CONTENT",
      status: "FAIL",
      detail:
        "Enter an audience question, at least two titles and all summary, description, thumbnail and planned-segment text.",
    })
  for (const { label, value } of publicationFields(document)) {
    if (!value.sentenceIds.length || new Set(value.sentenceIds).size !== value.sentenceIds.length)
      findings.push({
        code: "MATERIAL_LINK",
        status: "FAIL",
        detail: label + ": link at least one unique saved script sentence.",
      })
    for (const id of value.sentenceIds) {
      const matches = sentences.filter((sentence) => sentence.id === id)
      if (matches.length !== 1) {
        findings.push({
          code: "MATERIAL_LINK",
          status: "FAIL",
          detail: label + ": missing or ambiguous sentence " + id,
        })
        continue
      }
      for (const claimId of matches[0]!.claimIds) {
        const claims = source.research.claims.filter((claim) => claim.id === claimId)
        if (claims.length !== 1 || !claims[0]!.evidenceIds?.length) {
          findings.push({
            code: "EVIDENCE_CHAIN",
            status: "FAIL",
            detail: label + ": incomplete claim chain " + claimId,
          })
          continue
        }
        for (const evidenceId of claims[0]!.evidenceIds) {
          const evidence = source.research.evidence.filter((item) => item.id === evidenceId)
          if (
            evidence.length !== 1 ||
            !evidence[0]!.supportsClaims.includes(claimId) ||
            source.research.sources.filter((item) => item.id === evidence[0]!.sourceId).length !== 1
          )
            findings.push({
              code: "EVIDENCE_CHAIN",
              status: "FAIL",
              detail: label + ": broken evidence/source support " + evidenceId,
            })
        }
      }
      if (!matches[0]!.claimIds.length)
        findings.push({
          code: "NO_CLAIM_SUPPORT",
          status: "WARN",
          detail:
            label +
            ": " +
            id +
            " has no claim support; keep its saved knowledge label and uncertainty.",
        })
    }
  }
  if (
    [...document.titles, document.thumbnailBrief].some((field) =>
      /\b(proven|guaranteed?|definitive|certain|cure|always|never)\b|доказан|гарантир|безуслов/iu.test(
        field.text,
      ),
    )
  )
    findings.push({
      code: "PROMISE_LANGUAGE",
      status: "WARN",
      detail:
        "Potential definitive promise detected in a title or thumbnail brief. This lexical flag is not a semantic verdict.",
    })
  if (!findings.some((item) => item.status === "FAIL"))
    findings.push({
      code: "REFERENCE_STRUCTURE",
      status: "PASS",
      detail:
        "Selected sentence and evidence/source references resolve. Semantic support remains UNKNOWN.",
    })
  return findings
}
export function publicationTraces(source: PublicationSource, document: PublicationDocument) {
  return publicationFields(document).map(({ label, value }) => ({
    label,
    sentenceIds: value.sentenceIds,
    sentences: value.sentenceIds.map((id) => {
      const sentence = source.snapshot.narrative?.sections
        .flatMap((section) => section.sentences)
        .find((item) => item.id === id)
      return {
        id,
        text: sentence?.text ?? null,
        knowledge: sentence?.knowledge ?? "UNKNOWN",
        shotIds:
          source.snapshot.visual?.shots
            .filter((shot) => shot.narrativeSentenceIds.includes(id))
            .map((shot) => shot.id) ?? [],
        hypothesisIds: sentence?.hypothesisIds ?? [],
        uncertaintyIds: sentence?.uncertaintyIds ?? [],
        contradictionIds: sentence?.contradictionIds ?? [],
        constraintTreatments: sentence?.constraintTreatments ?? [],
        claims: (sentence?.claimIds ?? []).map((claimId) => {
          const claim = source.research.claims.find((item) => item.id === claimId)
          return {
            id: claimId,
            knowledge: claim?.knowledge ?? "UNKNOWN",
            evidence: (claim?.evidenceIds ?? []).map((evidenceId) => {
              const evidence = source.research.evidence.find((item) => item.id === evidenceId)
              return {
                id: evidenceId,
                statement: evidence?.statement ?? null,
                sourceId: evidence?.sourceId ?? null,
                source:
                  source.research.sources.find((item) => item.id === evidence?.sourceId) ?? null,
                supported: evidence?.supportsClaims.includes(claimId) ?? false,
              }
            }),
          }
        }),
      }
    }),
  }))
}
