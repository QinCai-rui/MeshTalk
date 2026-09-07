import { DEFAULT_STATUS } from "../utils"
import { chatTheme as theme } from "../chatTheme"

export type ChatFooterActions = {
  openSettings: () => void
  openAttach?: () => void
  openFiles?: () => void
  openFriends?: () => void
  openGroups?: () => void
}

export function ChatFooter({ width, scrollFocused, status, openSettings, openAttach, openFiles, openFriends, openGroups }: { width: number; scrollFocused: boolean; status: string } & ChatFooterActions) {
  const compact = width < 70
  const veryNarrow = width < 38
  const hint = compact
    ? [scrollFocused ? "↑↓ select · R reply · D delete · Esc" : "Enter send · PgUp · Ctrl+↑↓ chats"]
    : [scrollFocused ? "↑↓ select / R reply / D delete / Enter enlarge image / End latest / Esc compose" : "Enter send / PgUp history / Ctrl+↑↓ chats / Ctrl+U attach"]
  const notification = Boolean(status && status !== DEFAULT_STATUS)
  const doAttach = openAttach ?? (() => {})
  const doFiles = openFiles ?? (() => {})
  const doFriends = openFriends ?? (() => {})
  const doGroups = openGroups ?? (() => {})
  const click = (fn: () => void) => (event: { button: number }) => { if (event.button === 0) fn() }
  const separator = <text fg={theme.muted} wrapMode="none"> · </text>
  // Wide terminals show keyboard prefixes for discoverability; compact ones
  // drop the prefixes to fit the same five actions in one row.
  const attachButton = <text id="attach-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={click(doAttach)}>{compact ? <u>attach</u> : <><span>Ctrl+U </span><u>attach</u></>}</text>
  const filesButton = <text id="files-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={click(doFiles)}><u>files</u></text>
  const friendsButton = <text id="friends-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={click(doFriends)}><u>friends</u></text>
  const groupsButton = <text id="groups-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={click(doGroups)}><u>groups</u></text>
  const settingsButton = <text id="settings-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={click(openSettings)}><span>Ctrl+P </span><u>settings</u></text>
  // Reserve the same area for hints and transient messages. Long notifications can
  // scroll within it, without moving the editor or stealing its keyboard focus.
  // Height covers hint + one button row (two button rows when very narrow).
  const height = veryNarrow ? 6 : 4
  if (notification) {
    return <box height={height} flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <scrollbox id="chat-status" key={status} flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
        <text fg={/error|lost|exceeds/i.test(status) ? theme.danger : theme.muted} wrapMode="word">{status}</text>
      </scrollbox>
    </box>
  }
  if (compact) {
    return <box height={height} flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box style={{ width: "100%", flexDirection: "column", alignItems: "flex-start" }}>
        <text id="chat-hint" fg={theme.muted} wrapMode="word">{hint[0]}</text>
        <box style={{ flexDirection: "row", alignItems: "flex-start", gap: 1 }}>
          {attachButton}{separator}{filesButton}{separator}{friendsButton}
        </box>
        <box style={{ flexDirection: "row", alignItems: "flex-start", gap: 1 }}>
          {groupsButton}{separator}{settingsButton}
        </box>
      </box>
    </box>
  }
  return <box height={height} flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
    <box style={{ width: "100%", flexDirection: "column", alignItems: "flex-start" }}>
      <text id="chat-hint" fg={theme.muted} wrapMode="word">{hint[0]}</text>
      <box style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 1 }}>
        {attachButton}{separator}{filesButton}{separator}{friendsButton}{separator}{groupsButton}{separator}{settingsButton}
      </box>
    </box>
  </box>
}
