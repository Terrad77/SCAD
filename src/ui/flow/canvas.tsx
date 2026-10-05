import { memo, useEffect, useRef, useSyncExternalStore } from "react"
import type { KeyboardEvent, PointerEvent } from "react"
import { createRoot } from "react-dom/client"
import type { TraceGraph, TraceNode } from "../../application/project-reader.js"
import {
  FlowStore,
  GRID,
  NODE_HEIGHT,
  NODE_WIDTH,
  SUMMARY,
  zoomAt,
  type Position,
} from "./store.js"
function usePosition(store: FlowStore, id: string) {
  return useSyncExternalStore(
    (listener) => store.subscribe(id, listener),
    () => store.get(id),
  )
}
function useSummary(store: FlowStore) {
  return useSyncExternalStore((listener) => store.subscribe(SUMMARY, listener), store.getSummary)
}
function text(node: TraceNode) {
  if (!node.data || typeof node.data !== "object")
    return node.status === "UNAVAILABLE"
      ? "Research data unavailable"
      : node.status === "AMBIGUOUS"
        ? "Duplicate identifier"
        : "Reference not found"
  const data = node.data as Record<string, unknown>
  return String(
    data.text ??
      data.statement ??
      data.title ??
      data.description ??
      data.rule ??
      data.detail ??
      node.kind,
  )
}
const Node = memo(function Node({ store, id }: { store: FlowStore; id: string }) {
  const position = usePosition(store, id),
    node = store.nodes[id]!
  return (
    <article
      className={`flow-node ${position.selected ? "selected" : ""}`}
      hidden={position.hidden}
      data-flow-node={id}
      tabIndex={0}
      aria-label={`${node.kind} ${id}: ${node.status}`}
      style={{ transform: `translate3d(${position.x}px,${position.y}px,0)` }}
      onFocus={() => store.select(id)}
    >
      <div className="flow-node-top">
        <span>{node.kind}</span>
        <span className={`flow-state ${node.status.toLowerCase()}`}>
          {node.status.toLowerCase()}
        </span>
      </div>
      <strong>{id}</strong>
      <p>{text(node)}</p>
    </article>
  )
})
const Edge = memo(function Edge({ store, index }: { store: FlowStore; index: number }) {
  const edge = store.graph.edges[index]!,
    a = usePosition(store, edge.from),
    b = usePosition(store, edge.to)
  if (!a || !b || a.hidden || b.hidden) return null
  const x = a.x + NODE_WIDTH,
    y = a.y + NODE_HEIGHT / 2,
    endX = b.x,
    endY = b.y + NODE_HEIGHT / 2,
    bend = Math.max(64, Math.abs(endX - x) / 2)
  return (
    <g>
      <path
        d={`M ${x} ${y} C ${x + bend} ${y}, ${endX - bend} ${endY}, ${endX} ${endY}`}
        markerEnd="url(#flow-arrow)"
        className={edge.supported === false ? "unsupported" : ""}
      />
      <title>
        {edge.relation}: {edge.from} → {edge.to}
        {edge.supported === false ? " (unsupported)" : ""}
      </title>
    </g>
  )
})
function Toolbar({
  store,
  fit,
  zoom,
}: {
  store: FlowStore
  fit: () => void
  zoom: (factor: number) => void
}) {
  const summary = useSummary(store)
  return (
    <div className="flow-toolbar">
      <strong>Evidence flow</strong>
      <button disabled={!summary.canUndo} onClick={() => store.undo()}>
        Undo
      </button>
      <button disabled={!summary.canRedo} onClick={() => store.redo()}>
        Redo
      </button>
      <button onClick={() => store.reset()}>Reset layout</button>
      <button onClick={fit}>Fit</button>
      <button aria-label="Zoom out" onClick={() => zoom(0.8)}>
        −
      </button>
      <button aria-label="Zoom in" onClick={() => zoom(1.25)}>
        +
      </button>
    </div>
  )
}
function sourceUrl(node: TraceNode | undefined) {
  if (!node?.data || typeof node.data !== "object") return null
  const value = (node.data as Record<string, unknown>).url
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}
function Inspector({ store }: { store: FlowStore }) {
  const { selected } = useSummary(store),
    node = selected ? store.nodes[selected] : undefined
  return (
    <div className="flow-inspector" aria-live="polite">
      {node ? (
        <>
          <strong>
            {node.id} · {node.status.toLowerCase()}
          </strong>
          <p>{text(node)}</p>
          {sourceUrl(node) && (
            <a href={sourceUrl(node)!} target="_blank" rel="noopener noreferrer">
              Open source
            </a>
          )}
          <small>
            {store.graph.edges
              .filter((e) => e.from === node.id)
              .map((e) => `${e.relation} → ${e.to}${e.supported === false ? " (unsupported)" : ""}`)
              .join(" · ")}
          </small>
        </>
      ) : (
        <p>Select a node to inspect its content. Layout changes affect this view only.</p>
      )}
    </div>
  )
}
function Flow({ store }: { store: FlowStore }) {
  const canvas = useRef<HTMLDivElement>(null),
    world = useRef<HTMLDivElement>(null),
    zoomLabel = useRef<HTMLOutputElement>(null)
  const viewport = useRef({ x: 24, y: 24, zoom: 1 }),
    space = useRef(false)
  const gesture = useRef<null | {
    pointer: number
    startX: number
    startY: number
    id: string | null
    before: Position | null
    view: { x: number; y: number; zoom: number }
  }>(null)
  const update = () => {
    const v = viewport.current
    if (world.current)
      world.current.style.transform = `translate3d(${v.x}px,${v.y}px,0) scale(${v.zoom})`
    if (canvas.current) {
      canvas.current.style.backgroundSize = `${GRID * v.zoom}px ${GRID * v.zoom}px`
      canvas.current.style.backgroundPosition = `${v.x}px ${v.y}px`
    }
    if (zoomLabel.current) zoomLabel.current.value = `${Math.round(v.zoom * 100)}%`
  }
  const fit = () => {
    if (!canvas.current) return
    const visible = store.ids.map((id) => store.get(id)).filter((p) => !p.hidden)
    if (!visible.length) return
    const minX = Math.min(...visible.map((p) => p.x)),
      minY = Math.min(...visible.map((p) => p.y)),
      maxX = Math.max(...visible.map((p) => p.x)) + NODE_WIDTH,
      maxY = Math.max(...visible.map((p) => p.y)) + NODE_HEIGHT
    const zoom = Math.max(
      0.2,
      Math.min(
        1,
        (canvas.current.clientWidth - 48) / (maxX - minX),
        (canvas.current.clientHeight - 48) / (maxY - minY),
      ),
    )
    viewport.current = {
      x: (canvas.current.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (canvas.current.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom,
      zoom,
    }
    update()
  }
  const zoom = (factor: number) => {
    if (!canvas.current) return
    viewport.current = zoomAt(
      viewport.current,
      { x: canvas.current.clientWidth / 2, y: canvas.current.clientHeight / 2 },
      factor,
    )
    update()
  }
  useEffect(() => {
    const element = canvas.current!
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      viewport.current = zoomAt(
        viewport.current,
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        Math.exp(-event.deltaY * 0.001),
      )
      update()
    }
    element.addEventListener("wheel", wheel, { passive: false })
    fit()
    return () => {
      element.removeEventListener("wheel", wheel)
      const g = gesture.current
      if (g?.id && g.before) store.cancel(g.id, g.before)
    }
  }, [store])
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current || (event.button !== 0 && event.button !== 1)) return
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-flow-node]") : null
    const id = !space.current && event.button === 0 ? (target?.dataset.flowNode ?? null) : null
    if (id) {
      store.select(id)
      target?.focus()
    } else {
      store.select(null)
      event.currentTarget.focus()
    }
    gesture.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      id,
      before: id ? store.get(id) : null,
      view: { ...viewport.current },
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.pointer !== event.pointerId) return
    const dx = event.clientX - g.startX,
      dy = event.clientY - g.startY
    if (g.id && g.before)
      store.preview(g.id, g.before.x + dx / g.view.zoom, g.before.y + dy / g.view.zoom)
    else {
      viewport.current = { ...g.view, x: g.view.x + dx, y: g.view.y + dy }
      update()
    }
  }
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const g = gesture.current
    if (!g || g.pointer !== event.pointerId) return
    gesture.current = null
    if (g.id && g.before) {
      if (cancel) store.cancel(g.id, g.before)
      else store.commitMove(g.id, g.before)
    }
    if (cancel && !g.id) {
      viewport.current = g.view
      update()
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.code === "Space") {
      space.current = true
      event.preventDefault()
      return
    }
    if (event.key === "Escape" && gesture.current) {
      const g = gesture.current
      gesture.current = null
      if (g.id && g.before) store.cancel(g.id, g.before)
      else {
        viewport.current = g.view
        update()
      }
      if (event.currentTarget.hasPointerCapture(g.pointer))
        event.currentTarget.releasePointerCapture(g.pointer)
      event.preventDefault()
      return
    }
    if (gesture.current) return
    const id = store.getSummary().selected,
      command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault()
      if (event.shiftKey) store.redo()
      else store.undo()
    } else if (command && event.key.toLowerCase() === "y") {
      event.preventDefault()
      store.redo()
    } else if ((event.key === "Delete" || event.key === "Backspace") && id) {
      event.preventDefault()
      store.hide(id)
      event.currentTarget.focus()
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault()
      const step = GRID * (event.shiftKey ? 5 : 1),
        dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
        dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0
      if (id) store.move(id, dx, dy)
      else {
        viewport.current = {
          ...viewport.current,
          x: viewport.current.x - dx,
          y: viewport.current.y - dy,
        }
        update()
      }
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoom(1.25)
    } else if (event.key === "-") {
      event.preventDefault()
      zoom(0.8)
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault()
      fit()
    }
  }
  return (
    <div className="flow-shell">
      <Toolbar store={store} fit={fit} zoom={zoom} />
      <p className="flow-help">
        Drag nodes · Drag background / Space + drag to pan · Scroll to zoom · Arrows move selection
        · Delete hides from view · Ctrl/Cmd+Z undo · F fit <output ref={zoomLabel} />
      </p>
      <div
        className="flow-canvas"
        ref={canvas}
        tabIndex={0}
        role="region"
        aria-label="Evidence flow canvas"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(e) => finish(e)}
        onPointerCancel={(e) => finish(e, true)}
        onLostPointerCapture={(e) => finish(e, true)}
        onKeyDown={key}
        onKeyUp={(e) => {
          if (e.code === "Space") space.current = false
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) space.current = false
        }}
      >
        <div className="flow-world" ref={world}>
          <svg className="flow-edges" aria-hidden="true">
            <defs>
              <marker
                id="flow-arrow"
                viewBox="0 0 10 10"
                refX="10"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <polygon points="0,0 10,5 0,10" fill="#728f7d" />
              </marker>
            </defs>
            {store.graph.edges.map((_, index) => (
              <Edge store={store} index={index} key={index} />
            ))}
          </svg>
          {store.ids.map((id) => (
            <Node store={store} id={id} key={id} />
          ))}
        </div>
      </div>
      <Inspector store={store} />
      {store.graph.notices.map((notice, index) => (
        <p className="muted" key={index}>
          {notice}
        </p>
      ))}
    </div>
  )
}
export function mountFlow(element: HTMLElement, graph: TraceGraph) {
  const root = createRoot(element)
  root.render(<Flow store={new FlowStore(graph)} />)
  return () => root.unmount()
}
