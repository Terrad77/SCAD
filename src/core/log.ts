export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(tag: string, message: string): void
  info(tag: string, message: string): void
  warn(tag: string, message: string): void
  error(tag: string, message: string): void
}

const levelRank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Minimal structured logger. Every line is `[tag] message` so pipeline stages
 * can be traced in CI logs. Never logs secrets: callers must not pass them in
 * the message.
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly threshold: LogLevel = "info") {}

  debug(tag: string, message: string): void {
    this.write("debug", tag, message)
  }

  info(tag: string, message: string): void {
    this.write("info", tag, message)
  }

  warn(tag: string, message: string): void {
    this.write("warn", tag, message)
  }

  error(tag: string, message: string): void {
    this.write("error", tag, message)
  }

  private write(level: LogLevel, tag: string, message: string): void {
    if (levelRank[level] < levelRank[this.threshold]) return
    const line = `[${tag}] ${message}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else console.log(line)
  }
}

let globalLogger: Logger = new ConsoleLogger()

export function setLogger(logger: Logger): void {
  globalLogger = logger
}

export function getLogger(): Logger {
  return globalLogger
}
