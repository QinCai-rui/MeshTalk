import { DEFAULT_STATUS } from "../utils"
import { chatTheme as theme } from "../chatTheme"

export function ChatFooter({ width, scrollFocused, status, openSettings }: { width: number; scrollFocused: boolean; status: string; openSettings: () => void }) {
  const compact = width < 70
  const hint = compact
    ? [scrollFocused ? "↑↓ select · R reply · D delete · Esc" : "Enter send · PgUp · Ctrl+↑↓ chats"]
    : [scrollFocused ? "↑↓ select / R reply / D delete / Enter enlarge image / End latest / Esc compose" : "Enter send / PgUp history / Ctrl+↑↓ chats / Ctrl+U attach"]
  const notification = Boolean(status && status !== DEFAULT_STATUS)
  // Reserve the same area for hints and transient messages. Long notifications can
  // scroll within it, without moving the editor or stealing its keyboard focus.
  return <box height={width < 38 ? 5 : 3} flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
    {notification ? <box style={{ position: "relative", width: "100%", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
      <scrollbox id="chat-status" key={status} flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
        <text fg={/error|lost|exceeds/i.test(status) ? theme.danger : theme.muted} wrapMode="word">{status}</text>
      </scrollbox>
      <box style={{ position: "absolute", right: 0, bottom: 0, flexDirection: "row", justifyContent: "flex-end" }}>
        <text id="settings-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={event => { if (event.button === 0) openSettings() }}><span>Ctrl+P </span><u>settings</u></text>
      </box>
    </box> : compact ? <box style={{ position: "relative", width: "100%", height: width < 38 ? 4 : 2, flexDirection: "column", alignItems: "flex-start" }}>
      <text id="chat-hint" fg={theme.muted} style={{ marginRight: 16 }} wrapMode="word">{hint[0]}</text>
      <text id="settings-shortcut" fg={theme.accent} style={{ position: "absolute", right: 0, bottom: 0 }} wrapMode="none" onMouseDown={event => { if (event.button === 0) openSettings() }}><span>Ctrl+P </span><u>settings</u></text>
    </box> : <box style={{ position: "relative", width: "100%", height: width < 38 ? 4 : 2, flexDirection: "row", alignItems: "flex-start", gap: 1 }}>
      <text fg={theme.muted} style={{ flexGrow: 1, flexShrink: 1, marginRight: 16 }} wrapMode="word">{hint[0]}</text>
      <text id="settings-shortcut" fg={theme.accent} style={{ position: "absolute", right: 0, bottom: 0 }} wrapMode="none" onMouseDown={event => { if (event.button === 0) openSettings() }}><span>Ctrl+P </span><u>settings</u></text>
    </box>}
  </box>
}
