import { ResearchReviewPanel } from "./research-review-panel.js"
import type { ResearchReview, ReviewRequest } from "../application/project-reviews.js"
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ProjectRun, RunView, ResumeRequest } from "../application/project-runs.js"
type Props = {
  version: string
  canStart: boolean
  load: () => Promise<RunView>
  start: (request: { requestId: string; expectedVersion: string }) => Promise<ProjectRun>
  resume: (input: ResumeRequest) => Promise<ProjectRun>
  review: () => Promise<ResearchReview>
  decide: (input: ReviewRequest) => Promise<NonNullable<ResearchReview["decision"]>>
  refresh: () => void
}
export function ProjectRunPanel(props: Props) {
  const [value, setValue] = useState<RunView | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const request = useRef<{ requestId: string; expectedVersion: string } | null>(null)
  const active = useRef(false)
  const mounted = useRef(true)
  const status = useRef<HTMLParagraphElement>(null)
  const focusContinuation = useRef(false)
  useEffect(() => {
    if (focusContinuation.current) {
      status.current?.focus()
      focusContinuation.current = false
    }
  }, [value?.run?.id])
  useEffect(() => {
    mounted.current = true
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await props.load()
        if (disposed) return
        setValue(next)
        setError("")
        setLoading(false)
        if (next.run?.state === "RUNNING" && next.owned)
          timer = setTimeout(() => {
            void poll()
          }, 1500)
      } catch (failure) {
        if (disposed) return
        setLoading(false)
        setError(failure instanceof Error ? failure.message : "Unable to load run status")
      }
    }
    void poll()
    return () => {
      disposed = true
      mounted.current = false
      if (timer) clearTimeout(timer)
    }
  }, [props.load, retry])
  const run = value?.run
  const needsAttention = run?.state === "WAITING_REVIEW" || run?.state === "RUNNING"
  const state =
    run?.state === "WAITING_REVIEW" && run.decision
      ? "Review recorded; execution stopped"
      : run?.state === "RUNNING" && !value?.owned
        ? "Execution unverified"
        : {
            RUNNING: "Running",
            WAITING_REVIEW: "Waiting for human review",
            COMPLETED: "Completed",
            FAILED: "Failed",
          }[run?.state ?? "COMPLETED"]
  return (
    <section className="run-panel" aria-labelledby="run-heading">
      <h2 id="run-heading">Pipeline run</h2>
      <p className="muted">
        Run saved project inputs using the server-configured providers. Generation may use paid
        services. Human checkpoints remain required.
      </p>
      <p ref={status} tabIndex={-1} role="status" aria-live="polite">
        {loading
          ? "Loading run status…"
          : run
            ? state + (run.stage ? " · " + run.stage : "")
            : "No browser run recorded"}
      </p>
      {!props.canStart && <p className="notice">Save a research question before starting a run.</p>}
      {value?.provider === "mock" && (
        <p className="notice">
          Demo mode: mock LLM output may contain test fixtures. Verify source links independently.
        </p>
      )}
      {value && (
        <p>
          Provider: <strong>{value.provider}</strong>
        </p>
      )}
      {run?.state === "WAITING_REVIEW" && (
        <p className="notice">
          This run stopped at a human checkpoint. Research decisions are shown below; other stages
          require the interactive CLI; this panel does not automatically resume.
        </p>
      )}
      {run?.state === "RUNNING" && !value?.owned && (
        <p className="notice">
          This server cannot confirm execution ownership. Another server may still be working, or
          the run was interrupted. Stop writers and inspect the run journal and ownership before
          recovery.
        </p>
      )}
      {run?.state === "COMPLETED" && (
        <p>
          Completion does not certify the audit verdict. Refresh materials to inspect the saved
          results.
        </p>
      )}
      {error && (
        <p role="alert" className="notice bad">
          {error}
        </p>
      )}
      {request.current && error && (
        <p>
          The same request will be retried. Refreshing this page loses its request identity; check
          run status before starting again.
        </p>
      )}
      <div className="project-actions">
        <button
          type="button"
          disabled={busy || loading || !value || Boolean(needsAttention) || !props.canStart}
          onClick={() => {
            if (active.current) return
            active.current = true
            setBusy(true)
            setError("")
            request.current ??= { requestId: crypto.randomUUID(), expectedVersion: props.version }
            void props
              .start(request.current)
              .then((next) => {
                if (!mounted.current) return
                setValue((previous) => ({
                  run: next,
                  owned: true,
                  provider: previous?.provider ?? "Server configured",
                }))
                request.current = null
                setRetry((previous) => previous + 1)
              })
              .catch((failure: unknown) => {
                if (mounted.current)
                  setError(failure instanceof Error ? failure.message : "Unable to start run")
              })
              .finally(() => {
                active.current = false
                if (mounted.current) setBusy(false)
              })
          }}
        >
          {busy ? "Starting…" : request.current && error ? "Retry run request" : "Run pipeline"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setLoading(true)
            setRetry((previous) => previous + 1)
          }}
        >
          Check run status
        </button>
        <button type="button" disabled={busy} onClick={props.refresh}>
          Refresh materials
        </button>
      </div>
      {run?.state === "WAITING_REVIEW" && run.stage === "research" && (
        <ResearchReviewPanel
          key={run.id}
          load={props.review}
          decide={props.decide}
          resume={props.resume}
          resumed={(next) => {
            focusContinuation.current = true
            setValue((previous) => ({
              run: next,
              owned: true,
              provider: previous?.provider ?? "Server configured",
            }))
            setRetry((value) => value + 1)
          }}
          changed={() => setRetry((value) => value + 1)}
        />
      )}
      {run && (
        <details>
          <summary>Run log ({run.events.length} events)</summary>
          <ol className="run-log">
            {run.events.map((event, index) => (
              <li key={index}>
                <time>{event.at}</time>
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
export function mountProjectRun(element: HTMLElement, props: Props) {
  const root = createRoot(element)
  root.render(<ProjectRunPanel {...props} />)
  return () => root.unmount()
}
