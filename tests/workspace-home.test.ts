import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { WorkspaceHome, type WorkspaceState } from "../src/ui/workspace-home.js"
const render = (state: WorkspaceState) =>
  renderToStaticMarkup(createElement(WorkspaceHome, { state, open: () => {}, retry: () => {} }))
describe("workspace feedback", () => {
  it("announces loading without displaying invented projects", () => {
    const html = render({ kind: "loading" })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('role="status"')
    expect(html).not.toContain("Open project")
  })
  it("offers recovery and escapes error content", () => {
    const html = render({ kind: "error", message: "<script>error</script>" })
    expect(html).toContain('role="alert"')
    expect(html).toContain("Try again")
    expect(html).not.toContain("<script>")
  })
  it("explains empty real data and keeps refresh available", () => {
    const html = render({ kind: "ready", projects: [] })
    expect(html).toContain("first project")
    expect(html).toContain("Refresh projects")
    expect(html).not.toContain("Open project")
  })
  it("renders real project content with safe labels and a visible search label", () => {
    const html = render({
      kind: "ready",
      projects: [{ id: "p", title: "<b>Title</b>", question: "Question", status: "unknown" }],
    })
    expect(html).toContain("&lt;b&gt;Title&lt;/b&gt;")
    expect(html).toContain("Question")
    expect(html).toContain("Find a project")
    expect(html).toContain("Project ID:")
    expect(html).not.toContain("<b>Title</b>")
  })
})
