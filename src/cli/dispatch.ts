import {
  cmdInit,
  cmdList,
  cmdDocumentary,
  cmdReason,
  cmdStage,
  cmdSources,
  cmdEvidence,
  cmdContradictions,
  cmdGaps,
  cmdTrace,
  cmdIntelligence,
  parseArgs,
  STAGE_COMMANDS,
} from "./cli.js"

const USAGE =
  "Usage: scad <init|research|claims|hypotheses|factCheck|narrative|visual|selfCheck|sources|evidence|gaps|contradictions|trace|intelligence|reason|documentary|list> [project-name] [quality|completeness|verify|contradictions|uncertainty] [--force] [--interactive] [--provider <mock|brave>]"

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
        parsed.provider,
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
    case "intelligence":
      return cmdIntelligence(rest[0], rest[1])
    case "reason": {
      const parsed = parseArgs(rest)
      return cmdReason(parsed.name, parsed.force, parsed.provider, parsed.interactive)
    }
    default: {
      if (command && STAGE_COMMANDS.has(command)) {
        const parsed = parseArgs(rest)
        return cmdStage(command, parsed.name, parsed.force, parsed.provider)
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
