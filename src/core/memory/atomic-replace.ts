import { rename } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
/** Windows readers/scanners can briefly deny replacement. Never delete the destination. */
export async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        attempt >= 5
      )
        throw error
      await setTimeout(20 * 2 ** attempt)
    }
  }
}
