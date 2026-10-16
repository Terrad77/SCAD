import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { RunHistoryPage } from "../application/project-runs.js"

type Props = { load: (cursor?: string) => Promise<RunHistoryPage> }
const stages: Record<string, string> = {
  research: "Research",
  claims: "Claims",
  hypotheses: "Hypotheses",
  factCheck: "Fact check",
  epistemicPreparation: "Epistemic preparation",
  reasoningContext: "Reasoning context",
  narrative: "Script",
  visual: "Visual plan",
  selfCheck: "Self-check",
}
const states = {
  RUNNING: "Running",
  WAITING_REVIEW: "Stopped for human review",
  COMPLETED: "Completed",
  FAILED: "Failed",
}
export function RunHistoryPanel({ load }: Props) {
  const [page, setPage] = useState<RunHistoryPage | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const alive = useRef(true)
  const active = useRef(false)
  const last = useRef<{ cursor?: string }>({})
  const feedback = useRef<HTMLParagraphElement>(null)
  const request = async (cursor?: string, focus = true) => {
    if (active.current) return
    active.current = true
    last.current = { cursor }
    setBusy(true)
    setError("")
    try {
      const next = await load(cursor)
      if (!alive.current) return
      setPage((previous) =>
        cursor && previous
          ? {
              ...next,
              entries: [
                ...previous.entries,
                ...next.entries.filter(
                  (entry) => !previous.entries.some((old) => old.id === entry.id),
                ),
              ],
            }
          : next,
      )
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : "Unable to read run history")
    } finally {
      active.current = false
      if (alive.current) {
        setBusy(false)
        if (focus) feedback.current?.focus()
      }
    }
  }
  useEffect(() => {
    alive.current = true
    void request(undefined, false)
    return () => {
      alive.current = false
    }
    // A mounted panel belongs to one project; navigation unmounts it.
  }, [load])
  return (
    <section className="run-history" aria-labelledby="browser-history-heading" aria-busy={busy}>
      <h2 id="browser-history-heading">Browser run history</h2>
      <p>
        Inspect saved launches, checkpoints and explicit continuations. Historical decisions do not
        certify current approvals or the audit verdict. Review and continue the latest checkpoint
        from Overview.
      </p>
      <p className="muted">
        Records are read on request, without automatic execution or recovery. Each run retains up to
        100 recent events; this is not a complete approval ledger.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void request()
        }}
      >
        Refresh run history
      </button>
      <p ref={feedback} tabIndex={-1} role="status" aria-live="polite">
        {busy
          ? "Reading run history…"
          : page
            ? `${page.entries.length} of ${page.total} saved runs shown.`
            : "Run history unavailable."}
      </p>
      {error && (
        <div className="notice bad" role="alert">
          <p>
            {error} Existing rows, if shown, remain historical. Refresh after inspecting the journal
            if necessary.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void request(last.current.cursor)
            }}
          >
            Retry history request
          </button>
        </div>
      )}
      {page && !page.entries.length && (
        <p>No browser runs recorded for this project. CLI-only runs are not listed here.</p>
      )}
      {page && (
        <ol className="run-history-list">
          {page.entries.map((run) => (
            <li key={run.id}>
              <details>
                <summary>
                  <time dateTime={run.startedAt}>
                    {new Date(run.startedAt).toLocaleString("en-GB")}
                  </time>
                  {" · "}
                  {run.execution === "UNVERIFIED" ? "Execution unverified" : states[run.state]}
                  {run.stage ? " · " + (stages[run.stage] ?? run.stage) : ""}
                  {run.latest ? " · Latest record" : ""}
                </summary>
                <p>
                  Run: <code>{run.id}</code>
                </p>
                <p>
                  Updated: <time dateTime={run.updatedAt}>{run.updatedAt}</time>
                </p>
                {run.resumeOf ? (
                  <p>
                    Explicit continuation of: <code>{run.resumeOf}</code>
                    {run.parentMissing ? " · Parent record unavailable" : ""}
                  </p>
                ) : (
                  <p>Initial launch; no parent run recorded.</p>
                )}
                {run.execution === "ACTIVE" && (
                  <p className="notice">
                    This server currently owns this execution. Refresh to read later events.
                  </p>
                )}
                {run.execution === "UNVERIFIED" && (
                  <p className="notice">
                    The journal says RUNNING, but this server cannot confirm ownership. Inspect the
                    operator state; history does not restart it.
                  </p>
                )}
                {run.decision && (
                  <p>
                    Recorded checkpoint decision:{" "}
                    <strong>{run.decision.action === "APPROVE" ? "Approved" : "Rejected"}</strong>
                    {run.decision.reason ? " · " + run.decision.reason : ""}. Historical journal
                    entry; current authority is checked separately.
                  </p>
                )}
                {run.checkpoint && (
                  <details>
                    <summary>Recorded checkpoint identity</summary>
                    <p>
                      Candidate: <code>{run.checkpoint.artifactSignature}</code>
                    </p>
                    <p>
                      Dependencies: <code>{run.checkpoint.dependencySignature}</code>
                    </p>
                    <p>
                      Inputs: <code>{run.checkpoint.inputSignature}</code>
                    </p>
                  </details>
                )}
                <h3>Saved events ({run.events.length})</h3>
                {run.events.length ? (
                  <ol className="run-log">
                    {run.events.map((event, index) => (
                      <li key={index}>
                        <time dateTime={event.at}>{event.at}</time>
                        <span>{event.message}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No saved events.</p>
                )}
              </details>
            </li>
          ))}
        </ol>
      )}
      {page?.nextCursor && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void request(page.nextCursor!)
          }}
        >
          Load older runs
        </button>
      )}
    </section>
  )
}
export function mountRunHistory(element: HTMLElement, props: Props) {
  const root = createRoot(element)
  root.render(<RunHistoryPanel {...props} />)
  return () => root.unmount()
}
