import { createInterface } from "node:readline/promises"
import type { ApprovalGate, ApprovalDecision } from "./pipeline.js"
import type { MemoryStore } from "./memory/json-memory.js"
import { renderScript } from "./documentary.js"
import type { Narrative, ResearchOutput, HypothesesOutput, SelfCheckOutput } from "./schemas.js"

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
    "narrative",
    "selfCheck",
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
    if (!HumanApprover.REVIEWABLE_STAGES.has(stage)) return { approved: true }

    const output = this.config.output ?? ((text: string) => process.stdout.write(text))
    while (true) {
      output(this.renderSummary(stage, artifact))
      const choice = await this.askOne(
        `\nCheckpoint [${stage}] — (a)pprove, (r)eject, (m)odify, (g)enerate again > `,
      )
      switch (choice) {
        case "a":
          await this.recordApproval(stage)
          output(`✓ ${stage} approved\n`)
          return { approved: true }
        case "r":
          return { approved: false, message: `Rejected by operator at ${stage} checkpoint` }
        case "m": {
          const replacement = await this.modifyArtifact(stage, artifact, output)
          if (replacement !== undefined) {
            await this.recordApproval(stage, true)
            output(`✓ ${stage} approved with manual edits\n`)
            return { approved: true, replacement }
          }
          output(`✗ edit aborted, keeping generated artifact\n`)
          continue
        }
        case "g":
          output(`↻ regenerating ${stage}\n`)
          return { approved: false, regenerate: true }
        default:
          output(`Unknown choice "${choice}". Use a / r / m / g.\n`)
      }
    }
  }

  /** Persists the operator's approval decision for a stage (uses a safe key on all OSes). */
  private async recordApproval(stage: string, modified = false): Promise<void> {
    const key = "approved"
    const current =
      (await this.memory.get<Record<string, { approvedAt: string; modified?: boolean }>>(key)) ?? {}
    current[stage] = {
      approvedAt: new Date().toISOString(),
      ...(modified ? { modified: true } : {}),
    }
    await this.memory.save(key, current)
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
    if (stage === "research") return this.renderResearch(artifact as ResearchOutput, heading)
    if (stage === "hypotheses") return this.renderHypotheses(artifact as HypothesesOutput, heading)
    if (stage === "narrative") return this.renderNarrative(artifact as Narrative, heading)
    if (stage === "selfCheck") return this.renderSelfCheck(artifact as SelfCheckOutput, heading)
    return `${heading}${JSON.stringify(artifact, null, 2).slice(0, 1500)}\n`
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
    const lines = [
      heading,
      `Critical: ${critical.length}    Warning: ${warnings.length}    Info: ${info.length}`,
      "",
      ...critical.map((c) => `  [CRITICAL] ${c.detail}`),
      ...warnings.map((w) => `  [WARNING] ${w.detail}`),
      ...info.map((i) => `  [INFO] ${i.detail}`),
    ]
    return `${lines.join("\n")}\n`
  }
}
