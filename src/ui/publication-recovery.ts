import type { PublicationDocument } from "../core/publication.js"
import type { PublicationState } from "../application/publication-packages.js"

export type Recovery = {
  projectVersion: string
  journalVersion: string
  packageId: string
  revision: number | null
  sourceId: string
  proofSignature: string
  dependencySignature: string
  document: PublicationDocument
  reason: string
}

const key = (projectId: string) => `scad.publication.recovery.v1:${projectId}`
const limit = 128 * 1024

function validDocument(value: unknown): value is PublicationDocument {
  if (!value || typeof value !== "object") return false
  const doc = value as PublicationDocument
  const linked = (item: unknown, max: number) => {
    if (!item || typeof item !== "object") return false
    const field = item as PublicationDocument["summary"]
    return (
      typeof field.text === "string" &&
      field.text.length <= max &&
      Array.isArray(field.sentenceIds) &&
      field.sentenceIds.length <= 20 &&
      field.sentenceIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)
    )
  }
  return (
    typeof doc.audienceQuestion === "string" &&
    doc.audienceQuestion.length <= 500 &&
    Array.isArray(doc.titles) &&
    doc.titles.length >= 1 &&
    doc.titles.length <= 5 &&
    doc.titles.every((item) => linked(item, 200)) &&
    linked(doc.summary, 2000) &&
    linked(doc.description, 6000) &&
    linked(doc.thumbnailBrief, 2000) &&
    Array.isArray(doc.chapters) &&
    doc.chapters.length >= 1 &&
    doc.chapters.length <= 12 &&
    doc.chapters.every((item) => linked(item, 200))
  )
}

export function readRecovery(storage: Storage, projectId: string): Recovery | null {
  const raw = storage.getItem(key(projectId))
  if (!raw) return null
  if (raw.length > limit) throw new Error("Recovery copy is too large. Delete it to continue.")
  let item: Recovery
  try {
    item = JSON.parse(raw) as Recovery
  } catch {
    throw new Error("Recovery copy is unreadable. Delete it to continue.")
  }
  if (
    !item ||
    typeof item !== "object" ||
    ![
      item.projectVersion,
      item.journalVersion,
      item.packageId,
      item.sourceId,
      item.proofSignature,
      item.dependencySignature,
      item.reason,
    ].every((v) => typeof v === "string" && v.length <= 2048) ||
    !(item.revision === null || (Number.isSafeInteger(item.revision) && item.revision! > 0)) ||
    !validDocument(item.document)
  )
    throw new Error("Recovery copy is invalid. Delete it to continue.")
  return item
}

export function writeRecovery(storage: Storage, projectId: string, recovery: Recovery) {
  const raw = JSON.stringify(recovery)
  if (raw.length > limit) throw new Error("Recovery copy exceeds the local size limit.")
  storage.setItem(key(projectId), raw)
}

export function deleteRecovery(storage: Storage, projectId: string) {
  storage.removeItem(key(projectId))
}

export function recoveryMatches(recovery: Recovery, state: PublicationState): boolean {
  const item = recovery.packageId
    ? state.packages.find((entry) => entry.packageId === recovery.packageId)
    : undefined
  const source = item?.source ?? state.sources.find((entry) => entry.id === recovery.sourceId)
  return (
    state.projectVersion === recovery.projectVersion &&
    state.journalVersion === recovery.journalVersion &&
    (recovery.packageId
      ? !!item && item.revision === recovery.revision
      : recovery.revision === null) &&
    !!source &&
    source.id === recovery.sourceId &&
    source.proofSignature === recovery.proofSignature &&
    source.dependencySignature === recovery.dependencySignature
  )
}
