import type { TraceGraph } from "../../application/project-reader.js"
export type Position = Readonly<{ x: number; y: number; hidden: boolean; selected: boolean }>
type Change = { id: string; before: Position; after: Position }
type Command = { changes: Change[] }
type Listener = () => void
export const SUMMARY = Symbol("flow-summary")
export const GRID = 24
export const NODE_WIDTH = 240
export const NODE_HEIGHT = 144
export function snap(value: number) {
  return Math.round(value / GRID) * GRID
}
export function zoomAt(
  view: { x: number; y: number; zoom: number },
  point: { x: number; y: number },
  factor: number,
) {
  const zoom = Math.max(0.2, Math.min(2, view.zoom * factor))
  return {
    x: point.x - ((point.x - view.x) * zoom) / view.zoom,
    y: point.y - ((point.y - view.y) * zoom) / view.zoom,
    zoom,
  }
}
/** Node-local subscriptions keep pointer moves from rerendering the entire canvas. */
export class FlowStore {
  readonly nodes: Record<string, TraceGraph["nodes"][number]> = Object.create(null) as Record<
    string,
    TraceGraph["nodes"][number]
  >
  readonly ids: string[]
  private positions = new Map<string, Position>()
  private initial = new Map<string, Position>()
  private listeners = new Map<string | symbol, Set<Listener>>()
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private selected: string | null = null
  private summary = { canUndo: false, canRedo: false, selected: null as string | null }
  constructor(readonly graph: TraceGraph) {
    const columns: Record<string, number> = {
      shot: 0,
      sentence: 1,
      claim: 2,
      hypothesis: 3,
      uncertainty: 3,
      constraint: 3,
      contradiction: 3,
      evidence: 3,
      source: 4,
      reference: 5,
    }
    const rows = new Map<number, number>()
    this.ids = graph.nodes.map((n) => n.id)
    for (const node of graph.nodes) {
      this.nodes[node.id] = node
      const column = columns[node.kind] ?? 5,
        row = rows.get(column) ?? 0
      rows.set(column, row + 1)
      const position = { x: column * 312, y: row * 192, hidden: false, selected: false }
      this.positions.set(node.id, position)
      this.initial.set(node.id, position)
    }
  }
  get = (id: string) => this.positions.get(id)!
  getSummary = () => this.summary
  subscribe = (id: string | symbol, listener: Listener) => {
    let group = this.listeners.get(id)
    if (!group) {
      group = new Set()
      this.listeners.set(id, group)
    }
    group.add(listener)
    return () => {
      group.delete(listener)
    }
  }
  private emit(id: string | symbol) {
    for (const listener of this.listeners.get(id) ?? []) listener()
  }
  private publish() {
    this.summary = {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      selected: this.selected,
    }
    this.emit(SUMMARY)
  }
  select(id: string | null) {
    const previous = this.selected
    this.selected = id
    if (previous && this.positions.has(previous)) {
      this.positions.set(previous, { ...this.get(previous), selected: false })
      this.emit(previous)
    }
    if (id && this.positions.has(id)) {
      this.positions.set(id, { ...this.get(id), selected: true })
      this.emit(id)
    }
    this.publish()
  }
  preview(id: string, x: number, y: number) {
    this.positions.set(id, { ...this.get(id), x, y })
    this.emit(id)
  }
  cancel(id: string, before: Position) {
    this.positions.set(id, { ...before, selected: this.selected === id })
    this.emit(id)
  }
  commitMove(id: string, before: Position) {
    const current = this.get(id),
      after = { ...current, x: snap(current.x), y: snap(current.y) }
    this.positions.set(id, after)
    this.emit(id)
    if (before.x !== after.x || before.y !== after.y) this.record([{ id, before, after }])
  }
  move(id: string, dx: number, dy: number) {
    const before = this.get(id)
    this.preview(id, before.x + dx, before.y + dy)
    this.commitMove(id, before)
  }
  hide(id: string) {
    const before = this.get(id)
    if (!before.hidden) {
      const after = { ...before, hidden: true }
      this.positions.set(id, after)
      this.emit(id)
      this.record([{ id, before, after }])
      this.select(null)
    }
  }
  reset() {
    const changes = this.ids
      .map((id) => ({ id, before: this.get(id), after: this.initial.get(id)! }))
      .filter((c) => c.before.x !== c.after.x || c.before.y !== c.after.y || c.before.hidden)
    if (changes.length) {
      this.apply({ changes }, false)
      this.record(changes)
    }
  }
  private record(changes: Change[]) {
    this.undoStack.push({ changes })
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack = []
    this.publish()
  }
  private apply(command: Command, backward: boolean) {
    for (const c of command.changes) {
      this.positions.set(c.id, {
        ...(backward ? c.before : c.after),
        selected: this.selected === c.id,
      })
      this.emit(c.id)
    }
  }
  undo() {
    const command = this.undoStack.pop()
    if (command) {
      this.apply(command, true)
      this.redoStack.push(command)
      this.publish()
    }
  }
  redo() {
    const command = this.redoStack.pop()
    if (command) {
      this.apply(command, false)
      this.undoStack.push(command)
      this.publish()
    }
  }
}
