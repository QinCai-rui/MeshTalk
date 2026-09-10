import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { ChatApp } from "./ChatApp"
import type { SplashStyle } from "./SplashScreen"
import { installWarningLog } from "./warningLog"
import { hasExplicitAnalyticsChoice, shouldPrompt } from "../../common/analytics"
import { APP_RELEASE_VERSION, IS_RELEASE_BUILD } from "./SplashScreen"

type Tui = {
  destroy: () => void
  exited: Promise<number>
}

export type TuiOptions = {
  splashStyle?: SplashStyle | false
  analyticsPrompt?: boolean
}

export async function runTui(options: TuiOptions = {}): Promise<Tui> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
  // Every ScrollBox adds one renderer "selection" listener for drag-autoscroll.
  // Chat + an open settings page legitimately mount more than Node's default
  // maximum of 10 (sidebar, history, footer, rail, body, menu, description…),
  // so raise the limit instead of warning on normal operation.
  renderer.setMaxListeners(30)
  installWarningLog(() => renderer.eventNames().map((event) => `${String(event)}:${renderer.listenerCount(event)}`).join(" "))
  const analyticsPrompt = options.analyticsPrompt ?? (!hasExplicitAnalyticsChoice() && shouldPrompt(APP_RELEASE_VERSION))
  createRoot(renderer).render(<ChatApp splashStyle={options.splashStyle} analyticsPrompt={analyticsPrompt} />)
  return {
    destroy: () => renderer.destroy(),
    exited: new Promise((resolve) => renderer.once("destroy", () => resolve(typeof process.exitCode === "number" ? process.exitCode : 0))),
  }
}
