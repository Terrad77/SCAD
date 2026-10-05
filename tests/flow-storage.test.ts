import { describe, expect, it } from "vitest"
import type { TraceGraph } from "../src/application/project-reader.js"
import {
  loadLayout,
  saveLayout,
  searchNodes,
  STORAGE_KEY,
  type LayoutStorage,
} from "../src/ui/flow/layout-storage.js"
import { COMMITTED, FlowStore } from "../src/ui/flow/store.js"
const graph: TraceGraph = {
  subjectId: "CLM_1",
  readVersion: "v1",
  notices: [],
  edges: [],
  nodes: [
    {
      id: "CLM_1",
      kind: "claim",
      status: "FOUND",
      data: { statement: "Ocean temperature", secret: "material" },
    },
    { id: "SRC_1", kind: "source", status: "UNAVAILABLE", data: { title: "Ocean report" } },
  ],
}
const scope = { project: "project", subject: graph.subjectId, readVersion: graph.readVersion }
class Storage implements LayoutStorage {
  raw: string | null = null
  getItem(_key?: string) {
    return this.raw
  }
  setItem(_key: string, value: string) {
    this.raw = value
  }
}
describe("browser Flow layout", () => {
  it("restores positions and visibility without data, selection or history", () => {
    const storage = new Storage(),
      store = new FlowStore(graph),
      bytes = JSON.stringify(graph)
    store.move("CLM_1", 48, 24)
    store.hide("SRC_1")
    store.select("CLM_1")
    expect(saveLayout(storage, scope, store.exportLayout())).toBe(true)
    const restored = new FlowStore(graph)
    restored.restoreLayout(loadLayout(storage, scope, graph).nodes!)
    expect(restored.exportLayout()).toEqual(store.exportLayout())
    expect(restored.get("CLM_1").selected).toBe(false)
    expect(restored.getSummary().canUndo).toBe(false)
    expect(storage.raw).not.toContain("Ocean")
    expect(storage.raw).not.toContain("selected")
    expect(JSON.stringify(graph)).toBe(bytes)
  })
  it("isolates projects and subjects and rejects changed snapshots or node sets", () => {
    const storage = new Storage()
    saveLayout(storage, scope, new FlowStore(graph).exportLayout())
    expect(loadLayout(storage, { ...scope, project: "other" }, graph).nodes).toBeNull()
    expect(loadLayout(storage, { ...scope, subject: "other" }, graph).nodes).toBeNull()
    expect(loadLayout(storage, { ...scope, readVersion: "v2" }, graph).status).toContain(
      "snapshot changed",
    )
    expect(loadLayout(storage, scope, { ...graph, nodes: graph.nodes.slice(1) }).nodes).toBeNull()
  })
  it("ignores malformed records and handles corrupt or unavailable storage", () => {
    const storage = new Storage(),
      nodes = new FlowStore(graph).exportLayout()
    for (const invalid of [
      [...nodes, nodes[0]],
      [{ ...nodes[0], x: 1e9 }],
      [{ ...nodes[0], x: null }],
    ]) {
      storage.raw = JSON.stringify([{ ...scope, version: 1, nodes: invalid }])
      expect(loadLayout(storage, scope, graph).nodes).toBeNull()
    }
    storage.raw = "broken"
    expect(loadLayout(storage, scope, graph).status).toContain("unavailable")
    const blocked: LayoutStorage = {
      getItem() {
        throw Error("blocked")
      },
      setItem() {
        throw Error("quota")
      },
    }
    expect(loadLayout(blocked, scope, graph).nodes).toBeNull()
    expect(saveLayout(blocked, scope, nodes)).toBe(false)
    expect(saveLayout(storage, scope, [{ ...nodes[0]!, x: Infinity }])).toBe(false)
    expect(saveLayout(storage, scope, nodes)).toBe(true)
  })
  it("bounds storage and replaces the previous snapshot for a subject", () => {
    const storage = new Storage(),
      nodes = new FlowStore(graph).exportLayout()
    for (let i = 0; i < 45; i++) saveLayout(storage, { ...scope, subject: String(i) }, nodes)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toHaveLength(40)
    saveLayout(storage, { ...scope, subject: "44", readVersion: "v2" }, nodes)
    expect(JSON.parse(storage.raw!)).toHaveLength(40)
    expect(
      loadLayout(storage, { ...scope, subject: "44", readVersion: "v2" }, graph).nodes,
    ).toEqual(nodes)
  })
  it("persists only committed commands, including undo and redo", () => {
    const store = new FlowStore(graph),
      storage = new Storage(),
      before = store.get("CLM_1")
    let writes = 0
    store.subscribe(COMMITTED, () => {
      writes++
      saveLayout(storage, scope, store.exportLayout())
    })
    store.select("CLM_1")
    store.preview("CLM_1", 100, 50)
    store.cancel("CLM_1", before)
    expect(writes).toBe(0)
    store.move("CLM_1", 24, 0)
    store.undo()
    store.redo()
    expect(writes).toBe(3)
    expect(loadLayout(storage, scope, graph).nodes).toEqual(store.exportLayout())
  })
  it("reveals hidden search targets as a reversible layout command", () => {
    const store = new FlowStore(graph)
    store.hide("CLM_1")
    store.reveal("CLM_1")
    expect(store.get("CLM_1")).toMatchObject({ hidden: false, selected: true })
    store.undo()
    expect(store.get("CLM_1").hidden).toBe(true)
  })
  it("searches all terms across IDs, types, status and content", () => {
    expect(searchNodes(graph, "oCEan FOUND").map((n) => n.id)).toEqual(["CLM_1"])
    expect(searchNodes(graph, "src unavailable").map((n) => n.id)).toEqual(["SRC_1"])
    expect(searchNodes(graph, "ocean absent")).toEqual([])
    expect(searchNodes(graph, "  ")).toEqual([])
    expect(searchNodes(graph, "material")).toEqual([])
  })
})
