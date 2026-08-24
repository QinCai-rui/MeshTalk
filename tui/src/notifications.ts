import { platform } from "os"

export type NotificationDelivery = "terminal" | "native" | "disabled"
export type NotificationEvent = "messages" | "friend_requests" | "file_offers" | "file_completed"

export type NotificationPreferences = {
  setup_dismissed: boolean
  delivery: NotificationDelivery
  events: Record<NotificationEvent, boolean>
}

type TerminalRenderer = {
  capabilities?: { notifications?: boolean } | null
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
  renderer: TerminalRenderer,
): Promise<boolean> {
  if (delivery === "native") return sendNativeNotification("If you can see this, native notifications work.")
  if (!renderer.capabilities?.notifications) return false
  // Terminals commonly suppress OSC notifications while their own tab is focused.
  // Give the user time to switch tabs before testing the terminal protocol.
  await new Promise<void>((resolve) => setTimeout(resolve, 4_000))
  try {
    return renderer.triggerNotification("If you can see this, terminal notifications work.", "MeshTalk") !== false
  } catch {
    return false
  }
}

export async function notify(
  preferences: NotificationPreferences | null,
  event: NotificationEvent,
  renderer: TerminalRenderer,
  message: string,
): Promise<void> {
  if (!preferences?.events[event] || preferences.delivery === "disabled") return
  if (preferences.delivery === "native") {
    await sendNativeNotification(message)
    return
  }
  if (!renderer.capabilities?.notifications) return
  try {
    renderer.triggerNotification(message, "MeshTalk")
  } catch {}
}
