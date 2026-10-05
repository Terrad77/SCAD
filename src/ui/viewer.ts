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
const labels: Record<string, string> = {
  VALID: "Загружено",
  MISSING: "Отсутствует",
  CORRUPT: "Повреждено",
  UNREADABLE: "Недоступно",
  UNAVAILABLE: "Недоступно",
  CURRENT: "Актуально",
  STALE: "Исторический снимок",
  UNKNOWN: "Не установлено",
  UNVERIFIABLE: "Не подтверждено",
  OPEN: "Открыто",
  AWAITING_VERIFICATION: "Ждёт проверки",
  DEFERRED: "Отложено",
  DISMISSED: "Отклонено автором",
  RESOLVED: "Устранено на проверенном снимке",
  FOUND: "Ссылка найдена",
  AMBIGUOUS: "Неоднозначная ссылка",
  DRAFT: "Черновик",
  PUBLISHING: "Публикация незавершена",
  COMPLETED: "Завершено",
  REJECTED: "Отклонено",
  IDLE: "Нет незавершённой revision",
  MATCH: "Проверки содержания совпадают",
  MISMATCH: "Аудиты содержания расходятся",
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
async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? "Ошибка чтения")
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
        projects.length ? "Проекты не найдены по запросу." : "Существующих проектов пока нет.",
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
  const ticket = ++generation
  closeTrace()
  refresh.disabled = true
  setStatus("Читаем материалы проекта…")
  view = null
  heading.replaceChildren(element("h1", "Загрузка проекта"))
  tabs.replaceChildren()
  content.replaceChildren()
  try {
    const result = await api<ProjectView>(`/api/projects/${encodeURIComponent(id)}`)
    if (ticket !== generation) return
    view = result
    renderProjects()
    render()
    setStatus("Снимок загружен · только просмотр")
  } catch (error) {
    if (ticket === generation) {
      heading.replaceChildren(element("h1", "Проект недоступен"))
      setStatus(error instanceof Error ? error.message : "Ошибка чтения", true)
    }
  } finally {
    if (ticket === generation) refresh.disabled = false
  }
}
function render() {
  if (!view) return
  heading.replaceChildren(
    element("h1", view.meta?.title || view.id),
    element("p", view.meta?.question || "Вопрос проекта отсутствует", "muted"),
  )
  tabs.replaceChildren()
  for (const [id, label] of [
    ["overview", "Обзор"],
    ["narrative", "Сценарий"],
    ["shots", "Кадры"],
    ["audit", "Проверка и issues"],
    ["history", "История"],
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
  content.replaceChildren()
  if (view.production.notice) content.append(message(view.production.notice, true))
  if (tab === "overview") overview()
  if (tab === "narrative") narrative()
  if (tab === "shots") shots()
  if (tab === "audit") audit()
  if (tab === "history") history()
}
function overview() {
  if (!view) return
  const grid = element("div", undefined, "summary-grid")
  const freshness = !view.production.freshness
    ? "Не подтверждена"
    : view.production.freshness.artifacts.every((a) => a.status === "CURRENT")
      ? "Актуально"
      : "Есть устаревшие материалы"
  for (const [label, value] of [
    ["Актуальность production", freshness],
    ["Сохранённый audit verdict", view.selfCheck?.production?.verdict ?? "Нет production-аудита"],
    ["Публикация", labels[view.production.publication] ?? view.production.publication],
  ]) {
    const item = element("div", undefined, "summary-item")
    item.append(element("small", label), element("strong", value))
    grid.append(item)
  }
  content.append(
    grid,
    message(
      "Актуальность, результат аудита и решение по issue — разные свойства. Завершённая revision не подтверждает устранение всех замечаний.",
    ),
  )
  if (view.reasoning.latestCycle) {
    content.append(element("h2", "Последний reasoning cycle"))
    const cycle = view.reasoning.latestCycle
    content.append(
      element("p", `${cycle.cycleId} · ${cycle.status} · ${cycle.trigger}`),
      element("p", cycle.stopping?.reason ?? "Причина остановки не записана", "muted"),
    )
  }
  content.append(element("h2", "Сохранённые материалы"))
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
      element("p", artifact.reason ?? "Подписи зависимостей совпадают", "muted"),
    )
    content.append(row)
  }
}
function narrative() {
  if (!view?.narrative) {
    content.append(message("Сценарий недоступен. Проверьте состояние narrative в обзоре проекта."))
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
      if (ids.length) row.append(element("small", `Связи: ${ids.join(" · ")}`))
      content.append(row)
    }
  }
}
function shots() {
  if (!view?.visual) {
    content.append(message("Shot list недоступен. Проверьте состояние visual в обзоре."))
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
      element("small", `${shot.duration} сек`),
      element("p", shot.description),
      element("p", shot.narration, "muted"),
    )
    for (const id of shot.narrativeSentenceIds) row.append(idLink(id))
    if (shot.source) row.append(element("p", `Источник кадра: ${shot.source}`, "muted"))
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
    const option = element("option", item === "all" ? "Все" : (labels[item] ?? item))
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
  content.append(element("h2", "Сохранённый production-аудит"))
  const saved = view.selfCheck?.production
  if (saved) {
    content.append(badge(saved.verdict), badge(view.production.auditIntegrity))
    for (const check of saved.checks) {
      const row = element("div", undefined, "row")
      row.append(element("strong", check.id), badge(check.status), element("p", check.detail))
      if (check.unknownReason)
        row.append(element("small", `Причина UNKNOWN: ${check.unknownReason}`))
      for (const id of check.subjectIds) row.append(idLink(id))
      content.append(row)
    }
    if (saved.narrativeReferences) {
      content.append(
        element("h3", "Явные narrative references"),
        element(
          "p",
          `Структура: ${saved.narrativeReferences.structuralStatus} · Семантика: ${saved.narrativeReferences.semanticStatus}`,
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
        "Сохранённый scope verdict относится к наблюдениям прошлого запуска. Повторная проверка чтением не может подтвердить файловые записи.",
      ),
    )
    if (view.liveAudit)
      content.append(
        element(
          "p",
          `Повторный аудит в памяти: ${view.liveAudit.verdict}. Scope: UNKNOWN. Файлы не обновлялись.`,
          "muted",
        ),
      )
  } else content.append(message("Сохранённый production-аудит отсутствует или недоступен."))
  content.append(element("h2", "Диагностика сохранённого аудита"))
  for (const diagnostic of saved?.diagnostics ?? []) {
    const row = element("div", undefined, "row")
    row.append(
      badge(diagnostic.severity),
      element("strong", diagnostic.kind),
      element("p", diagnostic.detail),
    )
    for (const id of diagnostic.subjectIds) row.append(idLink(id))
    content.append(row)
  }
  content.append(element("h2", "Журнал issues"))
  const filters = element("div", undefined, "filters")
  filters.append(
    filterSelect("Важность", ["all", "critical", "warning", "info"], issueSeverity, (v) => {
      issueSeverity = v
    }),
    filterSelect(
      "Решение",
      ["all", "OPEN", "AWAITING_VERIFICATION", "DEFERRED", "DISMISSED", "RESOLVED"],
      issueStatus,
      (v) => {
        issueStatus = v
      },
    ),
    filterSelect("Снимок", ["all", "CURRENT", "STALE", "UNVERIFIABLE"], issueFreshness, (v) => {
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
          ? "Журнал issues повреждён; его история не подтверждена."
          : view.issues.length
            ? "Нет issues с выбранными фильтрами."
            : "Сохранённых issues нет. Открытие экрана не синхронизирует журнал и не означает отсутствия замечаний.",
      ),
    )
  for (const issue of issues) {
    const row = element("article", undefined, "row")
    row.append(
      badge(issue.diagnostic.severity),
      badge(issue.status),
      badge(issue.freshness),
      element("h3", issue.diagnostic.kind),
      element("p", issue.diagnostic.detail),
      element("small", `Маршрут: ${issue.diagnostic.route} · ${issue.id}`),
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
        element("small", `Подтверждено на снимке ${issue.verificationSignature.slice(0, 12)}`),
      )
    content.append(row)
  }
}
function snippet(value: unknown) {
  const text = JSON.stringify(value, null, 2) ?? "Отсутствует"
  return text.length > 12000 ? `${text.slice(0, 12000)}\n… Фрагмент длинного значения` : text
}
function history() {
  if (!view) return
  content.append(
    element("h2", "Production revisions"),
    message(
      "Исторические изменения показаны для просмотра. Они не заменяют текущие материалы и не запускают публикацию.",
    ),
  )
  if (!view.revisions.length)
    content.append(
      message(
        view.files["production-revisions"]?.status === "CORRUPT"
          ? "Журнал revisions повреждён; история не подтверждена."
          : "Сохранённых revisions нет.",
      ),
    )
  for (const revision of [...view.revisions].reverse()) {
    const details = element("details"),
      summary = element("summary", `${revision.id} · ${labels[revision.status] ?? revision.status}`)
    details.append(summary, element("p", `Этапы: ${revision.plan.stages.join(" → ")}`))
    for (const reason of revision.plan.reasons) details.append(element("p", reason, "muted"))
    for (const change of revision.diff) {
      details.append(element("h3", `${change.artifact} · ${change.path}`))
      const diff = element("div", undefined, "diff"),
        before = element("div"),
        after = element("div")
      before.append(element("small", "До"), element("pre", snippet(change.before)))
      after.append(element("small", "После"), element("pre", snippet(change.after)))
      diff.append(before, after)
      details.append(diff)
    }
    if (!revision.diff.length) details.append(element("p", "Структурных изменений нет.", "muted"))
    content.append(details)
  }
}
function nodeText(node: TraceNode) {
  if (!node.data || typeof node.data !== "object")
    return node.status === "AMBIGUOUS"
      ? "Идентификатор встречается несколько раз; связь неоднозначна."
      : "Ссылка не разрешается в сохранённых материалах."
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
    button("Закрыть связи", () => {
      closeTrace()
      render()
    }),
    element("h2", "Связи и доказательства"),
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
      element("small", node.kind),
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
            const a = element("a", "Открыть источник")
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
      const line = element("p", `${edge.relation} → ${edge.to}`, "muted")
      if (edge.supported === false)
        line.append(badge("FAIL"), element("span", " Связь не подтверждает этот claim"))
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
  traceBox.replaceChildren(element("p", "Читаем связи…", "muted"))
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
        button("Закрыть", closeTrace),
        message(error instanceof Error ? error.message : "Связи недоступны", true),
      )
  }
}
search.addEventListener("input", renderProjects)
refresh.addEventListener("click", () => {
  if (view) void openProject(view.id)
  else void loadProjects()
})
async function loadProjects() {
  setStatus("Читаем список проектов…")
  try {
    projects = await api<Project[]>("/api/projects")
    renderProjects()
    if (!view) {
      heading.replaceChildren(element("h1", "Рабочая область SCAD"))
      content.replaceChildren(
        element(
          "p",
          "Выберите проект, чтобы открыть сценарий, цепочки доказательств и замечания.",
          "empty",
        ),
      )
      setStatus(
        projects.length
          ? "Выберите проект слева"
          : "Создайте проект существующим CLI, затем обновите список",
      )
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Проекты недоступны", true)
  }
}
void loadProjects()
