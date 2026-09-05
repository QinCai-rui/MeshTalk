import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { ChatApp } from "./ChatApp"
import type { SplashStyle } from "./SplashScreen"

type Tui = {
  destroy: () => void
  exited: Promise<number>
}

export type TuiOptions = {
  splashStyle?: SplashStyle | false
}

export async function runTui(options: TuiOptions = {}): Promise<Tui> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
  createRoot(renderer).render(<ChatApp splashStyle={options.splashStyle} />)
  return {
    destroy: () => renderer.destroy(),
    exited: new Promise((resolve) => renderer.once("destroy", () => resolve(typeof process.exitCode === "number" ? process.exitCode : 0))),
  }
}
