import { cmdInit, cmdList, cmdDocumentary, cmdStage, parseArgs } from "./cli.js"

const STAGE_COMMANDS = new Set(["research", "claims", "hypotheses", "narrative", "shots", "check"])

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
      )
    }
    default: {
      if (command && STAGE_COMMANDS.has(command)) {
        const parsed = parseArgs(rest)
        return cmdStage(command, parsed.name, parsed.force)
      }
      console.error(
        "Usage: scad <init|research|claims|hypotheses|narrative|shots|check|documentary|list> [project-name] [flags]",
      )
      return 1
    }
  }
}

export async function run(argv: string[]) {
  const code = await main(argv)
  process.exitCode = code
}
