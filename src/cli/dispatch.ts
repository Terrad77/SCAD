import {
  cmdInit,
  cmdList,
  cmdDocumentary,
  cmdStage,
  cmdSources,
  cmdEvidence,
  cmdContradictions,
  cmdGaps,
  cmdTrace,
  parseArgs,
} from "./cli.js"

const STAGE_COMMANDS = new Set(["research", "claims", "hypotheses", "narrative", "shots", "check"])

const USAGE =
  "Usage: scad <init|research|claims|hypotheses|narrative|shots|check|sources|evidence|gaps|contradictions|trace|documentary|list> [project-name] [--force] [--interactive]"

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case "init": {
      const parsed = parseArgs(rest)
      return cmdInit(parsed.name, parsed.question ?? "", parsed.title ?? parsed.name ?? "")
    }
    case "list":
      return cmdList()
    case "documentary": {
      const parsed = parseArgs(rest)
      return cmdDocumentary(
        parsed.name,
        parsed.question ?? "",
        parsed.title ?? parsed.name ?? "",
        parsed.force,
        parsed.interactive,
      )
    }
    case "sources":
      return cmdSources(rest[0])
    case "evidence":
      return cmdEvidence(rest[0])
    case "gaps":
      return cmdGaps(rest[0])
    case "contradictions":
      return cmdContradictions(rest[0])
    case "trace":
      return cmdTrace(rest[0])
    default: {
      if (command && STAGE_COMMANDS.has(command)) {
        const parsed = parseArgs(rest)
        return cmdStage(command, parsed.name, parsed.force)
      }
      console.error(USAGE)
      return 1
    }
  }
}

export async function run(argv: string[]) {
  const code = await main(argv)
  process.exitCode = code
}
