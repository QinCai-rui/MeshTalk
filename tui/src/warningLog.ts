import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function warningLogPath() {
  return join(homedir(), ".meshtalk", "warnings.log")
}

let installed = false

// Node prints warnings to stderr, which is invisible while the TUI owns the
// terminal. Mirror them to ~/.meshtalk/warnings.log so they can be inspected
// after exiting. Logging must never break the TUI itself.
export function installWarningLog(getListenerCounts?: () => string) {
  if (installed) return
  installed = true
  process.on("warning", (warning) => {
    try {
      mkdirSync(join(homedir(), ".meshtalk"), { recursive: true })
      let entry = `${new Date().toISOString()} [${warning.name}] ${warning.message}\n${warning.stack ?? ""}\n`
      if (getListenerCounts) {
        try {
          entry += `listener counts: ${getListenerCounts()}\n`
        } catch {
          // ignore count failures, the warning itself is already captured
        }
      }
      appendFileSync(warningLogPath(), `${entry}---\n`)
    } catch {
      // ignore logging failures entirely
    }
  })
}
