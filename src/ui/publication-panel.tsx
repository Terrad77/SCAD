import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  deleteRecovery,
  readRecovery,
  recoveryMatches,
  writeRecovery,
  type Recovery,
} from "./publication-recovery.js"
import type { PublicationDocument, PublicationSource } from "../core/publication.js"
import type { PublicationRequest, PublicationState } from "../application/publication-packages.js"
import type { ProjectExport } from "../application/project-export.js"

type LinkedText = PublicationDocument["summary"]
type Props = {
  projectId: string
  load: () => Promise<PublicationState>
  change: (
    request: PublicationRequest,
  ) => Promise<{ packageId: string; revision: number; replayed: boolean }>
  export: (
    id: string,
    revision: number,
    version: string,
    format: "md" | "json",
  ) => Promise<ProjectExport>
}
function initialDocument(source: PublicationSource): PublicationDocument {
  const narrative = source.snapshot.narrative
  const first = narrative.sections[0]?.sentences[0]?.id
  return {
    audienceQuestion: source.snapshot.reasoningContext.question,
    titles: [
      { text: narrative.title, sentenceIds: first ? [first] : [] },
      { text: "", sentenceIds: [] },
    ],
    summary: { text: narrative.logline, sentenceIds: first ? [first] : [] },
    description: { text: "", sentenceIds: [] },
    thumbnailBrief: { text: "", sentenceIds: [] },
    chapters: narrative.sections.slice(0, 12).map((section) => ({
      text: section.heading,
      sentenceIds: section.sentences.slice(0, 20).map((sentence) => sentence.id),
    })),
  }
}
function LinkedField({
  label,
  value,
  limit,
  source,
  disabled,
  change,
}: {
  label: string
  value: LinkedText
  limit: number
  source: PublicationSource
  disabled: boolean
  change: (next: LinkedText) => void
}) {
  const [query, setQuery] = useState("")
  const sentences = source.snapshot.narrative.sections.flatMap((section) => section.sentences)
  const matches = sentences.filter((sentence) =>
    (sentence.id + " " + sentence.text).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  const visible = [
    ...sentences.filter((sentence) => value.sentenceIds.includes(sentence.id)),
    ...matches.filter((sentence) => !value.sentenceIds.includes(sentence.id)).slice(0, 30),
  ]
  return (
    <fieldset className="publication-field" disabled={disabled}>
      <legend>{label}</legend>
      <label>
        {label} text
        <textarea
          rows={label === "Description" ? 4 : 2}
          maxLength={limit}
          value={value.text}
          onChange={(event) => change({ ...value, text: event.target.value })}
        />
      </label>
      <details>
        <summary>Linked script sentences ({value.sentenceIds.length})</summary>
        <p className="muted">
          Select up to 20 saved sentences. Links locate material; they do not prove semantic
          support.
        </p>
        <label>
          Find a script sentence
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="publication-links">
          {visible.map((sentence) => (
            <label key={sentence.id}>
              <input
                type="checkbox"
                checked={value.sentenceIds.includes(sentence.id)}
                disabled={
                  !value.sentenceIds.includes(sentence.id) && value.sentenceIds.length >= 20
                }
                onChange={(event) =>
                  change({
                    ...value,
                    sentenceIds: event.target.checked
                      ? [...value.sentenceIds, sentence.id]
                      : value.sentenceIds.filter((id) => id !== sentence.id),
                  })
                }
              />
              <span>
                <strong>
                  {sentence.id} · {sentence.knowledge}
                </strong>
                <br />
                {sentence.text}
              </span>
            </label>
          ))}
        </div>
        {!matches.length && <p>No matching sentences.</p>}
        {matches.length > 30 && (
          <p>First 30 matches plus selected sentences shown. Refine the search for more.</p>
        )}
      </details>
      <small>Saved links: {value.sentenceIds.join(", ") || "None selected"}</small>
    </fieldset>
  )
}
export function PublicationPanel(props: Props) {
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [recoveryError, setRecoveryError] = useState("")
  const [state, setState] = useState<PublicationState | null>(null)
  const [packageId, setPackageId] = useState("")
  const [sourceId, setSourceId] = useState("")
  const [document, setDocument] = useState<PublicationDocument | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [reason, setReason] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [exportRevision, setExportRevision] = useState(1)
  const [pendingNavigation, setPendingNavigation] = useState<HTMLElement | null>(null)
  const leaveDialog = useRef<HTMLDialogElement>(null)
  const allowNavigation = useRef(false)
  const baseline = useRef("")
  const ownedRecovery = useRef<string | null>(null)
  const active = useRef(false)
  const alive = useRef(true)
  const request = useRef<PublicationRequest | null>(null)
  const feedback = useRef<HTMLParagraphElement>(null)
  const reasonField = useRef<HTMLTextAreaElement>(null)
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const selected = state?.packages.find((item) => item.packageId === packageId)
  const source = selected?.source ?? state?.sources.find((item) => item.id === sourceId)
  const dirty = !!document && JSON.stringify(document) !== baseline.current
  const disabled = busy || request.current !== null || !!recovery
  const clearRecovery = (force = false) => {
    try {
      const existing = force ? null : readRecovery(window.localStorage, props.projectId)
      if (!force && existing && JSON.stringify(existing) !== ownedRecovery.current) return
      deleteRecovery(window.localStorage, props.projectId)
      ownedRecovery.current = null
      setRecovery(null)
      setRecoveryError("")
    } catch {
      setRecoveryError("Could not delete the local recovery copy. Check browser storage settings.")
    }
  }
  const saveRecovery = (next: PublicationDocument, note: string) => {
    if (!state || !source) return
    try {
      const existing = readRecovery(window.localStorage, props.projectId)
      if (existing && JSON.stringify(existing) !== ownedRecovery.current) {
        setRecoveryError(
          "Another recovery copy exists. Your current edits are not being backed up; save the package or resolve the other copy first.",
        )
        return
      }
      const copy: Recovery = {
        projectVersion: state.projectVersion,
        journalVersion: state.journalVersion,
        packageId,
        revision: selected?.revision ?? null,
        sourceId: source.id,
        proofSignature: source.proofSignature,
        dependencySignature: source.dependencySignature,
        document: next,
        reason: note,
      }
      writeRecovery(window.localStorage, props.projectId, copy)
      ownedRecovery.current = JSON.stringify(copy)
      setRecoveryError("")
    } catch {
      setRecoveryError(
        "Local recovery is unavailable. Save your work as a package; browser storage may be full or blocked.",
      )
    }
  }
  useEffect(() => {
    const dialog = leaveDialog.current
    if (!pendingNavigation || !dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [pendingNavigation])
  useEffect(() => {
    if (!dirty && !reason.trim() && request.current === null && !busy) return
    const hasUnsavedWork = () => dirty || !!reason.trim() || request.current !== null
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork() && !active.current) return
      event.preventDefault()
      event.returnValue = ""
    }
    const beforeNavigation = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      const navigation = event.target.closest(
        "#tabs button, #projects button, #workspace-home, #refresh",
      )
      if (!(navigation instanceof HTMLElement)) return
      if (allowNavigation.current) {
        allowNavigation.current = false
        return
      }
      if (active.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setMessage("Wait for the current package operation to finish before leaving.")
        feedback.current?.focus()
        return
      }
      if (hasUnsavedWork()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setPendingNavigation(navigation)
      }
    }
    window.addEventListener("beforeunload", beforeUnload)
    window.document.addEventListener("click", beforeNavigation, true)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      window.document.removeEventListener("click", beforeNavigation, true)
    }
  }, [dirty, reason, busy])
  const adopt = (next: PublicationState, id?: string) => {
    const item =
      id === undefined ? next.packages.at(-1) : next.packages.find((item) => item.packageId === id)
    const origin = item?.source ?? next.sources[0]
    const draft = item ? structuredClone(item.document) : origin ? initialDocument(origin) : null
    setState(next)
    setPackageId(item?.packageId ?? "")
    setSourceId(origin?.id ?? "")
    setDocument(draft)
    baseline.current = JSON.stringify(draft)
    setExportRevision(item?.revision ?? 1)
    setAcknowledged(false)
    setReason("")
  }
  useEffect(() => {
    alive.current = true
    void props
      .load()
      .then((next) => {
        if (alive.current) {
          adopt(next)
          try {
            setRecovery(readRecovery(window.localStorage, props.projectId))
          } catch {
            setRecoveryError(
              "Local recovery could not be read. Check browser storage or delete the invalid copy.",
            )
          }
        }
      })
      .catch((failure: unknown) => {
        if (alive.current)
          setError(
            failure instanceof Error ? failure.message : "Unable to read publication packages",
          )
      })
      .finally(() => {
        if (alive.current) setBusy(false)
      })
    const timers = downloads.current
    return () => {
      alive.current = false
      for (const [url, timer] of timers) {
        clearTimeout(timer)
        URL.revokeObjectURL(url)
      }
      timers.clear()
    }
  }, [props.load])
  const update = (next: PublicationDocument) => {
    setDocument(next)
    saveRecovery(next, reason)
    setAcknowledged(false)
  }
  const reload = async () => {
    if (active.current) return
    active.current = true
    setBusy(true)
    setError("")
    try {
      const next = await props.load()
      if (alive.current) {
        request.current = null
        clearRecovery()
        adopt(next, packageId || undefined)
        setMessage("Publication packages reloaded; unsaved edits discarded.")
      }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "Unable to reload")
    } finally {
      active.current = false
      if (alive.current) {
        setBusy(false)
        feedback.current?.focus()
      }
    }
  }
  const submit = async (action: "CREATE" | "SAVE" | "APPROVE" | "REJECT") => {
    if (active.current || !state || !document || !source) return
    if (action === "REJECT" && !reason.trim() && !request.current) {
      setError("Enter a reason for rejecting the package.")
      reasonField.current?.focus()
      return
    }
    const common = {
      requestId: crypto.randomUUID(),
      expectedProjectVersion: state.projectVersion,
      expectedJournalVersion: state.journalVersion,
      packageId: packageId || crypto.randomUUID(),
    }
    request.current ??=
      action === "CREATE"
        ? { ...common, action, sourceId: source.id, document }
        : action === "SAVE"
          ? { ...common, action, revision: selected!.revision, document }
          : {
              ...common,
              action,
              revision: selected!.revision,
              artifactSignature: selected!.signature,
              dependencySignature: selected!.source.dependencySignature,
              reason,
            }
    active.current = true
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const result = await props.change(request.current)
      const next = await props.load()
      if (alive.current) {
        request.current = null
        clearRecovery()
        adopt(next, result.packageId)
        setMessage(
          `Package operation recorded for revision ${result.revision}. Check the saved decision and freshness below.`,
        )
      }
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : "Unable to save publication package")
    } finally {
      active.current = false
      if (alive.current) {
        setBusy(false)
        feedback.current?.focus()
      }
    }
  }
  const download = async (format: "md" | "json") => {
    if (active.current || !state || !selected) return
    active.current = true
    setBusy(true)
    setError("")
    try {
      const file = await props.export(
        selected.packageId,
        exportRevision,
        state.journalVersion,
        format,
      )
      if (!alive.current) return
      const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }))
      const link = window.document.createElement("a")
      link.href = url
      link.download = file.filename
      window.document.body.append(link)
      link.click()
      link.remove()
      downloads.current.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url)
          downloads.current.delete(url)
        }, 30000),
      )
      setMessage("Download requested: " + file.filename + ". Check browser downloads.")
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : "Unable to prepare download")
    } finally {
      active.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <section className="publication-editor" aria-labelledby="publication-heading" aria-busy={busy}>
      <dialog
        ref={leaveDialog}
        aria-labelledby="publication-leave-heading"
        aria-describedby="publication-leave-description"
        onCancel={() => setPendingNavigation(null)}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button")
          const first = buttons[0]
          const last = buttons[buttons.length - 1]
          if (event.shiftKey && window.document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && window.document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <h2 id="publication-leave-heading">Leave publication packaging?</h2>
        <p id="publication-leave-description">
          Unsaved text and decision notes will be discarded. An unconfirmed operation may already be
          saved; reopen the package to check its state.
        </p>
        <div className="project-actions">
          <button type="button" autoFocus onClick={() => setPendingNavigation(null)}>
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              const target = pendingNavigation
              setPendingNavigation(null)
              clearRecovery()
              if (target?.isConnected) {
                allowNavigation.current = true
                target.click()
              }
            }}
          >
            Discard edits and leave
          </button>
        </div>
      </dialog>
      <h2 id="publication-heading">Local publication package</h2>
      <p>
        Prepare editorial packaging for a completed production version. This is a local review tool;
        it does not upload to YouTube.
      </p>
      <p ref={feedback} role="status" aria-live="polite" tabIndex={-1}>
        {busy
          ? "Reading or recording publication package…"
          : message ||
            (dirty
              ? "Unsaved edits. Save a new revision before review."
              : "Saved package state loaded.")}
      </p>
      {recoveryError && (
        <div role="alert" className="notice bad">
          <p>{recoveryError}</p>
          <button type="button" onClick={() => clearRecovery(true)}>
            Delete local recovery copy
          </button>
        </div>
      )}
      {recovery &&
        state &&
        (() => {
          const item = recovery.packageId
            ? state.packages.find((p) => p.packageId === recovery.packageId)
            : undefined
          const origin = item?.source ?? state.sources.find((s) => s.id === recovery.sourceId)
          const matches = recoveryMatches(recovery, state)
          return (
            <section className="notice" aria-label="Local recovery copy">
              <h3>Unsaved publication work found</h3>
              <p>
                {matches
                  ? "Restore this browser copy to continue editing. It is not a saved revision or approval."
                  : "The project, package or source has changed. Review and copy the previous text manually; it cannot be restored over the current version."}
              </p>
              {!matches && (
                <textarea
                  aria-label="Previous recovery text"
                  readOnly
                  rows={8}
                  value={JSON.stringify(
                    { document: recovery.document, decisionNote: recovery.reason },
                    null,
                    2,
                  )}
                />
              )}
              {matches && (
                <button
                  type="button"
                  onClick={() => {
                    adopt(state, recovery.packageId)
                    setSourceId(recovery.sourceId)
                    if (!item && origin) baseline.current = JSON.stringify(initialDocument(origin))
                    setDocument(recovery.document)
                    setReason(recovery.reason)
                    ownedRecovery.current = JSON.stringify(recovery)
                    setRecovery(null)
                    setMessage("Recovered local edits. Save a new revision before review.")
                  }}
                >
                  Restore edits
                </button>
              )}
              <button type="button" onClick={() => clearRecovery(true)}>
                Delete recovery copy
              </button>
            </section>
          )
        })()}
      {error && (
        <div role="alert" className="notice bad">
          <p>{error}</p>
          {request.current && (
            <>
              <p>
                Your draft is retained. Retry submits the same operation; reloading discards its
                retry identity and unsaved edits.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void submit(request.current!.action)
                }}
              >
                Retry same package operation
              </button>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        disabled={busy || !!recovery}
        onClick={() => {
          void reload()
        }}
      >
        Reload packages (discard unsaved edits)
      </button>
      {state?.notices.map((notice, index) => (
        <p className="notice" key={index}>
          {notice}
        </p>
      ))}
      {state && (
        <label>
          Saved package
          <select
            value={packageId}
            disabled={disabled || dirty || !!reason.trim()}
            onChange={(event) => adopt(state, event.target.value)}
          >
            <option value="">New draft</option>
            {state.packages.map((item) => (
              <option value={item.packageId} key={item.packageId}>
                {item.document.titles[0]?.text || "Untitled package"} · v{item.revision} ·{" "}
                {item.decision?.action ?? "DRAFT"} · {item.freshness}
              </option>
            ))}
          </select>
        </label>
      )}
      {!selected && state && (
        <label>
          Completed production source
          <select
            disabled={disabled || dirty || !!reason.trim()}
            value={sourceId}
            onChange={(event) => {
              const next = state.sources.find((item) => item.id === event.target.value)
              setSourceId(event.target.value)
              if (next) {
                const draft = initialDocument(next)
                setDocument(draft)
                baseline.current = JSON.stringify(draft)
              }
            }}
          >
            {!state.sources.length && <option value="">No eligible completed source</option>}
            {state.sources.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <p>
          Source: {selected.source.label} · Revision {selected.revision} ·{" "}
          <strong>{selected.freshness}</strong> · Recorded decision:{" "}
          <strong>{selected.decision?.action ?? "DRAFT"}</strong>. Historical consent does not
          override freshness.
        </p>
      )}
      {source && document && (
        <>
          <p className="notice">
            Saved source audit:{" "}
            <strong>{source.snapshot.selfCheck.production?.verdict ?? "UNKNOWN"}</strong>. Packaging
            approval does not change this verdict or resolve uncertainty. Semantic support remains
            UNKNOWN.
          </p>
          <details>
            <summary>Selected source material and audit</summary>
            <p>{source.snapshot.narrative.logline}</p>
            {source.snapshot.narrative.sections.map((section) => (
              <div key={section.id}>
                <h3>{section.heading}</h3>
                {section.sentences.map((sentence) => (
                  <p key={sentence.id}>
                    <strong>
                      {sentence.id} · {sentence.knowledge}
                    </strong>{" "}
                    {sentence.text}
                    <br />
                    <small>
                      Claims: {sentence.claimIds.join(", ") || "None"} · Shots:{" "}
                      {source.snapshot.visual.shots
                        .filter((shot) => shot.narrativeSentenceIds.includes(sentence.id))
                        .map((shot) => shot.id)
                        .join(", ") || "None"}
                    </small>
                  </p>
                ))}
              </div>
            ))}
            <pre>{JSON.stringify(source.snapshot.selfCheck, null, 2)}</pre>
          </details>
          <label>
            Audience question
            <textarea
              disabled={disabled}
              maxLength={500}
              rows={2}
              value={document.audienceQuestion}
              onChange={(event) => update({ ...document, audienceQuestion: event.target.value })}
            />
          </label>
          <h3>Title alternatives</h3>
          {document.titles.map((value, index) => (
            <div key={index}>
              <LinkedField
                label={`Title ${index + 1}`}
                limit={200}
                value={value}
                source={source}
                disabled={disabled}
                change={(next) =>
                  update({
                    ...document,
                    titles: document.titles.map((item, i) => (i === index ? next : item)),
                  })
                }
              />
              {document.titles.length > 1 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    update({ ...document, titles: document.titles.filter((_, i) => i !== index) })
                  }
                >
                  Remove title {index + 1}
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            disabled={disabled || document.titles.length >= 5}
            onClick={() =>
              update({ ...document, titles: [...document.titles, { text: "", sentenceIds: [] }] })
            }
          >
            Add title alternative
          </button>
          {(["summary", "description", "thumbnailBrief"] as const).map((key) => (
            <LinkedField
              key={key}
              label={
                {
                  summary: "Summary",
                  description: "Description",
                  thumbnailBrief: "Thumbnail brief",
                }[key]
              }
              limit={key === "description" ? 6000 : 2000}
              value={document[key]}
              source={source}
              disabled={disabled}
              change={(next) => update({ ...document, [key]: next })}
            />
          ))}
          <h3>Planned segments</h3>
          <p>
            Names and material links only. Final chapter timestamps and subtitles require the
            checked final edit.
          </p>
          {document.chapters.map((value, index) => (
            <div key={index}>
              <LinkedField
                label={`Planned segment ${index + 1}`}
                limit={200}
                value={value}
                source={source}
                disabled={disabled}
                change={(next) =>
                  update({
                    ...document,
                    chapters: document.chapters.map((item, i) => (i === index ? next : item)),
                  })
                }
              />
              {document.chapters.length > 1 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    update({
                      ...document,
                      chapters: document.chapters.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove segment {index + 1}
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            disabled={disabled || document.chapters.length >= 12}
            onClick={() =>
              update({
                ...document,
                chapters: [...document.chapters, { text: "", sentenceIds: [] }],
              })
            }
          >
            Add planned segment
          </button>
          <p>
            Saving creates a new draft revision without carrying over an earlier approval. It never
            changes source materials.
          </p>
          <button
            type="button"
            className="button-primary"
            disabled={disabled || (!!selected && !dirty)}
            onClick={() => {
              void submit(selected ? "SAVE" : "CREATE")
            }}
          >
            {selected ? "Save new package revision" : "Create saved package draft"}
          </button>
        </>
      )}
      {selected && (
        <section aria-labelledby="publication-review-heading">
          <h3 id="publication-review-heading">Saved revision review</h3>
          <p>
            Findings apply to saved revision {selected.revision}. Unsaved editor text is not
            reviewed or approved.
          </p>
          <ul>
            {selected.findings.map((finding, index) => (
              <li key={index}>
                <strong>
                  {finding.status} · {finding.code}
                </strong>
                : {finding.detail}
              </li>
            ))}
          </ul>
          {selected.decision && (
            <p>
              Recorded {selected.decision.action} · {selected.decision.decidedAt} ·{" "}
              {selected.decision.reason}
            </p>
          )}
          {!selected.decision && (
            <>
              <label>
                Decision note (required for rejection)
                <textarea
                  ref={reasonField}
                  disabled={disabled}
                  maxLength={2000}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value)
                    if (document) saveRecovery(document, event.target.value)
                  }}
                />
              </label>
              <label className="publication-consent">
                <input
                  type="checkbox"
                  disabled={disabled || dirty}
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I reviewed the saved packaging text, material links and UNKNOWN findings. This
                consent does not certify claims or authorize upload.
              </label>
              <div className="project-actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={
                    disabled ||
                    dirty ||
                    !acknowledged ||
                    selected.freshness !== "CURRENT" ||
                    selected.findings.some((item) => item.status === "FAIL")
                  }
                  onClick={() => {
                    void submit("APPROVE")
                  }}
                >
                  Approve saved package
                </button>
                <button
                  type="button"
                  disabled={disabled || dirty}
                  onClick={() => {
                    void submit("REJECT")
                  }}
                >
                  Reject saved package
                </button>
              </div>
            </>
          )}
          <h3>Local export</h3>
          <p>
            Draft, rejected or stale copies retain explicit review qualifications. No upload is
            performed.
          </p>
          <label>
            Saved package revision
            <select
              value={exportRevision}
              disabled={disabled || dirty}
              onChange={(event) => setExportRevision(Number(event.target.value))}
            >
              {state?.history
                .filter((item) => item.packageId === selected.packageId)
                .map((item) => (
                  <option value={item.revision} key={item.revision}>
                    Revision {item.revision} · {item.decision?.action ?? "DRAFT"}
                  </option>
                ))}
            </select>
          </label>
          <div className="project-actions">
            <button
              type="button"
              disabled={disabled || dirty}
              onClick={() => {
                void download("md")
              }}
            >
              Download package (.md)
            </button>
            <button
              type="button"
              disabled={disabled || dirty}
              onClick={() => {
                void download("json")
              }}
            >
              Download package (.json)
            </button>
          </div>
          <details>
            <summary>Package identity and saved versions</summary>
            <p>
              Content: <code>{selected.signature}</code>
            </p>
            <p>
              Dependencies: <code>{selected.source.dependencySignature}</code>
            </p>
            {state?.history
              .filter((item) => item.packageId === selected.packageId)
              .map((item) => (
                <p key={item.revision}>
                  Revision {item.revision} · {item.savedAt} · {item.decision?.action ?? "DRAFT"}
                </p>
              ))}
          </details>
        </section>
      )}
    </section>
  )
}
export function mountPublication(element: HTMLElement, props: Props) {
  const root = createRoot(element)
  root.render(<PublicationPanel {...props} />)
  return () => root.unmount()
}
