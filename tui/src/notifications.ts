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

function escapeWinRTXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

/** Truncate and sanitize message preview for notification body (single line, ~150 chars). */
export function truncatePreview(content: string, maxLen = 150): string {
  const singleLine = content.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ").trim()
  if (singleLine.length <= maxLen) return singleLine
  return singleLine.slice(0, maxLen - 1).trimEnd() + "…"
}

async function run(command: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

async function runPowerShell(script: string): Promise<boolean> {
  // Try powershell.exe first, fall back to pwsh on newer systems
  if (await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script])) return true
  return run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script])
}

export async function sendNativeNotification(message: string, title = "MeshTalk"): Promise<boolean> {
  const os = platform()
  const safeTitle = title.trim() || "MeshTalk"
  const safeMessage = message.trim() || "New message"

  if (os === "darwin") {
    // Attempt terminal-notifier with activation so click focuses the terminal.
    // -activate tries to bring Terminal (or iTerm if user uses it) to front.
    // We try common terminal bundle IDs; system will ignore unknown ones.
    const termApps = ["com.apple.Terminal", "com.googlecode.iterm2", "com.microsoft.VSCode", "net.kovidgoyal.kitty", "com.github.wez.wezterm", "com.alacritty.Alacritty"]
    for (const bundle of termApps) {
      if (await run(["terminal-notifier", "-title", safeTitle, "-message", safeMessage, "-sound", "default", "-group", "meshtalk", "-activate", bundle, "-sender", bundle])) return true
    }
    // Generic terminal-notifier without explicit activation
    if (await run(["terminal-notifier", "-title", safeTitle, "-message", safeMessage, "-sound", "default", "-group", "meshtalk"])) return true
    // Fallback to osascript - clicking the banner in Notification Center will still show,
    // and we attempt to activate Terminal via a second osascript invocation in background.
    const ok = await run(["osascript", "-e", `display notification ${appleScriptString(safeMessage)} with title ${appleScriptString(safeTitle)} sound name "default"`])
    if (ok) {
      // Best-effort: try to make notification click more likely to focus terminal by ensuring
      // terminal-notifier is not required. We don't block on this; the notification already showed.
      void run(["osascript", "-e", 'tell application "Terminal" to activate'])
      return true
    }
    return false
  }

  if (os === "win32") {
    // Strategy 1: Windows 10+ Toast via WinRT (most native, click focuses via system)
    const winRTScript = [
      "try {",
      "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
      "  $t = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
      "  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t)",
      "  $txt = $xml.GetElementsByTagName('text')",
      `  $txt.Item(0).AppendChild($xml.CreateTextNode(${powerShellString(safeTitle)})) | Out-Null`,
      `  $txt.Item(1).AppendChild($xml.CreateTextNode(${powerShellString(safeMessage)})) | Out-Null`,
      "  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      "  $toast.Tag = 'meshtalk'",
      "  $toast.Group = 'meshtalk'",
      "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('MeshTalk').Show($toast)",
      "  exit 0",
      "} catch { exit 1 }",
    ].join("; ")
    if (await runPowerShell(winRTScript)) return true

    // Strategy 2: BurntToast module if installed (richer toasts)
    const burntScript = `try { Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text ${powerShellString(safeTitle)},${powerShellString(safeMessage)} -AppLogo $null -Sound Default | Out-Null; exit 0 } catch { exit 1 }`
    if (await runPowerShell(burntScript)) return true

    // Strategy 3: System.Windows.Forms NotifyIcon with click-to-focus (works on all Windows, no extra deps)
    const notifyIconScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }'",
      "$icon = New-Object System.Windows.Forms.NotifyIcon",
      "$icon.Icon = [System.Drawing.SystemIcons]::Information",
      "$icon.Visible = $true",
      `$icon.BalloonTipTitle = ${powerShellString(safeTitle)}`,
      `$icon.BalloonTipText = ${powerShellString(safeMessage)}`,
      "$icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info",
      "$handler = { try { $hwnd = [Win32]::GetConsoleWindow(); if ($hwnd -ne [IntPtr]::Zero) { if ([Win32]::IsIconic($hwnd)) { [Win32]::ShowWindow($hwnd, 9) | Out-Null } [Win32]::SetForegroundWindow($hwnd) | Out-Null } } catch {} }",
      "$icon.add_BalloonTipClicked($handler)",
      "$icon.ShowBalloonTip(5000)",
      "$deadline = (Get-Date).AddSeconds(6)",
      "while ((Get-Date) -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }",
      "$icon.Visible = $false",
      "$icon.Dispose()",
    ].join("; ")
    if (await runPowerShell(notifyIconScript)) return true
    return false
  }

  // Linux and other Unix: notify-send is standard via libnotify
  // Try with app-name, urgency, category, and action so click can focus (where supported)
  // --wait + --action requires libnotify >=0.8; we try modern first then fallback.
  const actions = ["default=Open MeshTalk"]
  // Modern: with action and wait - we spawn detached so click handling can run in background
  // For Bun.spawn we just check exit 0; the notification shows even if wait blocks, so use --expire-time
  // Try notify-send with hints that encourage focus
  const hints: string[] = []
  // Desktop entry hint helps window manager associate notification with app
  hints.push("--hint=string:desktop-entry:meshtalk")
  hints.push("--hint=string:category:im.received")

  // Attempt 1: notify-send with action (click will emit action, handled by wm if user clicks)
  // Use timeout 5000ms
  if (await run(["notify-send", "--app-name=MeshTalk", "--urgency=normal", "--expire-time=5000", "--icon=dialog-information", ...hints, "--action=" + actions[0], safeTitle, safeMessage])) {
    // Best-effort focus helper: try wmctrl/xdotool to raise terminal on click.
    // Since notify-send --action --wait blocks until dismissed, we don't wait here; just return true.
    // Spawn a background attempt to focus if tools exist (non-blocking)
    void (async () => {
      // Try to raise any window with MeshTalk in title after short delay, in case user clicks
      const focusScript = "for cmd in 'wmctrl -r :ACTIVE: -b add,demands_attention 2>/dev/null' 'xdotool getactivewindow windowactivate 2>/dev/null' 'wmctrl -a \"MeshTalk\" 2>/dev/null' 'xdotool search --onlyvisible --name \"MeshTalk\" windowactivate 2>/dev/null' 'xdotool search --onlyvisible --class \"meshtalk\" windowactivate 2>/dev/null'; do sh -c \"$cmd\" 2>/dev/null; done; exit 0"
      await run(["sh", "-c", focusScript])
    })()
    return true
  }
  // Attempt 2: simple notify-send without action
  if (await run(["notify-send", "--app-name=MeshTalk", "--urgency=normal", "--expire-time=5000", "--icon=dialog-information", safeTitle, safeMessage])) return true
  // Attempt 3: fallback with category only
  if (await run(["notify-send", "--app-name=MeshTalk", safeTitle, safeMessage])) return true
  // Attempt 4: try kdialog (KDE) or zenity
  if (await run(["kdialog", "--passivepopup", `${safeTitle}: ${safeMessage}`, "5"])) return true
  if (await run(["zenity", "--notification", "--text", `${safeTitle}: ${safeMessage}`])) return true
  return false
}

export async function sendTestNotification(
  delivery: Exclude<NotificationDelivery, "disabled">,
  renderer: TerminalRenderer,
): Promise<boolean> {
  if (delivery === "native") return sendNativeNotification("If you can see this, native notifications work.", "MeshTalk")
  if (!renderer.capabilities?.notifications) return false
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
  title = "MeshTalk",
): Promise<void> {
  if (!preferences?.events[event] || preferences.delivery === "disabled") return
  const body = message.trim()
  const header = title.trim() || "MeshTalk"
  if (!body) return
  if (preferences.delivery === "native") {
    const ok = await sendNativeNotification(body, header)
    if (ok) return
    // Fallback to terminal notification if native failed and terminal supports it
    if (renderer.capabilities?.notifications) {
      try {
        renderer.triggerNotification(body, header)
      } catch {}
    }
    return
  }
  // terminal delivery
  if (!renderer.capabilities?.notifications) {
    // Fallback to native if terminal not available but native might work
    await sendNativeNotification(body, header)
    return
  }
  try {
    renderer.triggerNotification(body, header)
  } catch {}
}
