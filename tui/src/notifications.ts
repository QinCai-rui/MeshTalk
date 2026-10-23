import { platform } from "os"
import { terminalText } from "../../common/terminal-text"

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

export function windowsNotificationCommand(message: string, title: string): string[] {
  // Only base64's ASCII alphabet enters script syntax. Decoded peer text is
  // passed to the notification API, never evaluated as PowerShell source.
  const data = Buffer.from(JSON.stringify([title, message]), "utf8").toString("base64")
  const script = [
    `$data = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${data}')))`,
    "Add-Type -AssemblyName System.Windows.Forms",
    "$icon = New-Object System.Windows.Forms.NotifyIcon",
    "$icon.Icon = [System.Drawing.SystemIcons]::Information",
    "$icon.Visible = $true",
    "$icon.ShowBalloonTip(5000, $data[0], $data[1], [System.Windows.Forms.ToolTipIcon]::Info)",
    "Start-Sleep -Seconds 6",
    "$icon.Dispose()",
  ].join("; ")
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
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
    command = windowsNotificationCommand(message, title)
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
  dndEnabled = false,
): Promise<void> {
  if (dndEnabled) return
  if (!preferences?.events[event] || preferences.delivery === "disabled") return
  if (preferences.delivery === "native") {
    await sendNativeNotification(message)
    return
  }
  if (!renderer.capabilities?.notifications) return
  try {
    renderer.triggerNotification(terminalText(message, false), "MeshTalk")
  } catch {}
}
