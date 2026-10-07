import { useRef, useState } from "react"
export type CreateProjectInput = { requestId: string; title: string; question: string }
export function CreateProjectForm({
  create,
  cancel,
}: {
  create: (input: CreateProjectInput) => Promise<void>
  cancel: () => void
}) {
  const [title, setTitle] = useState("")
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [invalid, setInvalid] = useState<"title" | "question" | null>(null)
  const submitted = useRef<CreateProjectInput | null>(null)
  const active = useRef(false)
  const titleInput = useRef<HTMLInputElement>(null)
  const questionInput = useRef<HTMLTextAreaElement>(null)
  return (
    <form
      className="create-project-form"
      aria-labelledby="create-heading"
      aria-busy={busy}
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (active.current) return
        const cleanTitle = title.trim(),
          cleanQuestion = question.trim()
        const field =
          !cleanTitle || cleanTitle.length > 200
            ? "title"
            : !cleanQuestion || cleanQuestion.length > 4000
              ? "question"
              : null
        setInvalid(field)
        if (field) {
          setError(
            field === "title"
              ? "Enter a title (1–200 characters)."
              : "Enter a research question (1–4000 characters).",
          )
          if (field === "title") titleInput.current?.focus()
          else questionInput.current?.focus()
          return
        }
        // Retain identity and submitted values after ambiguous network failures.
        submitted.current ??= {
          requestId: crypto.randomUUID(),
          title: cleanTitle,
          question: cleanQuestion,
        }
        active.current = true
        setBusy(true)
        setError("")
        void create(submitted.current)
          .catch((failure: unknown) => {
            setError(
              failure instanceof Error
                ? failure.message
                : "Project could not be created. Try again.",
            )
          })
          .finally(() => {
            active.current = false
            setBusy(false)
          })
      }}
    >
      <h3 id="create-heading">Start a documentary project</h3>
      <p>Give your film a working title and the question you want to investigate.</p>
      <label htmlFor="create-title">Working title</label>
      <input
        id="create-title"
        ref={titleInput}
        autoFocus
        required
        maxLength={200}
        value={title}
        readOnly={submitted.current !== null}
        disabled={busy}
        aria-invalid={invalid === "title"}
        aria-describedby={invalid === "title" ? "create-error" : undefined}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor="create-question">Research question</label>
      <textarea
        id="create-question"
        ref={questionInput}
        required
        maxLength={4000}
        rows={4}
        value={question}
        readOnly={submitted.current !== null}
        disabled={busy}
        aria-invalid={invalid === "question"}
        aria-describedby={
          invalid === "question" ? "create-question-help create-error" : "create-question-help"
        }
        onChange={(event) => setQuestion(event.target.value)}
      />
      <small id="create-question-help">
        What should the research help you understand? Up to 4,000 characters.
      </small>
      {error && (
        <p id="create-error" className="notice bad" role="alert">
          {error}
        </p>
      )}
      {submitted.current && error && (
        <p>
          Your submitted details are kept for a safe retry. Check the project list before starting
          another request.
        </p>
      )}
      <p className="muted">
        Creates an empty local project. Research and generation start separately in the command-line
        workflow.
      </p>
      {busy && <p role="status">Creating project…</p>}
      <div className="project-actions">
        <button type="submit" disabled={busy}>
          {submitted.current && error ? "Retry creation" : "Create project"}
        </button>
        <button type="button" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
