import { DEFAULT_STATUS } from "../utils"
import { chatTheme as theme } from "../chatTheme"

function SettingsShortcut({ openSettings, pinned }: { openSettings: () => void; pinned?: boolean }) {
  if (pinned) {
    return <text id="settings-shortcut" fg={theme.accent} style={{ flexShrink: 0 }} wrapMode="none" onMouseDown={event => { if (event.button === 0) openSettings() }}><span>Ctrl+P </span><u>settings</u></text>
  }
  return <text id="settings-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={event => { if (event.button === 0) openSettings() }}><span>Ctrl+P </span><u>settings</u></text>
}

function HelpShortcut({ openHelp, pinned }: { openHelp: () => void; pinned?: boolean }) {
  if (pinned) {
    return <text id="help-shortcut" fg={theme.accent} style={{ flexShrink: 0 }} wrapMode="none" onMouseDown={event => { if (event.button === 0) openHelp() }}><span>Ctrl+/ </span><u>help</u></text>
  }
  return <text id="help-shortcut" fg={theme.accent} wrapMode="none" onMouseDown={event => { if (event.button === 0) openHelp() }}><span>Ctrl+/ </span><u>help</u></text>
}

function ShortcutCluster({ openSettings, onOpenHelp, pinned }: { openSettings: () => void; onOpenHelp?: () => void; pinned?: boolean }) {
  if (!onOpenHelp) return <SettingsShortcut openSettings={openSettings} pinned={pinned} />
  if (pinned) {
    return <box flexDirection="row" gap={2} flexShrink={0}>
      <HelpShortcut openHelp={onOpenHelp} pinned />
      <SettingsShortcut openSettings={openSettings} pinned />
    </box>
  }
  return <box flexDirection="row" gap={2}>
    <HelpShortcut openHelp={onOpenHelp} />
    <SettingsShortcut openSettings={openSettings} />
  </box>
}

export function ChatFooter({ width, status, openSettings, onOpenHelp }: { width: number; status: string; openSettings: () => void; onOpenHelp?: () => void }) {
  const compact = width < 70
  const notification = Boolean(status && status !== DEFAULT_STATUS)
  const statusColor = /error|lost|exceeds/i.test(status) ? theme.danger : theme.muted
  // The footer only shows transient status messages plus the help/settings
  // shortcuts — shortcut discovery lives in the help overlay. Long
  // notifications can scroll within it, without moving the editor or showing
  // a transient scrollbar.
  let footerBody
  if (notification) {
    if (compact) {
      footerBody = <box style={{ width: "100%", height: width < 38 ? 4 : 2, flexDirection: "column", alignItems: "flex-start" }}>
        <scrollbox id="chat-status" key={status} flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ visible: false, trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
          <text fg={statusColor} wrapMode="word">{status}</text>
        </scrollbox>
        <ShortcutCluster openSettings={openSettings} onOpenHelp={onOpenHelp} />
      </box>
    } else {
      footerBody = <box style={{ width: "100%", height: 2, flexDirection: "row", alignItems: "stretch", gap: 1 }}>
        <scrollbox id="chat-status" key={status} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }} minHeight={0} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ visible: false, trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
          <text fg={statusColor} wrapMode="word">{status}</text>
        </scrollbox>
        <ShortcutCluster openSettings={openSettings} onOpenHelp={onOpenHelp} pinned />
      </box>
    }
  } else if (compact) {
    footerBody = <box style={{ width: "100%", flexDirection: "column", alignItems: "flex-start" }}>
      <ShortcutCluster openSettings={openSettings} onOpenHelp={onOpenHelp} />
    </box>
  } else {
    footerBody = <box style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 1 }}>
      <box style={{ flexGrow: 1, flexShrink: 1 }} />
      <ShortcutCluster openSettings={openSettings} onOpenHelp={onOpenHelp} pinned />
    </box>
  }
  return <box height={width < 38 ? 5 : 3} flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
    {footerBody}
  </box>
}
