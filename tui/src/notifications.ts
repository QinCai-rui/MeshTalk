import { platform } from "os"

export type NotificationDelivery = "terminal" | "native" | "disabled"
export type NotificationEvent = "messages" | "friend_requests" | "file_offers" | "file_completed"

export type NotificationPreferences = {
  setup_dismissed: boolean
  delivery: NotificationDelivery
  events: Record<NotificationEvent, boolean>
}

type TerminalRenderer = {
  capabilities?: { notifications?: boolean; focus_tracking?: boolean } | null
  // Optional focus state exposed by CliRenderer ("focus" / "blur" events).
  // If present, we suppress notifications while the terminal is focused.
  // Use index signature so CliRenderer (which has private _terminalFocusState)
  // remains compatible.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
  triggerNotification(message: string, title: string): boolean | void
}

function powerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export async function sendNativeNotification(message: string, title = "MeshTalk"): Promise<boolean> {
  async function run(command: string[]): Promise<boolean> {
    try {
      const process = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
      return (await process.exited) === 0
    } catch {
      return false
    }
  }

  if (platform() === "darwin") {
    // terminal-notifier is an app bundle and can have its own macOS alert
    // permission, unlike the often-suppressed osascript process.
    if (await run(["terminal-notifier", "-title", title, "-message", message, "-sound", "default", "-group", "meshtalk"])) return true
    return run(["osascript", "-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)} sound name "default"`])
  }
  let command: string[]
  if (platform() === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$icon = New-Object System.Windows.Forms.NotifyIcon",
      "$icon.Icon = [System.Drawing.SystemIcons]::Information",
      "$icon.Visible = $true",
      `$icon.ShowBalloonTip(5000, ${powerShellString(title)}, ${powerShellString(message)}, [System.Windows.Forms.ToolTipIcon]::Info)`,
      "Start-Sleep -Seconds 6",
      "$icon.Dispose()",
    ].join("; ")
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]
  } else {
    command = ["notify-send", "--app-name=MeshTalk", title, message]
  }
  return run(command)
}

export async function sendTestNotification(
  delivery: Exclude<NotificationDelivery, "disabled">,
  renderer: TerminalRenderer | unknown,
): Promise<boolean> {
  if (delivery === "native") return sendNativeNotification("If you can see this, native notifications work.")
  if (!(renderer as TerminalRenderer).capabilities?.notifications) return false
  // Terminals commonly suppress OSC notifications while their own tab is focused.
  // Give the user time to switch tabs before testing the terminal protocol.
  await new Promise<void>((resolve) => setTimeout(resolve, 4_000))
  try {
    return (renderer as TerminalRenderer).triggerNotification("If you can see this, terminal notifications work.", "MeshTalk") !== false
  } catch {
    return false
  }
}

export function isAppFocused(renderer: unknown | null | undefined): boolean {
  if (!renderer || typeof renderer !== "object") return true
  const anyRenderer = renderer as { _terminalFocusState?: boolean | null; capabilities?: { focus_tracking?: boolean } | null }
  const state = anyRenderer?._terminalFocusState
  if (state === false) return false
  if (state === true) return true
  if (anyRenderer?.capabilities?.focus_tracking === false) return false
  return true
}

export async function notify(
  preferences: NotificationPreferences | null,
  event: NotificationEvent,
  renderer: unknown,
  message: string,
  options?: { respectFocus?: boolean },
): Promise<void> {
  if (!preferences?.events[event] || preferences.delivery === "disabled") return
  const respectFocus = options?.respectFocus !== false
  if (respectFocus && isAppFocused(renderer)) return
  if (preferences.delivery === "native") {
    await sendNativeNotification(message)
    return
  }
  if (!(renderer as TerminalRenderer).capabilities?.notifications) return
  try {
    (renderer as TerminalRenderer).triggerNotification(message, "MeshTalk")
  } catch {}
}
