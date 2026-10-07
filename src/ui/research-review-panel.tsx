import { useEffect, useRef, useState } from "react"
import type { ResearchReview, ReviewRequest } from "../application/project-reviews.js"
type Props = {
  load: () => Promise<ResearchReview>
  decide: (input: ReviewRequest) => Promise<NonNullable<ResearchReview["decision"]>>
  changed: () => void
}
function sourceLink(url: string | undefined) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}
export function ResearchReviewPanel(props: Props) {
  const [review, setReview] = useState<ResearchReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [reason, setReason] = useState("")
  const [invalid, setInvalid] = useState(false)
  const [reload, setReload] = useState(0)
  const request = useRef<ReviewRequest | null>(null)
  const active = useRef(false)
  const alive = useRef(true)
  const reasonField = useRef<HTMLTextAreaElement>(null)
  const feedback = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    alive.current = true
    let cancelled = false
    setLoading(true)
    void props
      .load()
      .then((next) => {
        if (!cancelled) {
          setReview(next)
          setError("")
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : "Unable to load Research checkpoint",
          )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      alive.current = false
    }
  }, [props.load, reload])
  const decide = (action: ReviewRequest["action"]) => {
    if (active.current || !review) return
    if (!request.current && action === "REJECT" && !reason.trim()) {
      setInvalid(true)
      setError("Enter a reason for rejecting this candidate.")
      reasonField.current?.focus()
      return
    }
    request.current ??= {
      requestId: crypto.randomUUID(),
      runId: review.runId,
      expectedVersion: review.version,
      artifactSignature: review.artifactSignature,
      dependencySignature: review.dependencySignature,
      action,
      reason: reason.trim(),
    }
    active.current = true
    setBusy(true)
    setInvalid(false)
    setError("")
    void props
      .decide(request.current)
      .then((decision) => {
        if (!alive.current) return
        setReview((previous) =>
          previous
            ? {
                ...previous,
                decision,
                explanation:
                  "Decision recorded for the checkpoint identity below; execution remains stopped.",
                decidable: false,
                current: false,
              }
            : previous,
        )
        request.current = null
        props.changed()
        feedback.current?.focus()
      })
      .catch((failure: unknown) => {
        if (alive.current)
          setError(failure instanceof Error ? failure.message : "Unable to record decision")
      })
      .finally(() => {
        active.current = false
        if (alive.current) setBusy(false)
      })
  }
  return (
    <section
      className="research-review"
      aria-labelledby="review-heading"
      aria-busy={loading || busy}
    >
      <h3 id="review-heading">Research review</h3>
      {loading && <p role="status">Loading saved candidate…</p>}
      {error && (
        <p id="review-error" className="notice bad" role="alert">
          {error}
        </p>
      )}
      {review && (
        <>
          <p ref={feedback} tabIndex={-1} role="status">
            {review.decision
              ? `Recorded decision: Research ${review.decision.action === "APPROVE" ? "approved" : "rejected"}. Execution remains stopped.`
              : review.explanation}
          </p>
          {review.decision && <p>{review.explanation}</p>}
          {review.decision?.reason && <p>Decision note: {review.decision.reason}</p>}
          <h4>{review.artifact.question}</h4>
          <p>{review.artifact.summary}</p>
          <p>
            {review.artifact.sources.length} sources · {review.artifact.evidence.length} evidence
            items · {review.artifact.claims.length} claims · {review.artifact.gaps.length} research
            gaps
          </p>
          <details>
            <summary>Sources and evidence</summary>
            <ul>
              {review.artifact.sources.map((source) => {
                const href = sourceLink(source.url)
                return (
                  <li key={source.id}>
                    <strong>
                      {source.id} · {source.title}
                    </strong>
                    {href && (
                      <p>
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          Open source
                        </a>
                      </p>
                    )}
                    {source.author && <p>{source.author}</p>}
                    {source.notes && <p>{source.notes}</p>}
                  </li>
                )
              })}
            </ul>
            <ul>
              {review.artifact.evidence.map((evidence) => (
                <li key={evidence.id}>
                  <strong>
                    {evidence.id} · Source: {evidence.sourceId}
                  </strong>
                  <p>{evidence.statement}</p>
                  {evidence.excerpt && <blockquote>{evidence.excerpt}</blockquote>}
                  <p>
                    Supports: {evidence.supportsClaims.join(", ") || "None"} · Contradicts:{" "}
                    {evidence.contradictsClaims.join(", ") || "None"}
                  </p>
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Full saved candidate, claims and gaps</summary>
            <pre>{JSON.stringify(review.artifact, null, 2)}</pre>
          </details>
          <details>
            <summary>Checkpoint identity and dependencies</summary>
            <p>
              Research has no upstream pipeline artifacts. Project inputs and the reviewed snapshot
              are checked at decision time.
            </p>
            <p>
              Displayed candidate: <code>{review.artifactSignature}</code>
            </p>
            <p>
              Dependencies: <code>{review.dependencySignature}</code>
            </p>
            <p>
              Recorded checkpoint candidate:{" "}
              <code>{review.checkpointArtifactSignature ?? "Unavailable"}</code>
            </p>
            <p>
              Snapshot: <code>{review.version}</code>
            </p>
          </details>
          {review.decidable && (
            <>
              <label htmlFor="review-reason">Decision note (required for rejection)</label>
              <textarea
                id="review-reason"
                ref={reasonField}
                rows={3}
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
                readOnly={request.current !== null}
                aria-invalid={invalid}
                aria-describedby={invalid ? "review-error" : undefined}
              />
              <p>
                Approve records your human consent to this candidate. It does not certify every
                claim or start the next stage. Reject keeps the candidate and your reason for
                history.
              </p>
              <div className="project-actions">
                {request.current && error ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => decide(request.current!.action)}
                  >
                    Retry same decision
                  </button>
                ) : (
                  <>
                    <button type="button" disabled={busy} onClick={() => decide("APPROVE")}>
                      Approve Research
                    </button>
                    <button type="button" disabled={busy} onClick={() => decide("REJECT")}>
                      Reject Research
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {busy && <p role="status">Recording decision…</p>}
        </>
      )}
      {error && !busy && (
        <button
          type="button"
          onClick={() => {
            request.current = null
            setReason("")
            setReview(null)
            setInvalid(false)
            setReload((value) => value + 1)
          }}
        >
          Reload checkpoint (discard draft)
        </button>
      )}
    </section>
  )
}
