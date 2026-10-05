import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
export type WorkspaceProject = { id: string; title: string; question: string; status: string }
export type WorkspaceState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: WorkspaceProject[] }
export function WorkspaceHome({
  state,
  open,
  retry,
  trash = [],
  remove,
  restore,
}: {
  state: WorkspaceState
  open: (id: string) => void
  retry: () => void
  trash?: Array<{ id: string; project: string }>
  remove?: (id: string) => Promise<void>
  restore?: (id: string) => Promise<void>
}) {
  const [query, setQuery] = useState("")
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState("")
  const act = async (callback: (id: string) => Promise<void>, id: string) => {
    if (busy) return
    setBusy(true)
    setActionError("")
    try {
      await callback(id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Project operation failed")
    } finally {
      setBusy(false)
    }
  }
  const searchInput = useRef<HTMLInputElement>(null)
  if (state.kind === "loading")
    return (
      <section aria-busy="true" aria-label="Projects">
        <p role="status">Reading your local projects…</p>
        <div className="home-placeholder" aria-hidden="true" />
      </section>
    )
  if (state.kind === "error")
    return (
      <section className="home-feedback" aria-labelledby="home-error">
        <h2 id="home-error">Projects could not be loaded</h2>
        <p role="alert">{state.message}</p>
        <button type="button" onClick={retry}>
          Try again
        </button>
        <p className="muted">
          Check that the local viewer is running. Your project files have not changed.
        </p>
      </section>
    )
  const matches = state.projects.filter((p) =>
    `${p.title} ${p.id} ${p.question}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <div className="home-dashboard">
      {actionError && (
        <p className="notice bad" role="alert">
          {actionError}
        </p>
      )}
      {busy && <p role="status">Updating project…</p>}
      <section className="home-intro" aria-labelledby="home-intro-title">
        <h2 id="home-intro-title">Your documentary workspace</h2>
        <p>Return to the research, follow the evidence, and inspect your production materials.</p>
        <p className="home-context">
          Local workspace · {state.projects.length} saved{" "}
          {state.projects.length === 1 ? "project" : "projects"} · Material inspection
        </p>
      </section>
      <section aria-labelledby="home-projects">
        <div className="home-section-heading">
          <h2 id="home-projects">Projects</h2>
          <label className="home-search">
            Find a project
            <input
              type="search"
              ref={searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Title, question or ID"
            />
          </label>
        </div>
        <p className="muted" role="status">
          {matches.length} {matches.length === 1 ? "project" : "projects"} shown
        </p>
        {!state.projects.length ? (
          <div className="home-feedback">
            <h3>Your workspace is ready for its first project</h3>
            <p>Create a project with the SCAD command-line tool, then refresh this workspace.</p>
            <button type="button" onClick={retry}>
              Refresh projects
            </button>
          </div>
        ) : !matches.length ? (
          <div className="home-feedback">
            <h3>No matching projects</h3>
            <p>Try a shorter title or a different keyword.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("")
                searchInput.current?.focus()
              }}
            >
              Clear search
            </button>
          </div>
        ) : (
          <ul className="home-project-list">
            {matches.map((p) => (
              <li key={p.id}>
                <article>
                  <div>
                    <h3>{p.title || p.id}</h3>
                    <p>{p.question || "No project question saved"}</p>
                    <small>Project ID: {p.id}</small>
                  </div>
                  <div className="project-actions">
                    <button
                      disabled={busy}
                      type="button"
                      aria-label={`Open ${p.title || p.id}`}
                      onClick={() => open(p.id)}
                    >
                      Open project <span aria-hidden="true">→</span>
                    </button>
                    {remove && (
                      <button
                        type="button"
                        className="delete-project"
                        disabled={busy}
                        aria-label={`Delete ${p.title || p.id}`}
                        onClick={() => {
                          setPendingDelete(p.id)
                          setStopped(false)
                        }}
                      >
                        Delete project
                      </button>
                    )}
                  </div>
                </article>
                {pendingDelete === p.id && remove && (
                  <section
                    className="delete-confirmation"
                    aria-label={`Confirm deletion of ${p.id}`}
                  >
                    <h3>Move {p.title || p.id} to Trash?</h3>
                    <p>
                      All project files will leave this workspace. You can return them with Restore
                      project in Trash.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={stopped}
                        onChange={(e) => setStopped(e.target.checked)}
                      />{" "}
                      No SCAD command is running for this project
                    </label>
                    <div className="project-actions">
                      <button
                        type="button"
                        disabled={busy || !stopped}
                        onClick={() => {
                          void act(remove, p.id)
                        }}
                      >
                        Move to Trash
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setPendingDelete(null)
                          searchInput.current?.focus()
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </section>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {trash.length > 0 && (
        <section aria-labelledby="trash-heading">
          <h2 id="trash-heading">Trash</h2>
          <p className="muted">
            Deleted projects are kept here until restored. Files are not permanently erased.
          </p>
          <ul className="trash-list">
            {trash.map((item) => (
              <li key={item.id}>
                <span>{item.project}</span>
                {restore && (
                  <button
                    disabled={busy}
                    type="button"
                    aria-label={`Restore ${item.project}`}
                    onClick={() => {
                      void act(restore, item.id)
                    }}
                  >
                    Restore project
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <aside className="home-note" aria-labelledby="home-access">
        <h2 id="home-access">A local place to inspect your work</h2>
        <p>
          Browse scripts, shots, audit findings and evidence Flow. Generation and approvals remain
          in the SCAD command-line workflow. This viewer does not use a signed-in account.
        </p>
      </aside>
    </div>
  )
}
export function mountWorkspaceHome(
  element: HTMLElement,
  state: WorkspaceState,
  open: (id: string) => void,
  retry: () => void,
  trash: Array<{ id: string; project: string }> = [],
  remove?: (id: string) => Promise<void>,
  restore?: (id: string) => Promise<void>,
) {
  const root = createRoot(element)
  root.render(
    <WorkspaceHome
      state={state}
      open={open}
      retry={retry}
      trash={trash}
      remove={remove}
      restore={restore}
    />,
  )
  return () => root.unmount()
}
