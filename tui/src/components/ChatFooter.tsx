import { DEFAULT_STATUS } from "../utils"
import { chatTheme as theme } from "../chatTheme"

function SettingsShortcut({ openSettings, pinned }: { openSettings: () => void; pinned?: boolean }) {
  if (pinned) {
    return <text id="settings-shortcut" fg={theme.accent} style={{ flexShrink: 0 }} wrapMode="none" onMouseDown={event => { if (event.button === 0) openSettings() }}><span>Ctrl+P </span><u>settings</u></text>
  }
  return <text id="settings-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={event => { if (event.button === 0) openSettings() }}><span>Ctrl+P </span><u>settings</u></text>
}

export function ChatFooter({ width, scrollFocused, status, openSettings }: { width: number; scrollFocused: boolean; status: string; openSettings: () => void }) {
  const compact = width < 70
  const hint = compact
    ? [scrollFocused ? "↑↓ select · R reply · D delete · Esc" : "Enter send · PgUp · Ctrl+↑↓ chats"]
    : [scrollFocused ? "↑↓ select / R reply / D delete / Enter enlarge image / End latest / Esc compose" : "Enter send / PgUp history / Ctrl+↑↓ chats / Ctrl+U attach / Drop files to send"]
  const notification = Boolean(status && status !== DEFAULT_STATUS)
  const statusColor = /error|lost|exceeds/i.test(status) ? theme.danger : theme.muted
  // Reserve the same area for hints and transient messages. Long notifications can
  // scroll within it, without moving the editor or showing a transient scrollbar.
  let footerBody
  if (notification) {
    if (compact) {
      footerBody = <box style={{ width: "100%", height: width < 38 ? 4 : 2, flexDirection: "column", alignItems: "flex-start" }}>
        <scrollbox id="chat-status" key={status} flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ visible: false, trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
          <text fg={statusColor} wrapMode="word">{status}</text>
        </scrollbox>
        <SettingsShortcut openSettings={openSettings} />
      </box>
    } else {
      footerBody = <box style={{ width: "100%", height: 2, flexDirection: "row", alignItems: "stretch", gap: 1 }}>
        <scrollbox id="chat-status" key={status} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }} minHeight={0} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ visible: false, trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
          <text fg={statusColor} wrapMode="word">{status}</text>
        </scrollbox>
        <SettingsShortcut openSettings={openSettings} pinned />
      </box>
    }
  } else if (compact) {
    footerBody = <box style={{ width: "100%", flexDirection: "column", alignItems: "flex-start" }}>
      <text id="chat-hint" fg={theme.muted} wrapMode="word">{hint[0]}</text>
      <SettingsShortcut openSettings={openSettings} />
    </box>
  } else {
    footerBody = <box style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 1 }}>
      <text fg={theme.muted} style={{ flexGrow: 1, flexShrink: 1 }} wrapMode="word">{hint[0]}</text>
      <SettingsShortcut openSettings={openSettings} pinned />
    </box>
  }
  return <box height={width < 38 ? 5 : 3} flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
    {footerBody}
  </box>
}
