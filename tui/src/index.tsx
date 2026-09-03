import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { ChatApp } from "./ChatApp"
import type { SplashStyle } from "./SplashScreen"

function splashStyleFromArgs(): SplashStyle | false | undefined {
  const option = process.argv.slice(2).find((arg) => arg.startsWith("--splash="))
  if (!option) return undefined
  const value = option.slice("--splash=".length)
  if (value === "false" || value === "off") return false
  if (value === "card" || value === "boot-log") return value
  throw new Error("--splash must be false, card, or boot-log")
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
createRoot(renderer).render(<ChatApp splashStyle={splashStyleFromArgs()} />)
