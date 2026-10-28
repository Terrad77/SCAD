import { useEffect, useRef, useState } from "react"
import type { PublicationComparison } from "../application/publication-packages.js"

export type LoadPublicationComparison = (
  id: string,
  from: number,
  to: number,
  version: string,
) => Promise<PublicationComparison>

export function PublicationComparisonPanel({
  id,
  version,
  revisions,
  disabled,
  load,
}: {
  id: string
  version: string
  revisions: number[]
  disabled: boolean
  load: LoadPublicationComparison
}) {
  const [from, setFrom] = useState(revisions.at(-2) ?? revisions[0] ?? 1)
  const [to, setTo] = useState(revisions.at(-1) ?? 1)
  const [result, setResult] = useState<PublicationComparison | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [changesOnly, setChangesOnly] = useState(true)
  const alive = useRef(true)
  const active = useRef(false)
  const feedback = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const compare = async () => {
    if (active.current || disabled) return
    active.current = true
    setBusy(true)
    setError("")
    setResult(null)
    try {
      const value = await load(id, from, to, version)
      if (alive.current) setResult(value)
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : "Unable to compare saved revisions")
    } finally {
      active.current = false
      if (alive.current) {
        setBusy(false)
        feedback.current?.focus()
      }
    }
  }
  const changed = result?.fields.filter((field) => field.status !== "UNCHANGED").length ?? 0
  return (
    <section
      className="publication-comparison"
      aria-labelledby="publication-comparison-heading"
      aria-busy={busy}
    >
      <h3 id="publication-comparison-heading">Compare saved revisions</h3>
      <p>
        Compare saved text and script links. Titles and planned segments are matched by position;
        this is not a semantic review. Unsaved edits are excluded.
      </p>
      {revisions.length < 2 ? (
        <p>Save a second package revision to compare changes.</p>
      ) : (
        <>
          <div className="publication-compare-grid">
            <label>
              From revision
              <select
                value={from}
                disabled={disabled || busy}
                onChange={(event) => {
                  setFrom(Number(event.target.value))
                  setResult(null)
                }}
              >
                {revisions.map((revision) => (
                  <option value={revision} key={revision}>
                    Revision {revision}
                  </option>
                ))}
              </select>
            </label>
            <label>
              To revision
              <select
                value={to}
                disabled={disabled || busy}
                onChange={(event) => {
                  setTo(Number(event.target.value))
                  setResult(null)
                }}
              >
                {revisions.map((revision) => (
                  <option value={revision} key={revision}>
                    Revision {revision}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            disabled={disabled || busy || from === to}
            onClick={() => {
              void compare()
            }}
          >
            Compare saved revisions
          </button>
          <p ref={feedback} role="status" aria-live="polite" tabIndex={-1}>
            {busy
              ? "Reading saved comparison…"
              : result
                ? `${changed} changed field(s) in saved revisions ${result.before.revision} → ${result.after.revision}.`
                : "Choose two saved revisions."}
          </p>
          {error && (
            <div className="notice bad" role="alert">
              <p>{error}</p>
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => {
                  void compare()
                }}
              >
                Retry comparison
              </button>
            </div>
          )}
          {result && (
            <>
              <p className="notice">
                Semantic support remains UNKNOWN. An unchanged field does not imply factual support.
                A historical APPROVE does not authorize the latest revision.
              </p>
              <div className="publication-compare-grid">
                {(["before", "after"] as const).map((side) => {
                  const item = result[side]
                  return (
                    <section
                      key={side}
                      aria-label={`${side === "before" ? "From" : "To"} saved revision`}
                    >
                      <h4>
                        {side === "before" ? "From" : "To"}: revision {item.revision}
                      </h4>
                      <p>
                        Saved: {item.savedAt}
                        <br />
                        Freshness: <strong>{item.freshness}</strong>
                        <br />
                        Source audit: <strong>{item.sourceAudit}</strong>
                        <br />
                        Recorded decision: <strong>{item.decision?.action ?? "DRAFT"}</strong>
                        <br />
                        Currently approved: <strong>{item.currentlyApproved ? "Yes" : "No"}</strong>
                      </p>
                      {item.decision && <p>Decision note: {item.decision.reason || "No note"}</p>}
                      <details>
                        <summary>Source, identity and saved findings</summary>
                        <p>{item.source.label}</p>
                        <p>
                          Content: <code>{item.signature}</code>
                        </p>
                        <p>
                          Dependencies: <code>{item.source.dependencySignature}</code>
                        </p>
                        <ul>
                          {item.findings.map((finding, index) => (
                            <li key={index}>
                              {finding.status} · {finding.code}: {finding.detail}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </section>
                  )
                })}
              </div>
              <label className="publication-consent">
                <input
                  type="checkbox"
                  checked={changesOnly}
                  onChange={(event) => setChangesOnly(event.target.checked)}
                />
                Show changed fields only
              </label>
              {!changed && (
                <p>
                  No saved text or script-link changes. Decisions and freshness are shown separately
                  above.
                </p>
              )}
              {result.fields
                .filter((field) => !changesOnly || field.status !== "UNCHANGED")
                .map((field) => (
                  <details key={field.label}>
                    <summary>
                      {field.label} · {field.status}
                      {field.textChanged ? " · Text changed" : ""}
                      {field.linksChanged ? " · Links changed" : ""}
                    </summary>
                    <div className="publication-compare-grid">
                      {(["before", "after"] as const).map((side) => (
                        <section key={side} aria-label={`${field.label} ${side}`}>
                          <h4>
                            {side === "before" ? "From" : "To"}: revision {result[side].revision}
                          </h4>
                          <p className="publication-compare-text">
                            {field[side]?.text ?? "Field not present"}
                          </p>
                          <p>Script links: {field[side]?.sentenceIds.join(", ") || "None"}</p>
                        </section>
                      ))}
                    </div>
                  </details>
                ))}
            </>
          )}
        </>
      )}
    </section>
  )
}
