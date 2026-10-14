import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ExportFormat, ProjectExport } from "../application/project-export.js"

type Props = {
  hasScript: boolean
  blocked: boolean
  load: (format: ExportFormat) => Promise<ProjectExport>
}
export function ProjectExportPanel({ hasScript, blocked, load }: Props) {
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const active = useRef(false)
  const alive = useRef(true)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    alive.current = true
    const pending = timers.current
    return () => {
      alive.current = false
      for (const [url, timer] of pending) {
        clearTimeout(timer)
        URL.revokeObjectURL(url)
      }
      pending.clear()
    }
  }, [])
  const download = async (format: ExportFormat) => {
    if (active.current || blocked) return
    active.current = true
    setBusy(format)
    setError("")
    setMessage("")
    try {
      const file = await load(format)
      if (!alive.current) return
      const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }))
      const link = document.createElement("a")
      link.href = url
      link.download = file.filename
      document.body.append(link)
      link.click()
      link.remove()
      timers.current.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url)
          timers.current.delete(url)
        }, 30000),
      )
      setMessage("Download requested: " + file.filename + ". Check your browser downloads.")
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : "Unable to prepare export")
    } finally {
      active.current = false
      if (alive.current) setBusy(null)
    }
  }
  return (
    <section className="export-panel" aria-labelledby="export-heading" aria-busy={busy !== null}>
      <h2 id="export-heading">Export saved materials</h2>
      <p>
        Download a local review copy of this snapshot. Knowledge labels, audit findings and
        freshness remain visible. This does not approve or publish the project.
      </p>
      <p className="muted">
        The JSON snapshot contains original material file contents and file status. It excludes
        approval/run receipts and is not a restorable backup. Exact video chapters and subtitles
        require the final edit.
      </p>
      {blocked && (
        <p className="notice bad">
          Export is unavailable while publication is incomplete or saved files fail validation.
          Refresh materials and inspect their status.
        </p>
      )}
      {!hasScript && (
        <p className="muted">No valid saved script yet. You can export the available snapshot.</p>
      )}
      <div className="project-actions">
        <button
          type="button"
          disabled={blocked || busy !== null || !hasScript}
          onClick={() => {
            void download("script")
          }}
        >
          {busy === "script" ? "Preparing script…" : "Download script (.md)"}
        </button>
        <button
          type="button"
          disabled={blocked || busy !== null}
          onClick={() => {
            void download("snapshot")
          }}
        >
          {busy === "snapshot" ? "Preparing snapshot…" : "Download snapshot (.json)"}
        </button>
      </div>
      <p role="status" aria-live="polite">
        {busy ? "Preparing the saved snapshot…" : message}
      </p>
      {error && (
        <p role="alert" className="notice bad">
          {error} Refresh materials if the project changed, then retry the download.
        </p>
      )}
    </section>
  )
}
export function mountProjectExport(element: HTMLElement, props: Props) {
  const root = createRoot(element)
  root.render(<ProjectExportPanel {...props} />)
  return () => root.unmount()
}
