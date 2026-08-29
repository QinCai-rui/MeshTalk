import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { ChatApp } from "../tui/src/ChatApp"

type Tui = {
  destroy: () => void
  exited: Promise<number>
}

export async function runTui(): Promise<Tui> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
  createRoot(renderer).render(<ChatApp />)
  return {
    destroy: () => renderer.destroy(),
    exited: new Promise((resolve) => renderer.once("destroy", () => resolve(process.exitCode ?? 0))),
  }
}
