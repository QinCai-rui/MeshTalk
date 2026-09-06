import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { ChatApp } from "./ChatApp"
import type { SplashStyle } from "./SplashScreen"
import { installWarningLog } from "./warningLog"

function splashStyleFromArgs(): SplashStyle | false | undefined {
  const option = process.argv.slice(2).find((arg) => arg.startsWith("--splash="))
  if (!option) return undefined
  const value = option.slice("--splash=".length)
  if (value === "false" || value === "off") return false
  if (value === "card" || value === "boot-log") return value
  throw new Error("--splash must be false, card, or boot-log")
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
// Every ScrollBox adds one renderer "selection" listener for drag-autoscroll.
// Chat + an open settings page legitimately mount more than Node's default
// maximum of 10 (sidebar, history, footer, rail, body, menu, description…),
// so raise the limit instead of warning on normal operation.
renderer.setMaxListeners(30)
installWarningLog(() => renderer.eventNames().map((event) => `${String(event)}:${renderer.listenerCount(event)}`).join(" "))
createRoot(renderer).render(<ChatApp splashStyle={splashStyleFromArgs()} />)
