import { createInterface } from "node:readline/promises"
import type { ApprovalGate, ApprovalDecision } from "./pipeline.js"
import type { MemoryStore } from "./memory/json-memory.js"
import { renderScript } from "./documentary.js"
import type { Narrative, ResearchOutput, HypothesesOutput, SelfCheckOutput } from "./schemas.js"
import type {
  ProductionProvenance,
  ReasoningContext,
  SelfCheckProductionReport,
} from "./production/types.js"

/**
 * Interactive human checkpoint. Prompts the operator after each reviewable stage
 * to approve, reject, hand-edit (modify) or regenerate the artifact.
 *
 * Checkpoints mirror the task's RESUME breakpoints:
 *   RESEARCH REVIEW → HYPOTHESIS REVIEW → NARRATIVE REVIEW → FINAL FACT CHECK → EXPORT
 */
export class HumanApprover implements ApprovalGate {
  private static readonly REVIEWABLE_STAGES = new Set([
    "research",
    "hypotheses",
    "reasoningContext",
    "narrative",
    "selfCheck",
    "reasoning",
  ])

  /** Pre-buffered lines from stdin so piped input is consumed reliably. */
  private readonly answers: string[] = []
  private readonly waiters: Array<() => void> = []
  private stdinClosed = false

  constructor(
    private readonly memory: MemoryStore,
    private readonly config: {
      /** By default prompts on the terminal; inject a fake answerer in tests. */
      ask?: (prompt: string) => Promise<string>
      /** Optional hook called with the rendered checkpoint summary. */
      output?: (text: string) => void
      /** Path to the editor used for `modify` (defaults to $EDITOR/$VISUAL or vi). */
      editor?: string
    } = {},
  ) {
    if (!config.ask) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.on("line", (line) => {
        this.answers.push(line)
        const waiter = this.waiters.shift()
        if (waiter) waiter()
      })
      rl.on("close", () => {
        this.stdinClosed = true
        const waiter = this.waiters.shift()
        if (waiter) waiter()
      })
    }
  }

  async review(stage: string, artifact: unknown): Promise<ApprovalDecision> {
    if (!HumanApprover.REVIEWABLE_STAGES.has(stage) && !stage.startsWith("revision.")) {
      // No checkpoint for this stage, so nobody was asked — recorded as `auto`
      // rather than silently credited to a human (H7).
      return { approved: true, authority: "auto" }
    }

    const output = this.config.output ?? ((text: string) => process.stdout.write(text))
    while (true) {
      output(this.renderSummary(stage, artifact))
      const choice = await this.askOne(
        `\nCheckpoint [${stage}] — (a)pprove, (r)eject, (m)odify, (g)enerate again > `,
      )
      if (choice === "" && this.stdinClosed)
        return { approved: false, message: "Review input closed" }
      switch (choice) {
        case "a":
          output(`✓ ${stage} approved\n`)
          return { approved: true, authority: "human" }
        case "r":
          return { approved: false, message: `Rejected by operator at ${stage} checkpoint` }
        case "m": {
          if (
            ["revision.reasoningContext", "revision.selfCheck", "revision.final"].includes(stage)
          ) {
            output("This checkpoint cannot be hand-edited; reject or regenerate the draft.\n")
            continue
          }
          const editable = stage.startsWith("revision.")
            ? (artifact as { artifact: unknown }).artifact
            : artifact
          const replacement = await this.modifyArtifact(stage, editable, output)
          if (replacement !== undefined) {
            output(`✓ ${stage} approved with manual edits\n`)
            return { approved: true, replacement, authority: "human" }
          }
          output(`✗ edit aborted, keeping generated artifact\n`)
          continue
        }
        case "g":
          if (stage === "revision.final") {
            output("Reject this draft to request a new revision.\n")
            continue
          }
          output(`↻ regenerating ${stage}\n`)
          return { approved: false, regenerate: true }
        default:
          output(`Unknown choice "${choice}". Use a / r / m / g.\n`)
      }
    }
  }

  private async askOne(prompt: string): Promise<string> {
    if (this.config.ask) return (await this.config.ask(prompt)).trim().toLowerCase()

    if (this.answers.length > 0) return this.answers.shift()!.trim().toLowerCase()

    // No piped answer ready: prompt on the terminal and wait for a line.
    const output = this.config.output ?? ((text: string) => process.stdout.write(text))
    output(prompt)
    if (this.stdinClosed) return ""
    return await new Promise<string>((resolve) => {
      this.waiters.push(() => {
        const answer = this.answers.shift() ?? ""
        resolve(answer.trim().toLowerCase())
      })
    })
  }

  /** Opens the artifact in $EDITOR, re-reads it, and returns the edited JSON unless aborted. */
  private async modifyArtifact(
    stage: string,
    artifact: unknown,
    output: (text: string) => void,
  ): Promise<unknown | undefined> {
    // Injected answerer (tests) supplies a full replacement value directly.
    if (this.config.ask) {
      const answered = await this.config.ask(
        `Replace ${stage} artifact JSON (or send an empty line to keep it):\n`,
      )
      if (answered.trim() === "") return artifact
      try {
        return JSON.parse(answered) as unknown
      } catch {
        output(`✗ invalid JSON — keeping original artifact.\n`)
        return undefined
      }
    }

    const editor =
      this.config.editor ??
      process.env.SCAD_EDITOR ??
      process.env.VISUAL ??
      process.env.EDITOR ??
      "vi"
    const edited = await this.launchEditor(editor, JSON.stringify(artifact, null, 2))
    if (edited === undefined) {
      output(`✗ could not edit with "${editor}" (check $EDITOR) — keeping original artifact.\n`)
      return undefined
    }
    return edited
  }

  private async launchEditor(editor: string, text: string): Promise<unknown | undefined> {
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { spawn } = await import("node:child_process")

    const dir = await mkdtemp(join(tmpdir(), "scad-edit-"))
    const file = join(dir, "artifact.json")
    await writeFile(file, `${text}\n`, "utf8")

    return new Promise<unknown | undefined>((resolve) => {
      const child = spawn(editor, [file], { stdio: "inherit", shell: true })
      child.on("error", () => resolve(undefined))
      child.on("exit", async (code) => {
        if (code !== 0) return resolve(undefined)
        try {
          const raw = await readFile(file, "utf8")
          resolve(JSON.parse(raw) as unknown)
        } catch {
          resolve(undefined)
        }
      })
    })
  }

  private renderSummary(stage: string, artifact: unknown): string {
    const heading = `─=≡ Σ SCAD CHECKPOINT — ${stage.toUpperCase()}\n`
    if (stage.startsWith("revision.")) {
      const proposal = artifact as {
        revisionId: string
        artifact?: unknown
        candidate?: { narrative: Narrative; selfCheck: SelfCheckOutput }
        diff: unknown[]
      }
      const kind = stage.slice("revision.".length)
      let body: string
      if (kind === "final" && proposal.candidate) {
        body =
          this.renderNarrative(proposal.candidate.narrative, "Final script\n") +
          this.renderSelfCheck(proposal.candidate.selfCheck, "Final audit\n")
      } else if (kind === "narrative")
        body = this.renderNarrative(proposal.artifact as Narrative, heading)
      else if (kind === "selfCheck")
        body = this.renderSelfCheck(proposal.artifact as SelfCheckOutput, heading)
      else body = JSON.stringify(proposal.artifact, null, 2) + "\n"
      return (
        heading +
        `Revision: ${proposal.revisionId}\n` +
        body +
        "Structural changes (including dependencies):\n" +
        JSON.stringify(proposal.diff, null, 2) +
        "\n"
      )
    }
    if (stage === "research") return this.renderResearch(artifact as ResearchOutput, heading)
    if (stage === "hypotheses") return this.renderHypotheses(artifact as HypothesesOutput, heading)
    if (stage === "narrative") return this.renderNarrative(artifact as Narrative, heading)
    if (stage === "selfCheck") return this.renderSelfCheck(artifact as SelfCheckOutput, heading)
    if (stage === "reasoningContext") {
      return this.renderReasoningContext(artifact as ReasoningContext, heading)
    }
    if (stage === "reasoning") return this.renderReasoning(artifact, heading)
    return `${heading}${JSON.stringify(artifact, null, 2).slice(0, 1500)}\n`
  }

  /**
   * v0.7 — the reasoning→production checkpoint. The operator sees exactly what
   * the production side is being told to obey BEFORE approving it, so approving
   * the narrative is an informed decision and not a blind one.
   */
  private renderReasoningContext(context: ReasoningContext | undefined, heading: string): string {
    if (!context) return `${heading}(no reasoning context)\n`
    const s = context.epistemicSummary
    const lines = [
      heading,
      `Cycle: ${context.reasoningCycleId ?? "none"} (${context.decision.status}, ${
        context.decision.stoppingKind ?? "unresolved"
      }${context.decision.humanInTheLoop ? ", human in the loop" : ""})`,
      `Epistemic: ${s.usableClaimCount}/${s.claimCount} usable claims, ` +
        `${s.qualifiedClaimCount} qualified, ${s.unsupportedClaimCount} unsupported`,
      `         ${s.activeHypothesisCount}/${s.hypothesisCount} active hypotheses, ` +
        `${s.contradictionCount} contradictions, ${s.openGapCount} gaps, ` +
        `${s.uncertaintyCount} uncertainties`,
      `         completeness ${s.completenessStatus}, continueResearch ${s.continueResearch}`,
      "",
      `Production constraints (${context.constraints.length}):`,
      ...context.constraints.map(
        (c) =>
          `  [${c.severity.toUpperCase()}] ${c.kind}${c.subjectIds.length ? ` (${c.subjectIds.slice(0, 3).join(", ")})` : ""}`,
      ),
    ]
    return `${lines.join("\n")}\n`
  }

  /** v0.7 — constraint satisfaction and guard corrections at the narrative gate. */
  private renderProductionProvenance(provenance: ProductionProvenance | undefined): string[] {
    if (!provenance) return []
    const lines = [
      "",
      `--- production constraints (v0.7, context ${provenance.reasoningCycleId ?? "none"}) ---`,
      `  satisfied: ${provenance.satisfiedConstraints.length}    violations: ${provenance.violations.length}    guard corrections: ${provenance.normalizations.length}`,
    ]
    for (const v of provenance.violations) {
      lines.push(`  [VIOLATION/${v.severity}] ${v.kind}: ${v.detail}`)
    }
    for (const n of provenance.normalizations) {
      lines.push(`  [CORRECTED] ${n.rule} ${n.subjectId}: ${n.from} → ${n.to} (${n.reason})`)
    }
    return lines
  }

  private renderReasoning(artifact: unknown, heading: string): string {
    const candidate = artifact as {
      kind?: string
      target?: unknown
      targetHypothesis?: string | null
      question?: string
    }
    const target =
      candidate.targetHypothesis !== undefined
        ? `hypothesis ${candidate.targetHypothesis ?? "(new)"}`
        : candidate.target !== undefined
          ? JSON.stringify(candidate.target)
          : ""
    return `${heading}Reasoning action: ${candidate.kind ?? "(unknown)"}${target ? ` → ${target}` : ""}\n${candidate.question ? `  ${candidate.question}\n` : ""}`
  }

  private renderResearch(research: ResearchOutput | undefined, heading: string): string {
    const src = research?.sources ?? []
    const lines = [
      heading,
      `Sources: ${src.length}`,
      "",
      ...src.slice(0, 10).map((s) => `  [${s.id}] "${s.title}"${s.url ? " — " + s.url : ""}`),
    ]
    if (research && "evidence" in research) {
      const bundle = research as unknown as {
        evidence?: Array<{ id: string; sourceId: string; statement: string }>
        claims?: Array<{ id: string; statement: string; confidence: number; knowledge: string }>
        contradictions?: Array<{ id: string; severity: string; classification: string }>
        gaps?: Array<{ id: string; importance: number; question: string }>
      }
      lines.push("", `Evidence: ${bundle.evidence?.length ?? 0}`, "")
      for (const ev of (bundle.evidence ?? []).slice(0, 10)) {
        lines.push(`  [${ev.id}] (source ${ev.sourceId}) ${ev.statement}`)
      }
      lines.push("", `Claims: ${bundle.claims?.length ?? 0}`, "")
      for (const c of (bundle.claims ?? []).slice(0, 10)) {
        lines.push(`  [${c.id}] ${c.statement}`)
      }
      if ((bundle.contradictions?.length ?? 0) > 0) {
        lines.push("", `Contradictions: ${bundle.contradictions?.length}`, "")
        for (const c of (bundle.contradictions ?? []).slice(0, 5)) {
          lines.push(`  [${c.id}] ${c.severity} (${c.classification})`)
        }
      }
      if ((bundle.gaps?.length ?? 0) > 0) {
        lines.push("", `Research gaps: ${bundle.gaps?.length}`, "")
        for (const g of (bundle.gaps ?? []).slice(0, 5)) {
          lines.push(`  [${g.id}] importance ${g.importance.toFixed(2)} — ${g.question}`)
        }
      }
    }
    return `${lines.join("\n")}\n`
  }

  private renderHypotheses(hyp: HypothesesOutput | undefined, heading: string): string {
    const items = hyp?.hypotheses ?? []
    const lines = [
      heading,
      `Hypotheses: ${items.length}`,
      "",
      ...items.map(
        (h) =>
          `  [${h.id}] ${h.statement}\n      confidence ${h.confidence.toFixed(2)} — ${h.status}`,
      ),
    ]
    return `${lines.join("\n")}\n`
  }

  private renderNarrative(narrative: Narrative | undefined, heading: string): string {
    const sections = narrative?.sections ?? []
    const preview = narrative ? renderScript(narrative) : "(no narrative)"
    return (
      [
        heading,
        `Title: ${narrative?.title ?? ""}`,
        `Logline: ${narrative?.logline ?? ""}`,
        `Sections: ${sections.length}`,
        "",
        ...sections.map((s) => `  ## ${s.heading} (${s.sentences.length} sentences)`),
        ...this.renderProductionProvenance(narrative?.production),
        "",
        `--- script preview ---`,
        preview,
      ].join("\n") + "\n"
    )
  }

  private renderSelfCheck(selfCheck: SelfCheckOutput | undefined, heading: string): string {
    const critical = selfCheck?.critical ?? []
    const warnings = selfCheck?.warnings ?? []
    const info = selfCheck?.info ?? []
    const report = selfCheck?.production as SelfCheckProductionReport | undefined
    const lines = [
      heading,
      `Critical: ${critical.length}    Warning: ${warnings.length}    Info: ${info.length}`,
      "",
      ...critical.map((c) => `  [CRITICAL] ${c.detail}`),
      ...warnings.map((w) => `  [WARNING] ${w.detail}`),
      ...info.map((i) => `  [INFO] ${i.detail}`),
    ]
    if (report) {
      lines.push(
        "",
        `--- production audit (v0.7) — verdict ${report.verdict} (no epistemic mutation) ---`,
        ...report.checks.map((c) => `  [${c.status}] ${c.id}: ${c.detail}`),
      )
      if (report.narrativeReferences)
        lines.push(
          "",
          "Narrative references (structural and semantic results):",
          JSON.stringify(report.narrativeReferences, null, 2),
        )
      if (report.diagnostics.length > 0) {
        lines.push("", `  Diagnostics (routed, not applied):`)
        for (const d of report.diagnostics) {
          lines.push(`    ${d.severity.toUpperCase()} ${d.kind} → ${d.route}: ${d.detail}`)
        }
      }
    }
    return `${lines.join("\n")}\n`
  }
}
