import { describe, expect, it } from "vitest"
import {
  deleteRecovery,
  readRecovery,
  writeRecovery,
  type Recovery,
} from "../src/ui/publication-recovery.js"

function storage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}
const linked = { text: "Draft", sentenceIds: ["sentence-1"] }
const draft: Recovery = {
  projectVersion: "p1",
  journalVersion: "j1",
  packageId: "pkg",
  revision: 2,
  sourceId: "source",
  proofSignature: "proof",
  dependencySignature: "deps",
  reason: "Review note",
  document: {
    audienceQuestion: "Question?",
    titles: [linked],
    summary: linked,
    description: linked,
    thumbnailBrief: linked,
    chapters: [linked],
  },
}

describe("publication local recovery", () => {
  it("round trips draft and note, isolates projects and deletes only the selected copy", () => {
    const store = storage()
    writeRecovery(store, "project-a", draft)
    writeRecovery(store, "project-b", { ...draft, reason: "Other" })
    expect(readRecovery(store, "project-a")).toEqual(draft)
    deleteRecovery(store, "project-a")
    expect(readRecovery(store, "project-a")).toBeNull()
    expect(readRecovery(store, "project-b")?.reason).toBe("Other")
  })
  it("rejects corrupt or oversized copies and propagates storage errors", () => {
    const store = storage()
    store.setItem("scad.publication.recovery.v1:a", "{")
    expect(() => readRecovery(store, "a")).toThrow()
    store.setItem("scad.publication.recovery.v1:a", "x".repeat(128 * 1024 + 1))
    expect(() => readRecovery(store, "a")).toThrow(/large/)
    expect(() =>
      writeRecovery(
        {
          ...store,
          setItem: () => {
            throw new Error("quota")
          },
        },
        "a",
        draft,
      ),
    ).toThrow("quota")
  })
})
