import { DEFAULT_STATUS } from "../utils"
import { chatTheme as theme } from "../chatTheme"

export function ChatFooter({ width, scrollFocused, status }: { width: number; scrollFocused: boolean; status: string }) {
  const compact = width < 70
  const hint = compact
    ? [scrollFocused ? "↑↓ select · R reply · D delete · Esc" : "Enter send · PgUp · Ctrl+↑↓ chats"]
    : [scrollFocused ? "↑↓ select / R reply / D delete / Enter enlarge image / End latest / Esc compose" : "Enter send / PgUp history / Ctrl+↑↓ chats / Ctrl+U attach"]
  const notification = Boolean(status && status !== DEFAULT_STATUS)
  // Reserve the same area for hints and transient messages. Long notifications can
  // scroll within it, without moving the editor or stealing its keyboard focus.
  return <box height={width < 38 ? 5 : 3} flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
    {notification ? <scrollbox id="chat-status" key={status} flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
      <text fg={/error|lost|exceeds/i.test(status) ? theme.danger : theme.muted} wrapMode="word">{status}</text>
    </scrollbox> : compact ? <box style={{ width: "100%", flexDirection: "column", alignItems: "flex-start" }}>
      <text id="chat-hint" fg={theme.muted} wrapMode="word">{hint[0]}</text>
      <text id="commands-shortcut" fg={theme.accent} wrapMode="none"><u>Ctrl+P</u> commands</text>
    </box> : <box style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 1 }}>
      <text fg={theme.muted} style={{ flexGrow: 1, flexShrink: 1 }} wrapMode="word">{hint[0]}</text>
      <text id="commands-shortcut" fg={theme.accent} style={{ flexShrink: 0 }} wrapMode="none"><u>Ctrl+P</u> commands</text>
    </box>}
  </box>
}
