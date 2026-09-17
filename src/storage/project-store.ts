import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

export interface ProjectDir {
  base: string
  memoryDir: string
  outputDir: string
  name: string
}

export function projectDir(base: string, name: string): ProjectDir {
  return {
    base: join(base, name),
    memoryDir: join(base, name, "memory"),
    outputDir: join(base, name, "output"),
    name,
  }
}

export async function ensureProject(base: string, name: string): Promise<ProjectDir> {
  const dir = projectDir(base, name)
  await mkdir(dir.memoryDir, { recursive: true })
  await mkdir(dir.outputDir, { recursive: true })
  return dir
}

export async function projectExists(base: string, name: string): Promise<boolean> {
  try {
    return (await stat(join(base, name, "project.json"))).isFile()
  } catch {
    return false
  }
}

export async function initProject(
  base: string,
  name: string,
  question: string,
  title: string,
): Promise<ProjectDir> {
  const dir = await ensureProject(base, name)
  const meta = { project: name, question, title, createdAt: new Date().toISOString() }
  await writeFile(join(dir.base, "project.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8")
  return dir
}

export async function readMeta(
  base: string,
  name: string,
): Promise<{
  project: string
  question: string
  title: string
} | null> {
  try {
    return JSON.parse(await readFile(join(base, name, "project.json"), "utf8")) as {
      project: string
      question: string
      title: string
    }
  } catch {
    return null
  }
}

/** Stage name → output file name. */
export const OUTPUT_FILES: Record<string, string> = {
  research: "research.json",
  claims: "claims.json",
  hypotheses: "hypotheses.json",
  factCheck: "fact-check.json",
  narrative: "narrative.json",
  visual: "shot-list.json",
  selfCheck: "self-check.json",
}

export async function exportArtifacts(
  dir: ProjectDir,
  artifacts: Record<string, unknown>,
  extras: Record<string, string> = {},
): Promise<string[]> {
  const written: string[] = []
  for (const [stage, data] of Object.entries(artifacts)) {
    const file = OUTPUT_FILES[stage]
    if (!file) continue
    const path = join(dir.outputDir, file)
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8")
    written.push(path)
  }
  for (const [file, content] of Object.entries(extras)) {
    const path = join(dir.outputDir, file)
    await writeFile(path, content, "utf8")
    written.push(path)
  }
  return written
}

export async function listProjects(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base)
    const projects: string[] = []
    for (const entry of entries) {
      try {
        if ((await stat(join(base, entry, "project.json"))).isFile()) projects.push(entry)
      } catch {
        // not a project directory
      }
    }
    return projects
  } catch {
    return []
  }
}
