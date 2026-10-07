import { mountProjectRun } from "./project-run-panel.js"
import { mountProjectDetails } from "./project-details-form.js"
import type { CreateProjectInput } from "./create-project-form.js"
import { mountWorkspaceHome, type WorkspaceState } from "./workspace-home.js"
import { mountFlow } from "./flow/canvas.js"
import type { ProjectView, TraceGraph, TraceNode } from "../application/project-reader.js"

type Project = { id: string; title: string; question: string; status: string }
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const projectsBox = get("projects"),
  heading = get("heading"),
  content = get("content"),
  tabs = get("tabs"),
  traceBox = get("trace"),
  layout = get("layout"),
  statusBox = get("status")
const refresh = get<HTMLButtonElement>("refresh"),
  search = get<HTMLInputElement>("project-search")
const token = document.querySelector<HTMLMetaElement>('meta[name="scad-session"]')!.content
let projects: Project[] = [],
  view: ProjectView | null = null,
  tab = "overview",
  selection: string | null = null,
  generation = 0,
  traceGeneration = 0
let crumbs: string[] = [],
  issueSeverity = "all",
  issueStatus = "all",
  issueFreshness = "all"
let disposeRun: (() => void) | null = null
let disposeDetails: (() => void) | null = null
let disposeHome: (() => void) | null = null
let projectListTicket = 0
let trashItems: Array<{ id: string; project: string }> = []
let disposeFlow: (() => void) | null = null
let flowGeneration = 0
let flowSubject: string | null = null
const labels: Record<string, string> = {
  production: "Production",
  EPISTEMIC_INTEGRITY: "Epistemic integrity",
  TRACEABILITY: "Traceability",
  UNSUPPORTED_STATEMENTS: "Unsupported statements",
  UNCERTAINTY_PRESERVATION: "Uncertainty preservation",
  CONTRADICTION_PRESERVATION: "Contradiction preservation",
  HYPOTHESIS_INTEGRITY: "Hypothesis integrity",
  SCOPE_COMPLIANCE: "Write scope compliance",
  "epistemic-integrity": "Epistemic integrity finding",
  "uncertainty-loss": "Uncertainty loss",
  "contradiction-loss": "Contradiction loss",
  unverifiable: "Unverifiable",
  "not-applicable": "Not applicable",
  critical: "Critical",
  warning: "Warning",
  info: "Info",
  PASS: "Pass",
  FAIL: "Fail",
  WARN: "Warning",
  FACT: "Fact",
  SCIENTIFIC_HYPOTHESIS: "Scientific hypothesis",
  INTERPRETATION: "Interpretation",
  SPECULATION: "Speculation",
  INFOGRAPHIC: "Infographic",
  AI_RECONSTRUCTION: "AI reconstruction",
  ABSTRACT: "Abstract",
  ARCHIVE: "Archive",
  sentence: "Sentence",
  shot: "Shot",
  claim: "Claim",
  evidence: "Evidence",
  source: "Source",
  reference: "Reference",
  hypothesis: "Hypothesis",
  uncertainty: "Uncertainty",
  constraint: "Constraint",
  "claim-reference": "Claim reference",
  "associated-shot": "Associated shot",
  narration: "Sentence",
  "evidence-reference": "Evidence reference",
  "declared-source": "Declared source",
  "declared-hypothesis": "Declared hypothesis",
  "declared-uncertainty": "Declared uncertainty",
  "declared-contradiction": "Declared contradiction",
  "declared-treatment": "Declared constraint treatment",
  research: "Research",
  reasoning: "Reasoning",
  narrative: "Script",
  visual: "Shots",
  selfCheck: "Audit",
  reasoningContext: "Reasoning context",
  VALID: "Loaded",
  MISSING: "Missing",
  CORRUPT: "Validation failed",
  UNREADABLE: "Unavailable",
  UNAVAILABLE: "Unavailable",
  CURRENT: "Current",
  STALE: "Historical snapshot",
  UNKNOWN: "Unknown",
  UNVERIFIABLE: "Unverified",
  OPEN: "Open",
  AWAITING_VERIFICATION: "Awaiting verification",
  DEFERRED: "Deferred",
  DISMISSED: "Dismissed by author",
  RESOLVED: "Resolved on verified snapshot",
  FOUND: "Reference found",
  AMBIGUOUS: "Ambiguous reference",
  DRAFT: "Draft",
  PUBLISHING: "Publication incomplete",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  IDLE: "No pending revision",
  MATCH: "Content checks match",
  MISMATCH: "Content audits differ",
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const el = document.createElement(tag)
  if (text !== undefined) el.textContent = text
  if (cls) el.className = cls
  return el
}
function button(text: string, action: () => void, cls?: string) {
  const el = element("button", text, cls)
  el.type = "button"
  el.addEventListener("click", action)
  return el
}
function badge(value: string) {
  const el = element("span", labels[value] ?? value, "badge")
  if (
    ["FAIL", "CORRUPT", "UNREADABLE", "MISSING", "AMBIGUOUS", "MISMATCH", "critical"].includes(
      value,
    )
  )
    el.classList.add("bad")
  else if (["WARN", "UNKNOWN", "STALE", "UNVERIFIABLE", "warning", "PUBLISHING"].includes(value))
    el.classList.add("warn")
  return el
}
function message(text: string, bad = false) {
  return element("p", text, `notice${bad ? " bad" : ""}`)
}
function idLink(id: string) {
  return button(
    id,
    () => {
      void openTrace(id)
    },
    "pill-link",
  )
}
function setStatus(text: string, error = false) {
  statusBox.textContent = text
  statusBox.classList.toggle("error", error)
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? "Read error")
  return value as T
}
function renderProjects() {
  projectsBox.replaceChildren()
  const filter = search.value.toLocaleLowerCase()
  const visible = projects.filter((p) =>
    `${p.title} ${p.question} ${p.id}`.toLocaleLowerCase().includes(filter),
  )
  for (const project of visible) {
    const item = button(
      "",
      () => {
        void openProject(project.id)
      },
      `project-link${view?.id === project.id ? " selected" : ""}`,
    )
    item.append(element("span", project.title || project.id), element("small", project.id))
    if (project.status !== "VALID") item.append(badge(project.status))
    projectsBox.append(item)
  }
  if (!visible.length)
    projectsBox.append(
      element(
        "p",
        projects.length ? "No projects match your search." : "No projects yet.",
        "muted",
      ),
    )
}
function closeTrace() {
  traceGeneration++
  traceBox.hidden = true
  traceBox.replaceChildren()
  layout.classList.remove("tracing")
  selection = null
  crumbs = []
}
async function openProject(id: string) {
  projectListTicket++
  disposeRun?.()
  disposeRun = null
  disposeDetails?.()
  disposeDetails = null
  disposeHome?.()
  disposeHome = null
  const ticket = ++generation
  disposeFlow?.()
  disposeFlow = null
  flowGeneration++
  flowSubject = null
  closeTrace()
  refresh.disabled = true
  setStatus("Reading project files…")
  view = null
  heading.replaceChildren(element("h1", "Loading project"))
  tabs.replaceChildren()
  content.replaceChildren()
  try {
    const result = await api<ProjectView>(`/api/projects/${encodeURIComponent(id)}`)
    if (ticket !== generation) return
    view = result
    renderProjects()
    render()
    setStatus("Snapshot loaded")
  } catch (error) {
    if (ticket === generation) {
      heading.replaceChildren(element("h1", "Project is unavailable"))
      content.replaceChildren(
        button("Try again", () => {
          void openProject(id)
        }),
        button("Back to workspace", () => {
          void loadProjects()
        }),
      )
      setStatus(error instanceof Error ? error.message : "Read error", true)
    }
  } finally {
    if (ticket === generation) refresh.disabled = false
  }
}
function render() {
  if (!view) return
  disposeRun?.()
  disposeRun = null
  disposeDetails?.()
  disposeDetails = null
  disposeFlow?.()
  disposeFlow = null
  flowGeneration++
  heading.replaceChildren(
    element("h1", view.meta?.title || view.id),
    element("p", view.meta?.question || "No project question saved", "muted"),
  )
  tabs.replaceChildren()
  for (const [id, label] of [
    ["overview", "Overview"],
    ["narrative", "Script"],
    ["shots", "Shots"],
    ["audit", "Audit and issues"],
    ["history", "History"],
    ["flow", "Flow"],
  ])
    tabs.append(
      button(
        label!,
        () => {
          tab = id!
          render()
        },
        tab === id ? "selected" : undefined,
      ),
    )
  for (const control of tabs.querySelectorAll("button")) {
    if (control.classList.contains("selected")) control.setAttribute("aria-current", "page")
  }
  content.replaceChildren()
  const sectionCopy: Record<string, [string, string]> = {
    overview: [
      "Project overview",
      "Inspect saved materials and their current verification status.",
    ],
    narrative: ["Script", "Read the saved story and follow each sentence back to its claims."],
    shots: ["Shot list", "Inspect visual treatments alongside their narration and evidence links."],
    audit: [
      "Audit and issues",
      "Review saved findings. A disposition does not certify that an issue is resolved.",
    ],
    history: [
      "Production history",
      "Compare saved revisions and inspect the decisions behind them.",
    ],
    flow: [
      "Evidence Flow",
      "Explore the connections between shots, sentences, claims and sources.",
    ],
  }
  const section = sectionCopy[tab]
  content.className = "project-content section-" + tab
  if (section) {
    const intro = element("header", undefined, "section-intro")
    intro.append(element("h2", section[0]), element("p", section[1], "muted"))
    content.append(intro)
  }
  if (view.production.notice) content.append(message(view.production.notice, true))
  if (tab === "overview") overview()
  if (tab === "narrative") narrative()
  if (tab === "shots") shots()
  if (tab === "audit") audit()
  if (tab === "history") history()
  if (tab === "flow") flow()
}
function overview() {
  if (!view) return
  const currentRunProject = view
  const runPanel = element("div")
  content.append(runPanel)
  disposeRun = mountProjectRun(runPanel, {
    review: () => api("/api/projects/" + encodeURIComponent(currentRunProject.id) + "/review"),
    decide: (input) =>
      api("/api/projects/" + encodeURIComponent(currentRunProject.id) + "/review", "POST", input),
    version: currentRunProject.readVersion,
    canStart: Boolean(currentRunProject.meta?.question.trim()),
    load: () => api("/api/projects/" + encodeURIComponent(currentRunProject.id) + "/runs"),
    start: (input) =>
      api("/api/projects/" + encodeURIComponent(currentRunProject.id) + "/runs", "POST", input),
    refresh: () => {
      if (view === currentRunProject) void openProject(currentRunProject.id)
    },
  })
  const grid = element("div", undefined, "summary-grid")
  const freshness = !view.production.freshness
    ? "Unverified"
    : view.production.freshness.artifacts.every((a) => a.status === "CURRENT")
      ? "Current"
      : "Some files are stale"
  for (const [label, value] of [
    ["Production freshness", freshness],
    [
      "Saved audit result",
      labels[view.selfCheck?.production?.verdict ?? ""] ?? "No production audit",
    ],
    ["Publication", labels[view.production.publication] ?? view.production.publication],
  ]) {
    const item = element("div", undefined, "summary-item")
    item.append(element("small", label), element("strong", value))
    grid.append(item)
  }
  content.append(
    grid,
    message(
      "Freshness, audit results and issue dispositions are separate. A completed revision does not confirm that all issues are resolved.",
    ),
  )
  if (view.reasoning.latestCycle) {
    content.append(element("h2", "Latest reasoning cycle"))
    const cycle = view.reasoning.latestCycle
    content.append(
      element("p", `${cycle.cycleId} · ${cycle.status} · ${cycle.trigger}`),
      element("p", cycle.stopping?.reason ?? "No stopping reason recorded", "muted"),
    )
  }
  if (view.meta) {
    const current = view
    const editor = element("div", undefined, "project-details")
    content.append(editor)
    disposeDetails = mountProjectDetails(editor, {
      title: current.meta!.title,
      question: current.meta!.question,
      version: current.readVersion,
      questionEditable: current.questionEditable,
      save: async (input) => {
        await api("/api/projects/" + encodeURIComponent(current.id) + "/settings", "POST", input)
        if (view !== current) return
        projects = projects.map((project) =>
          project.id === current.id
            ? { ...project, title: input.title, question: input.question }
            : project,
        )
        await openProject(current.id)
        setStatus("Project details saved")
        content.focus()
      },
      reload: () => {
        void openProject(current.id)
      },
    })
  }
  content.append(element("h2", "Saved artifacts"))
  for (const [key, file] of Object.entries(view.files)) {
    const row = element("div", undefined, "row file-row")
    row.append(element("code", key), badge(file.status))
    if (file.reason) row.append(element("small", file.reason))
    content.append(row)
  }
  for (const artifact of view.production.freshness?.artifacts ?? []) {
    const row = element("div", undefined, "row")
    row.append(
      element("strong", artifact.artifact),
      badge(artifact.status),
      element("p", artifact.reason ?? "Dependency signatures match", "muted"),
    )
    content.append(row)
  }
}
function narrative() {
  if (!view?.narrative) {
    content.append(message("Script unavailable. Check its file status in the project overview."))
    return
  }
  content.append(element("p", view.narrative.logline), element("p", view.narrative.thesis, "muted"))
  for (const section of view.narrative.sections) {
    content.append(element("h2", section.heading))
    for (const sentence of section.sentences) {
      const row = button(
        "",
        () => {
          void openTrace(sentence.id)
        },
        `sentence${selection === sentence.id ? " selected" : ""}`,
      )
      row.append(
        element("small", sentence.id),
        badge(sentence.knowledge),
        element("p", sentence.text),
      )
      const ids = [
        ...sentence.claimIds,
        ...(sentence.hypothesisIds ?? []),
        ...(sentence.uncertaintyIds ?? []),
        ...(sentence.contradictionIds ?? []),
      ]
      if (ids.length) row.append(element("small", `Links: ${ids.join(" · ")}`))
      content.append(row)
    }
  }
}
function shots() {
  if (!view?.visual) {
    content.append(message("Shot list unavailable. Check its file status in the overview."))
    return
  }
  for (const shot of view.visual.shots) {
    const row = element("article", undefined, "shot")
    row.append(
      button(
        shot.id,
        () => {
          void openTrace(shot.id)
        },
        "pill-link",
      ),
      badge(shot.visualType),
      element("small", `${shot.duration} sec`),
      element("p", shot.description),
      element("p", shot.narration, "muted"),
    )
    for (const id of shot.narrativeSentenceIds) row.append(idLink(id))
    if (shot.source) row.append(element("p", `Shot source: ${shot.source}`, "muted"))
    content.append(row)
  }
}
function filterSelect(
  label: string,
  values: string[],
  value: string,
  update: (value: string) => void,
) {
  const box = element("label")
  box.append(element("small", `${label} `))
  const select = element("select")
  select.setAttribute("aria-label", label)
  for (const item of values) {
    const option = element("option", item === "all" ? "All" : (labels[item] ?? item))
    option.value = item
    select.append(option)
  }
  select.value = value
  select.addEventListener("change", () => {
    update(select.value)
    render()
  })
  box.append(select)
  return box
}
function audit() {
  if (!view) return
  content.append(
    element("h2", "Saved production audit"),
    element("p", "Descriptions and project content are shown in their original language.", "muted"),
  )
  const saved = view.selfCheck?.production
  if (saved) {
    content.append(badge(saved.verdict), badge(view.production.auditIntegrity))
    for (const check of saved.checks) {
      const row = element("div", undefined, "row")
      row.append(
        element("strong", labels[check.id] ?? check.id),
        badge(check.status),
        element("p", check.detail),
      )
      if (check.unknownReason)
        row.append(
          element("small", `Unknown reason: ${labels[check.unknownReason] ?? check.unknownReason}`),
        )
      for (const id of check.subjectIds) row.append(idLink(id))
      content.append(row)
    }
    if (saved.narrativeReferences) {
      content.append(
        element("h3", "Explicit script references"),
        element(
          "p",
          `Structure: ${labels[saved.narrativeReferences.structuralStatus] ?? saved.narrativeReferences.structuralStatus} · Semantics: ${labels[saved.narrativeReferences.semanticStatus] ?? saved.narrativeReferences.semanticStatus}`,
          "muted",
        ),
      )
      for (const reference of saved.narrativeReferences.references) {
        const row = element("div", undefined, "row")
        row.append(
          idLink(reference.sentenceId),
          idLink(reference.targetId),
          badge(reference.status),
          element("small", reference.detail),
        )
        content.append(row)
      }
    }
    content.append(
      message(
        "Saved write-scope results describe observations from a previous run. A read-only audit cannot verify file writes.",
      ),
    )
    if (view.liveAudit)
      content.append(
        element(
          "p",
          `In-memory audit: ${labels[view.liveAudit.verdict] ?? view.liveAudit.verdict}. Write scope: unknown. No files were updated.`,
          "muted",
        ),
      )
  } else content.append(message("Saved production audit is missing or unavailable."))
  content.append(element("h2", "Saved audit findings"))
  for (const diagnostic of saved?.diagnostics ?? []) {
    const row = element("div", undefined, "row")
    row.append(
      badge(diagnostic.severity),
      element("strong", labels[diagnostic.kind] ?? diagnostic.kind),
      element("p", diagnostic.detail),
    )
    for (const id of diagnostic.subjectIds) row.append(idLink(id))
    content.append(row)
  }
  content.append(element("h2", "Issue journal"))
  const filters = element("div", undefined, "filters")
  filters.append(
    filterSelect("Severity", ["all", "critical", "warning", "info"], issueSeverity, (v) => {
      issueSeverity = v
    }),
    filterSelect(
      "Disposition",
      ["all", "OPEN", "AWAITING_VERIFICATION", "DEFERRED", "DISMISSED", "RESOLVED"],
      issueStatus,
      (v) => {
        issueStatus = v
      },
    ),
    filterSelect("Snapshot", ["all", "CURRENT", "STALE", "UNVERIFIABLE"], issueFreshness, (v) => {
      issueFreshness = v
    }),
  )
  content.append(filters)
  const issues = view.issues.filter(
    (i) =>
      (issueSeverity === "all" || i.diagnostic.severity === issueSeverity) &&
      (issueStatus === "all" || i.status === issueStatus) &&
      (issueFreshness === "all" || i.freshness === issueFreshness),
  )
  if (!issues.length)
    content.append(
      message(
        view.files["production-issues"]?.status === "CORRUPT"
          ? "Issue journal failed validation; its history is unverified."
          : view.issues.length
            ? "No issues match the selected filters."
            : "No saved issues. Opening this page does not synchronize the journal or establish that no findings exist.",
      ),
    )
  for (const issue of issues) {
    const row = element("article", undefined, "row")
    row.append(
      badge(issue.diagnostic.severity),
      badge(issue.status),
      badge(issue.freshness),
      element("h3", labels[issue.diagnostic.kind] ?? issue.diagnostic.kind),
      element("p", issue.diagnostic.detail),
      element(
        "small",
        `Route: ${labels[issue.diagnostic.route] ?? issue.diagnostic.route} · ${issue.id}`,
      ),
    )
    for (const id of [
      ...issue.references.sentenceIds,
      ...issue.references.shotIds,
      ...issue.references.upstreamIds,
    ])
      row.append(idLink(id))
    for (const operation of issue.operations)
      row.append(
        element("p", `${operation.action} · ${operation.status} — ${operation.note}`, "muted"),
      )
    if (issue.verificationSignature)
      row.append(
        element("small", `Verified on snapshot ${issue.verificationSignature.slice(0, 12)}`),
      )
    content.append(row)
  }
}
function snippet(value: unknown) {
  const text = JSON.stringify(value, null, 2) ?? "Missing"
  return text.length > 12000 ? `${text.slice(0, 12000)}\n… Long value truncated` : text
}
function history() {
  if (!view) return
  content.append(
    element("h2", "Production revision history"),
    message(
      "Historical changes are displayed for inspection. They do not replace current files or trigger publication.",
    ),
  )
  if (!view.revisions.length)
    content.append(
      message(
        view.files["production-revisions"]?.status === "CORRUPT"
          ? "Revision journal failed validation; history is unverified."
          : "No saved revisions.",
      ),
    )
  for (const revision of [...view.revisions].reverse()) {
    const details = element("details"),
      summary = element("summary", `${revision.id} · ${labels[revision.status] ?? revision.status}`)
    details.append(
      summary,
      element(
        "p",
        `Stages: ${revision.plan.stages.map((stage) => labels[stage] ?? stage).join(" → ")}`,
      ),
    )
    for (const reason of revision.plan.reasons)
      details.append(
        element(
          "p",
          reason.startsWith("Explicit request: ")
            ? `Requested stage: ${labels[reason.slice(18)] ?? reason.slice(18)}`
            : reason,
          "muted",
        ),
      )
    for (const change of revision.diff) {
      details.append(
        element("h3", `${labels[change.artifact] ?? change.artifact} · ${change.path}`),
      )
      const diff = element("div", undefined, "diff"),
        before = element("div"),
        after = element("div")
      before.append(element("small", "Before"), element("pre", snippet(change.before)))
      after.append(element("small", "After"), element("pre", snippet(change.after)))
      diff.append(before, after)
      details.append(diff)
    }
    if (!revision.diff.length) details.append(element("p", "No structural changes.", "muted"))
    content.append(details)
  }
}
function flow() {
  if (!view) return
  if (view.production.publication === "PUBLISHING") {
    content.append(message("Flow is unavailable while publication is incomplete."))
    return
  }
  const ids = [
    ...new Set([
      ...(view.visual?.shots.map((shot) => shot.id) ?? []),
      ...(view.narrative?.sections.flatMap((section) =>
        section.sentences.map((sentence) => sentence.id),
      ) ?? []),
      ...(view.claims?.claims.map((claim) => claim.id) ?? []),
      ...(flowSubject ? [flowSubject] : []),
    ]),
  ]
  if (!ids.length) {
    content.append(message("No traceable subjects are available in this snapshot."))
    return
  }
  if (!flowSubject || !ids.includes(flowSubject)) flowSubject = ids[0]!
  const label = element("label", "Trace subject "),
    select = element("select")
  select.setAttribute("aria-label", "Trace subject")
  for (const id of ids) {
    const option = element("option", id)
    option.value = id
    select.append(option)
  }
  select.value = flowSubject
  select.addEventListener("change", () => {
    flowSubject = select.value
    render()
  })
  label.append(select)
  content.append(label)
  const host = element("div")
  host.append(message("Loading evidence flow…"))
  content.append(host)
  const current = view,
    ticket = flowGeneration,
    subject = flowSubject
  void api<TraceGraph>(
    `/api/projects/${encodeURIComponent(current.id)}/trace?id=${encodeURIComponent(subject)}&version=${encodeURIComponent(current.readVersion)}`,
  )
    .then((graph) => {
      if (ticket !== flowGeneration || current !== view || tab !== "flow") return
      host.replaceChildren()
      disposeFlow = mountFlow(host, graph, current.id)
    })
    .catch((error: unknown) => {
      if (ticket === flowGeneration)
        host.replaceChildren(
          message(error instanceof Error ? error.message : "Flow unavailable", true),
        )
    })
}
function nodeText(node: TraceNode) {
  if (!node.data || typeof node.data !== "object")
    return node.status === "UNAVAILABLE"
      ? "Reference cannot be checked: the research bundle is unavailable."
      : node.status === "AMBIGUOUS"
        ? "This identifier occurs more than once; the reference is ambiguous."
        : "Reference does not resolve in saved files."
  const data = node.data as Record<string, unknown>
  return String(
    data.text ??
      data.statement ??
      data.title ??
      data.description ??
      data.rule ??
      data.detail ??
      node.kind,
  )
}
function renderTrace(graph: TraceGraph) {
  traceBox.replaceChildren(
    button("Close links", () => {
      closeTrace()
      render()
    }),
    button("Open Flow", () => {
      flowSubject = graph.subjectId
      closeTrace()
      tab = "flow"
      render()
    }),
    element("h2", "Links and evidence"),
  )
  const nav = element("div")
  for (const id of crumbs)
    nav.append(
      button(
        id,
        () => {
          crumbs = crumbs.slice(0, crumbs.indexOf(id))
          void openTrace(id)
        },
        "pill-link",
      ),
    )
  traceBox.append(nav)
  for (const notice of graph.notices) traceBox.append(element("p", notice, "muted"))
  for (const node of graph.nodes) {
    const row = element("div", undefined, "graph-node")
    row.append(
      element("small", labels[node.kind] ?? node.kind),
      button(
        node.id,
        () => {
          void openTrace(node.id)
        },
        "pill-link",
      ),
      badge(node.status),
      element("p", nodeText(node)),
    )
    if (node.data && typeof node.data === "object") {
      const data = node.data as Record<string, unknown>
      if (data.excerpt) row.append(element("p", String(data.excerpt), "muted"))
      if (typeof data.url === "string") {
        try {
          const url = new URL(data.url)
          if (["http:", "https:"].includes(url.protocol)) {
            const a = element("a", "Open source")
            a.href = url.href
            a.target = "_blank"
            a.rel = "noopener noreferrer"
            row.append(a)
          }
        } catch {
          /* Invalid external links remain plain text in stored data. */
        }
      }
    }
    for (const edge of graph.edges.filter((e) => e.from === node.id)) {
      const line = element("p", `${labels[edge.relation] ?? edge.relation} → ${edge.to}`, "muted")
      if (edge.supported === false)
        line.append(badge("FAIL"), element("span", " This link does not support the claim"))
      row.append(line)
    }
    traceBox.append(row)
  }
  if (window.innerWidth <= 1100) traceBox.scrollIntoView({ block: "start" })
}
async function openTrace(id: string) {
  if (!view) return
  const current = view,
    ticket = ++traceGeneration
  selection = id
  layout.classList.add("tracing")
  traceBox.hidden = false
  traceBox.replaceChildren(element("p", "Reading links…", "muted"))
  render()
  try {
    const graph = await api<TraceGraph>(
      `/api/projects/${encodeURIComponent(current.id)}/trace?id=${encodeURIComponent(id)}&version=${encodeURIComponent(current.readVersion)}`,
    )
    if (ticket !== traceGeneration || current !== view) return
    if (crumbs.at(-1) !== id) crumbs.push(id)
    renderTrace(graph)
  } catch (error) {
    if (ticket === traceGeneration)
      traceBox.replaceChildren(
        button("Close", closeTrace),
        message(error instanceof Error ? error.message : "Links unavailable", true),
      )
  }
}
search.addEventListener("input", renderProjects)
refresh.addEventListener("click", () => {
  if (view) void openProject(view.id)
  else void loadProjects()
})
function showHome(state: WorkspaceState) {
  disposeHome?.()
  disposeHome = null
  content.className = ""
  heading.replaceChildren(element("h1", "My workspace"))
  tabs.replaceChildren()
  content.replaceChildren()
  disposeHome = mountWorkspaceHome(
    content,
    state,
    (id) => {
      void openProject(id)
    },
    () => {
      void loadProjects()
    },
    trashItems,
    deleteProject,
    restoreProject,
    createNewProject,
  )
}
async function loadProjects() {
  const ticket = ++projectListTicket
  refresh.disabled = true
  showHome({ kind: "loading" })
  setStatus("Reading project list…")
  try {
    const [result, deleted] = await Promise.all([
      api<Project[]>("/api/projects"),
      api<Array<{ id: string; project: string }>>("/api/trash"),
    ])
    if (ticket !== projectListTicket) return
    trashItems = deleted
    projects = result
    renderProjects()
    showHome({ kind: "ready", projects })
    setStatus("Local projects loaded")
  } catch (error) {
    if (ticket !== projectListTicket) return
    const message = error instanceof Error ? error.message : "Projects unavailable"
    showHome({ kind: "error", message })
    setStatus("Projects unavailable", true)
  } finally {
    if (ticket === projectListTicket) refresh.disabled = false
  }
}
get<HTMLButtonElement>("workspace-home").addEventListener("click", () => {
  generation++
  disposeFlow?.()
  disposeFlow = null
  flowGeneration++
  view = null
  closeTrace()
  void loadProjects()
})
void loadProjects()

async function deleteProject(id: string) {
  const snapshot = await api<ProjectView>("/api/projects/" + encodeURIComponent(id))
  await api(
    "/api/projects/" +
      encodeURIComponent(id) +
      "?version=" +
      encodeURIComponent(snapshot.readVersion),
    "DELETE",
  )
  await loadProjects()
}
async function restoreProject(id: string) {
  await api("/api/trash/" + encodeURIComponent(id) + "/restore", "POST")
  await loadProjects()
}
get<HTMLButtonElement>("project-toggle").addEventListener("click", () => {
  const toggle = get<HTMLButtonElement>("project-toggle")
  const expanded = toggle.getAttribute("aria-expanded") !== "true"
  toggle.setAttribute("aria-expanded", String(expanded))
  get("project-navigation").classList.toggle("expanded", expanded)
})

async function createNewProject(input: CreateProjectInput) {
  const ticket = projectListTicket
  const result = await api<{ id: string }>("/api/projects", "POST", input)
  if (ticket !== projectListTicket) return
  // Creation succeeded even if a subsequent list read fails.
  const created = { id: result.id, title: input.title, question: input.question, status: "VALID" }
  projects = [...projects.filter((project) => project.id !== result.id), created]
  renderProjects()
  tab = "overview"
  await openProject(result.id)
  content.focus()
}
