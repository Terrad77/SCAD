import type { TraceGraph } from "../../application/project-reader.js"
export type SavedPosition = { id: string; x: number; y: number; hidden: boolean }
export type LayoutScope = { project: string; subject: string; readVersion: string }
export interface LayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export const STORAGE_KEY = "scad.flow.layouts.v1"
const LIMIT = 40
const MAX_COORDINATE = 1_000_000
export type SavedLayout = LayoutScope & { version: 1; nodes: SavedPosition[] }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function parse(value: unknown): SavedLayout | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.project !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.readVersion !== "string" ||
    value.project.length > 128 ||
    value.subject.length > 512 ||
    value.readVersion.length > 128 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 1000
  )
    return null
  const nodes: SavedPosition[] = [],
    seen = new Set<string>()
  for (const item of value.nodes) {
    if (
      !object(item) ||
      typeof item.id !== "string" ||
      item.id.length > 512 ||
      seen.has(item.id) ||
      typeof item.x !== "number" ||
      typeof item.y !== "number" ||
      !Number.isFinite(item.x) ||
      !Number.isFinite(item.y) ||
      Math.abs(item.x) > MAX_COORDINATE ||
      Math.abs(item.y) > MAX_COORDINATE ||
      typeof item.hidden !== "boolean"
    )
      return null
    seen.add(item.id)
    nodes.push({ id: item.id, x: item.x, y: item.y, hidden: item.hidden })
  }
  return {
    version: 1,
    project: value.project,
    subject: value.subject,
    readVersion: value.readVersion,
    nodes,
  }
}
function read(storage: LayoutStorage): SavedLayout[] {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return []
  if (raw.length > 2_000_000) throw new Error("Stored layout exceeds viewer limits")
  const decoded: unknown = JSON.parse(raw)
  if (!Array.isArray(decoded) || decoded.length > LIMIT) throw new Error("Invalid layout storage")
  return decoded.flatMap((value) => {
    const layout = parse(value)
    return layout ? [layout] : []
  })
}
export function loadLayout(
  storage: LayoutStorage,
  scope: LayoutScope,
  graph: TraceGraph,
): { nodes: SavedPosition[] | null; status: string } {
  try {
    const saved = read(storage).find(
      (l) => l.project === scope.project && l.subject === scope.subject,
    )
    if (!saved) return { nodes: null, status: "Layout will be saved in this browser" }
    if (saved.readVersion !== scope.readVersion)
      return { nodes: null, status: "Project snapshot changed; using a fresh layout" }
    const ids = new Set(graph.nodes.map((n) => n.id))
    if (saved.nodes.length !== ids.size || saved.nodes.some((n) => !ids.has(n.id)))
      return { nodes: null, status: "Saved layout does not match this graph; using a fresh layout" }
    return { nodes: saved.nodes, status: "Layout restored from this browser" }
  } catch {
    return { nodes: null, status: "Browser layout storage unavailable; using a temporary layout" }
  }
}
export function saveLayout(
  storage: LayoutStorage,
  scope: LayoutScope,
  nodes: SavedPosition[],
): boolean {
  try {
    const layout = parse({ ...scope, version: 1, nodes })
    if (!layout) return false
    let saved: SavedLayout[]
    try {
      saved = read(storage)
    } catch {
      saved = []
    }
    const next = saved.filter((l) => l.project !== scope.project || l.subject !== scope.subject)
    next.push(layout)
    storage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-LIMIT)))
    return true
  } catch {
    return false
  }
}
export function searchNodes(graph: TraceGraph, query: string): TraceGraph["nodes"] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return graph.nodes.filter((node) => {
    const data = object(node.data) ? node.data : {}
    const haystack = [
      node.id,
      node.kind,
      node.status,
      data.text,
      data.statement,
      data.title,
      data.description,
      data.rule,
      data.detail,
    ]
      .filter((v) => typeof v === "string")
      .join(" ")
      .toLocaleLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}
