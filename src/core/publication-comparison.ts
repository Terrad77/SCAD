import type { PublicationDocument } from "./publication.js"

type Linked = PublicationDocument["summary"]
export type PublicationFieldChange = {
  label: string
  before: Linked | null
  after: Linked | null
  status: "UNCHANGED" | "ADDED" | "REMOVED" | "CHANGED"
  textChanged: boolean
  linksChanged: boolean
}

/** Positional comparison of signed fields, not a semantic or factual verdict. */
export function comparePublicationDocuments(
  before: PublicationDocument,
  after: PublicationDocument,
): PublicationFieldChange[] {
  const fields: Array<{ label: string; before: Linked | null; after: Linked | null }> = [
    {
      label: "Audience question",
      before: { text: before.audienceQuestion, sentenceIds: [] },
      after: { text: after.audienceQuestion, sentenceIds: [] },
    },
    ...Array.from({ length: Math.max(before.titles.length, after.titles.length) }, (_, index) => ({
      label: `Title ${index + 1}`,
      before: before.titles[index] ?? null,
      after: after.titles[index] ?? null,
    })),
    { label: "Summary", before: before.summary, after: after.summary },
    { label: "Description", before: before.description, after: after.description },
    { label: "Thumbnail brief", before: before.thumbnailBrief, after: after.thumbnailBrief },
    ...Array.from(
      { length: Math.max(before.chapters.length, after.chapters.length) },
      (_, index) => ({
        label: `Planned segment ${index + 1}`,
        before: before.chapters[index] ?? null,
        after: after.chapters[index] ?? null,
      }),
    ),
  ]
  return fields.map((field) => {
    const textChanged = field.before?.text !== field.after?.text
    const linksChanged =
      JSON.stringify(field.before?.sentenceIds ?? []) !==
      JSON.stringify(field.after?.sentenceIds ?? [])
    return {
      ...field,
      textChanged,
      linksChanged,
      status: !field.before
        ? "ADDED"
        : !field.after
          ? "REMOVED"
          : textChanged || linksChanged
            ? "CHANGED"
            : "UNCHANGED",
    }
  })
}
