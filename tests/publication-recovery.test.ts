import { describe, expect, it } from "vitest"
import {
  deleteRecovery,
  readRecovery,
  recoveryMatches,
  writeRecovery,
  type Recovery,
} from "../src/ui/publication-recovery.js"
import type { PublicationState } from "../src/application/publication-packages.js"

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

describe("recovery identity checks", () => {
  const source = { id: "source", proofSignature: "proof", dependencySignature: "deps" }
  const state = {
    projectVersion: "p1",
    journalVersion: "j1",
    sources: [source],
    packages: [{ packageId: "pkg", revision: 2, source }],
  } as unknown as PublicationState
  it("permits recovery only for the exact saved revision and source", () => {
    expect(recoveryMatches(draft, state)).toBe(true)
    for (const changed of [
      { ...state, projectVersion: "other" },
      { ...state, journalVersion: "other" },
      { ...state, packages: [] },
      { ...state, packages: [{ ...state.packages[0]!, revision: 3 }] },
      {
        ...state,
        packages: [
          { ...state.packages[0]!, source: { ...state.packages[0]!.source, id: "other" } },
        ],
      },
      {
        ...state,
        packages: [
          {
            ...state.packages[0]!,
            source: { ...state.packages[0]!.source, proofSignature: "other" },
          },
        ],
      },
      {
        ...state,
        packages: [
          {
            ...state.packages[0]!,
            source: { ...state.packages[0]!.source, dependencySignature: "other" },
          },
        ],
      },
    ])
      expect(recoveryMatches(draft, changed)).toBe(false)
  })
  it("supports new drafts only when the original eligible source still matches", () => {
    const fresh = { ...draft, packageId: "", revision: null }
    expect(recoveryMatches(fresh, state)).toBe(true)
    expect(recoveryMatches(fresh, { ...state, sources: [] })).toBe(false)
    expect(recoveryMatches({ ...fresh, revision: 1 }, state)).toBe(false)
  })
})
