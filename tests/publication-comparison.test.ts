import { describe, expect, it } from "vitest"
import { comparePublicationDocuments } from "../src/core/publication-comparison.js"
import type { PublicationDocument } from "../src/core/publication.js"
const linked = () => ({ text: "Saved text", sentenceIds: ["a", "b"] })
const document: PublicationDocument = {
  audienceQuestion: "Open question",
  titles: [linked(), linked()],
  summary: linked(),
  description: linked(),
  thumbnailBrief: linked(),
  chapters: [linked(), linked()],
}
describe("saved publication field comparison", () => {
  it("preserves whitespace, Cyrillic and signed link order without mutating inputs", () => {
    const before = structuredClone(document),
      after = structuredClone(document)
    after.audienceQuestion = "Відкрите питання\n"
    after.summary.sentenceIds.reverse()
    after.description.text += " "
    const input = JSON.stringify({ before, after })
    const result = comparePublicationDocuments(before, after)
    expect(result.find((field) => field.label === "Audience question")).toMatchObject({
      status: "CHANGED",
      textChanged: true,
      linksChanged: false,
      after: { text: "Відкрите питання\n" },
    })
    expect(result.find((field) => field.label === "Summary")).toMatchObject({
      status: "CHANGED",
      textChanged: false,
      linksChanged: true,
    })
    expect(result.find((field) => field.label === "Description")?.textChanged).toBe(true)
    expect(JSON.stringify({ before, after })).toBe(input)
  })
  it("reports additions/removals by position and exact equality without semantic matching", () => {
    const after = structuredClone(document)
    after.titles.pop()
    after.chapters.push({ text: "New segment", sentenceIds: [] })
    const result = comparePublicationDocuments(document, after)
    expect(result.find((field) => field.label === "Title 2")).toMatchObject({
      status: "REMOVED",
      after: null,
    })
    expect(result.find((field) => field.label === "Planned segment 3")).toMatchObject({
      status: "ADDED",
      before: null,
    })
    expect(
      comparePublicationDocuments(document, document).every(
        (field) => field.status === "UNCHANGED",
      ),
    ).toBe(true)
  })
})
