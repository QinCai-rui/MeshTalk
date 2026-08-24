"""Cross-platform native desktop notifications for the backend daemon.

Works on Windows, macOS, and Linux even when the TUI is minimized, unfocused,
or not running. Clicking the notification attempts to bring the MeshTalk window
to the front.
"""

from __future__ import annotations

import logging
import platform
import shutil
import subprocess
import sys

logger = logging.getLogger(__name__)


def truncate_preview(content: str, max_len: int = 150) -> str:
    single = content.replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()
    if len(single) <= max_len:
        return single
    return single[: max_len - 1].rstrip() + "…"


def _ps_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _applescript_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _run(cmd: list[str], timeout: int = 7) -> bool:
    try:
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
        return result.returncode == 0
    except Exception as exc:  # noqa: BLE001
        logger.debug("notify run failed %s: %s", cmd[:2], exc)
        return False


def _run_powershell(script: str, timeout: int = 8) -> bool:
    # powershell.exe is older but always present on Windows; pwsh is newer
    for exe in ("powershell.exe", "pwsh"):
        if shutil.which(exe) and _run([exe, "-NoProfile", "-NonInteractive", "-Command", script], timeout=timeout):
            return True
    return False


def send_notification(title: str, body: str) -> bool:
    """Show a native OS notification. Returns True if one method succeeded."""
    title = (title or "MeshTalk").strip() or "MeshTalk"
    body = (body or "New message").strip() or "New message"
    system = platform.system().lower()

    # Windows
    if system == "windows" or sys.platform == "win32":
        # 1. WinRT Toast (Windows 10+) — most native, click is handled by OS
        winrt = "; ".join(
            [
                "try {",
                "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
                "  $t = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
                "  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t)",
                "  $txt = $xml.GetElementsByTagName('text')",
                f"  $txt.Item(0).AppendChild($xml.CreateTextNode({_ps_string(title)})) | Out-Null",
                f"  $txt.Item(1).AppendChild($xml.CreateTextNode({_ps_string(body)})) | Out-Null",
                "  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
                "  $toast.Tag = 'meshtalk'",
                "  $toast.Group = 'meshtalk'",
                "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('MeshTalk').Show($toast)",
                "  exit 0",
                "} catch { exit 1 }",
            ]
        )
        if _run_powershell(winrt):
            return True

        # 2. BurntToast module if installed
        burnt = f"try {{ Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text {_ps_string(title)},{_ps_string(body)} -AppLogo $null -Sound Default | Out-Null; exit 0 }} catch {{ exit 1 }}"
        if _run_powershell(burnt):
            return True

        # 3. NotifyIcon balloon with click-to-restore (works on all Windows, no deps)
        # Uses Win32 API to restore and foreground the terminal window when clicked.
        icon_script = "; ".join(
            [
                "Add-Type -AssemblyName System.Windows.Forms",
                "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }'",
                "$icon = New-Object System.Windows.Forms.NotifyIcon",
                "$icon.Icon = [System.Drawing.SystemIcons]::Information",
                "$icon.Visible = $true",
                f"$icon.BalloonTipTitle = {_ps_string(title)}",
                f"$icon.BalloonTipText = {_ps_string(body)}",
                "$icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info",
                "$handler = { try { $hwnd = [Win32]::GetConsoleWindow(); if ($hwnd -ne [IntPtr]::Zero) { if ([Win32]::IsIconic($hwnd)) { [Win32]::ShowWindow($hwnd, 9) | Out-Null } [Win32]::SetForegroundWindow($hwnd) | Out-Null } try { $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*MeshTalk*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null } } catch {} } catch {} }",
                "$icon.add_BalloonTipClicked($handler)",
                "$icon.ShowBalloonTip(5000)",
                "$deadline = (Get-Date).AddSeconds(6)",
                "while ((Get-Date) -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }",
                "$icon.Visible = $false",
                "$icon.Dispose()",
            ]
        )
        if _run_powershell(icon_script, timeout=10):
            return True
        return False

    # macOS
    if system == "darwin":
        # Try terminal-notifier with -activate for common terminals so click focuses
        terms = [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "com.microsoft.VSCode",
            "net.kovidgoyal.kitty",
            "com.github.wez.wezterm",
            "com.alacritty.Alacritty",
        ]
        for bundle in terms:
            if shutil.which("terminal-notifier") and _run(
                ["terminal-notifier", "-title", title, "-message", body, "-sound", "default", "-group", "meshtalk", "-activate", bundle, "-sender", bundle]
            ):
                return True
        if shutil.which("terminal-notifier") and _run(
            ["terminal-notifier", "-title", title, "-message", body, "-sound", "default", "-group", "meshtalk"]
        ):
            return True
        # Fallback to osascript — click still shows but we also try to activate Terminal
        if _run(["osascript", "-e", f"display notification {_applescript_string(body)} with title {_applescript_string(title)} sound name \"default\""]):
            # best-effort activate
            subprocess.Popen(["osascript", "-e", 'tell application "Terminal" to activate'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        return False

    # Linux / Unix
    hints = ["--hint=string:desktop-entry:meshtalk", "--hint=string:category:im.received"]
    # Try with action so click can be detected (requires libnotify >=0.8)
    if shutil.which("notify-send") and _run(
        ["notify-send", "--app-name=MeshTalk", "--urgency=normal", "--expire-time=5000", "--icon=dialog-information", *hints, "--action=default=Open MeshTalk", title, body]
    ):
        # best-effort focus helpers (non-blocking)
        try:
            subprocess.Popen(
                ["sh", "-c", "for c in 'wmctrl -a \"MeshTalk\" 2>/dev/null' 'xdotool search --onlyvisible --name \"MeshTalk\" windowactivate 2>/dev/null' 'wmctrl -r :ACTIVE: -b add,demands_attention 2>/dev/null'; do sh -c \"$c\" 2>/dev/null; done; exit 0"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
        return True
    if shutil.which("notify-send") and _run(
        ["notify-send", "--app-name=MeshTalk", "--urgency=normal", "--expire-time=5000", "--icon=dialog-information", title, body]
    ):
        return True
    if shutil.which("notify-send") and _run(["notify-send", "--app-name=MeshTalk", title, body]):
        return True
    if shutil.which("kdialog") and _run(["kdialog", "--passivepopup", f"{title}: {body}", "5"]):
        return True
    if shutil.which("zenity") and _run(["zenity", "--notification", "--text", f"{title}: {body}"]):
        return True
    return False
