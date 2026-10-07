import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
export type ProjectDetailsInput = {
  requestId: string
  expectedVersion: string
  title: string
  question: string
}
type Props = {
  title: string
  question: string
  version: string
  questionEditable: boolean
  save: (input: ProjectDetailsInput) => Promise<void>
  reload: () => void
}
export function ProjectDetailsForm(props: Props) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(props.title)
  const [question, setQuestion] = useState(props.question)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [invalid, setInvalid] = useState<"title" | "question" | null>(null)
  const submitted = useRef<ProjectDetailsInput | null>(null)
  const active = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const titleField = useRef<HTMLInputElement>(null)
  const questionField = useRef<HTMLTextAreaElement>(null)
  return (
    <section aria-label="Project details">
      <button
        type="button"
        ref={trigger}
        disabled={busy}
        aria-expanded={editing}
        aria-controls="details-form"
        onClick={() => setEditing(true)}
      >
        Edit project details
      </button>
      {editing && (
        <form
          id="details-form"
          className="create-project-form"
          aria-labelledby="details-heading"
          aria-busy={busy}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (active.current) return
            const cleanTitle = title.trim()
            const cleanQuestion = props.questionEditable ? question.trim() : props.question
            const field =
              !cleanTitle || cleanTitle.length > 200
                ? "title"
                : props.questionEditable && (!cleanQuestion || cleanQuestion.length > 4000)
                  ? "question"
                  : null
            setInvalid(field)
            if (field) {
              setError(
                field === "title"
                  ? "Enter a title (1–200 characters)."
                  : "Enter a research question (1–4000 characters).",
              )
              if (field === "title") titleField.current?.focus()
              else questionField.current?.focus()
              return
            }
            submitted.current ??= {
              requestId: crypto.randomUUID(),
              expectedVersion: props.version,
              title: cleanTitle,
              question: cleanQuestion,
            }
            active.current = true
            setBusy(true)
            setError("")
            void props
              .save(submitted.current)
              .catch((failure: unknown) => {
                setError(
                  failure instanceof Error ? failure.message : "Unable to save project details.",
                )
              })
              .finally(() => {
                active.current = false
                setBusy(false)
              })
          }}
        >
          <h3 id="details-heading">Project details</h3>
          <label htmlFor="details-title">Working title</label>
          <input
            id="details-title"
            ref={titleField}
            autoFocus
            required
            maxLength={200}
            value={title}
            disabled={busy}
            readOnly={submitted.current !== null}
            aria-invalid={invalid === "title"}
            aria-describedby={invalid === "title" ? "details-error" : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor="details-question">Research question</label>
          <textarea
            id="details-question"
            ref={questionField}
            rows={4}
            maxLength={4000}
            value={question}
            disabled={busy}
            readOnly={!props.questionEditable || submitted.current !== null}
            aria-invalid={invalid === "question"}
            aria-describedby={
              invalid === "question" ? "details-help details-error" : "details-help"
            }
            onChange={(event) => setQuestion(event.target.value)}
          />
          <small id="details-help">
            {props.questionEditable
              ? "The question can be changed while this project has no materials."
              : "The research question is fixed once materials exist. Start a new project to investigate a different question."}
          </small>
          <p className="muted">
            The project ID stays the same. Saving details does not regenerate materials.
          </p>
          {error && (
            <p id="details-error" className="notice bad" role="alert">
              {error}
            </p>
          )}
          {submitted.current && error && (
            <p>
              Your submitted draft is kept for a safe retry. Reloading the project discards this
              draft.
            </p>
          )}
          {busy && <p role="status">Saving project details…</p>}
          <div className="project-actions">
            <button type="submit" disabled={busy}>
              {submitted.current && error ? "Retry save" : "Save details"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setTitle(props.title)
                setQuestion(props.question)
                setError("")
                setInvalid(null)
                submitted.current = null
                trigger.current?.focus()
              }}
            >
              Cancel
            </button>
            {error && (
              <button type="button" disabled={busy} onClick={props.reload}>
                Reload project (discard draft)
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  )
}
export function mountProjectDetails(element: HTMLElement, props: Props) {
  const root = createRoot(element)
  root.render(<ProjectDetailsForm {...props} />)
  return () => root.unmount()
}
