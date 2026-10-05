import { describe, it, expect } from "vitest"
import { FlowStore, zoomAt, snap } from "../src/ui/flow/store.js"
import type { TraceGraph } from "../src/application/project-reader.js"
const graph: TraceGraph = {
  subjectId: "SNT_1",
  readVersion: "v1",
  notices: [],
  nodes: [
    { id: "SNT_1", kind: "sentence", status: "FOUND", data: { text: "Saved sentence" } },
    { id: "CLM_1", kind: "claim", status: "FOUND", data: { statement: "Saved claim" } },
  ],
  edges: [{ from: "SNT_1", to: "CLM_1", relation: "claim-reference", supported: null }],
}
describe("Flow layout commands", () => {
  it("updates only the moved node subscription and preserves graph bytes", () => {
    const store = new FlowStore(graph),
      before = JSON.stringify(graph),
      untouched = store.get("CLM_1")
    let a = 0,
      b = 0
    store.subscribe("SNT_1", () => a++)
    store.subscribe("CLM_1", () => b++)
    store.preview("SNT_1", 101, -29)
    expect(a).toBe(1)
    expect(b).toBe(0)
    expect(store.get("CLM_1")).toBe(untouched)
    expect(JSON.stringify(graph)).toBe(before)
  })
  it("records one snapped command for many drag updates, with undo and redo", () => {
    const store = new FlowStore(graph),
      before = store.get("SNT_1")
    store.preview("SNT_1", 12, 1)
    store.preview("SNT_1", 49, 27)
    store.commitMove("SNT_1", before)
    expect(store.get("SNT_1")).toMatchObject({ x: 48, y: 24 })
    store.undo()
    expect(store.get("SNT_1")).toEqual(before)
    expect(store.getSummary().canUndo).toBe(false)
    store.redo()
    expect(store.get("SNT_1")).toMatchObject({ x: 48, y: 24 })
  })
  it("cancels pointer changes without history", () => {
    const store = new FlowStore(graph),
      before = store.get("SNT_1")
    store.preview("SNT_1", 1000, 50)
    store.cancel("SNT_1", before)
    expect(store.get("SNT_1")).toEqual(before)
    expect(store.getSummary().canUndo).toBe(false)
  })
  it("hides from view reversibly without removing nodes or edges", () => {
    const store = new FlowStore(graph)
    store.select("CLM_1")
    store.hide("CLM_1")
    expect(store.get("CLM_1").hidden).toBe(true)
    expect(store.nodes.CLM_1).toBe(graph.nodes[1])
    expect(store.graph.edges).toHaveLength(1)
    store.undo()
    expect(store.get("CLM_1").hidden).toBe(false)
    store.redo()
    expect(store.get("CLM_1").hidden).toBe(true)
  })
  it("resets all layout changes as one reversible command", () => {
    const store = new FlowStore(graph),
      before = store.get("SNT_1")
    store.move("SNT_1", 24, 24)
    const moved = store.get("SNT_1")
    store.hide("CLM_1")
    store.reset()
    expect(store.get("SNT_1")).toEqual(before)
    expect(store.get("CLM_1").hidden).toBe(false)
    store.undo()
    expect(store.get("SNT_1")).toEqual(moved)
    expect(store.get("CLM_1").hidden).toBe(true)
  })
  it("invalidates redo after a new command and ignores no-op moves", () => {
    const store = new FlowStore(graph)
    store.move("SNT_1", 24, 0)
    store.undo()
    store.move("CLM_1", 0, 24)
    expect(store.getSummary().canRedo).toBe(false)
    store.undo()
    store.move("SNT_1", 0, 0)
    expect(store.getSummary().canUndo).toBe(false)
  })
  it("keeps the world point beneath the zoom anchor fixed and clamps zoom", () => {
    const view = { x: 40, y: -20, zoom: 0.5 },
      point = { x: 200, y: 100 },
      next = zoomAt(view, point, 2)
    expect((point.x - next.x) / next.zoom).toBe((point.x - view.x) / view.zoom)
    expect((point.y - next.y) / next.zoom).toBe((point.y - view.y) / view.zoom)
    expect(zoomAt(view, point, 100).zoom).toBe(2)
    expect(zoomAt(view, point, 0.01).zoom).toBe(0.2)
    expect(snap(-49)).toBe(-48)
  })
})
