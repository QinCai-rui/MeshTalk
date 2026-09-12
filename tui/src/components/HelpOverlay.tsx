import { useKeyboard } from "@opentui/react";
import { chatTheme as theme } from "../chatTheme";

export type HelpFocus = "composer" | "history" | "dialog" | "naming";

export function helpFocusFor(state: {
  dialogOpen: boolean;
  editingName: boolean;
  scrollFocused: boolean;
}): HelpFocus {
  if (state.dialogOpen) return "dialog";
  if (state.editingName) return "naming";
  if (state.scrollFocused) return "history";
  return "composer";
}

export function helpFocusLabel(focus: HelpFocus): string {
  if (focus === "history") return "Reading history";
  if (focus === "dialog") return "Settings / dialog";
  if (focus === "naming") return "Editing display name";
  return "Composing";
}

/** Ctrl+/ arrives as "/" with ctrl, or as the 0x1F control character on some terminals. */
export function isHelpHotkey(key: {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
  raw?: string;
}): boolean {
  if (!key.ctrl) return false;
  return (
    key.name === "/" ||
    key.sequence === "\x1f" ||
    key.raw === "\x1f"
  );
}

export type HelpShortcut = { keys: string; description: string };

export type HelpSection = {
  id: string;
  title: string;
  focus: HelpFocus[];
  shortcuts: HelpShortcut[];
};

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "navigation",
    title: "Navigation",
    focus: ["composer", "history"],
    shortcuts: [
      { keys: "Ctrl+Up / Ctrl+Down", description: "Switch chats (DMs, then groups)" },
      { keys: "Ctrl+F", description: "Open friends inbox" },
      { keys: "Ctrl+P", description: "Open settings (press again to close)" },
      { keys: "Ctrl+/", description: "Open / close this help (? also closes)" },
      { keys: "Esc", description: "Close dialog, leave history, cancel reply or name edit" },
      { keys: "Ctrl+C", description: "Quit MeshTalk" },
    ],
  },
  {
    id: "composing",
    title: "Composing",
    focus: ["composer"],
    shortcuts: [
      { keys: "Enter", description: "Send message" },
      { keys: "Alt+Enter", description: "New line without sending" },
      { keys: "Ctrl+V", description: "Paste image or text from host clipboard" },
      { keys: "Ctrl+U", description: "Attach a file to the current chat" },
      { keys: "Drop / paste paths", description: "Offer file send for real local files" },
      { keys: "Esc", description: "Cancel reply target while composing" },
    ],
  },
  {
    id: "history",
    title: "History",
    focus: ["history"],
    shortcuts: [
      { keys: "PgUp / PgDn", description: "Enter history and scroll the viewport" },
      { keys: "Up / Down", description: "Select a message for reply or delete" },
      { keys: "R", description: "Reply to the selected message" },
      { keys: "D", description: "Delete selected message (Enter confirms, Esc keeps)" },
      { keys: "Enter", description: "Enlarge the selected image attachment" },
      { keys: "Home / End", description: "Jump to oldest / latest in history" },
      { keys: "Esc", description: "Back to the composer" },
    ],
  },
  {
    id: "conversations",
    title: "Conversations",
    focus: ["composer", "naming"],
    shortcuts: [
      { keys: "Ctrl+N", description: "Edit your display name (Enter saves, Esc cancels)" },
      { keys: "Alt+1…Alt+4", description: "Inline friend actions for the selected DM" },
      { keys: "Click", description: "Select a peer or group (drafts are kept per chat)" },
    ],
  },
  {
    id: "files",
    title: "Files",
    focus: ["composer", "history", "dialog"],
    shortcuts: [
      { keys: "Ctrl+U", description: "Attach a file to the current chat" },
      { keys: "Up/Down or J/K", description: "Select a file in the file list" },
      { keys: "Enter / S", description: "Save the selected file" },
      { keys: "R / L / D", description: "Refresh list, change folder, delete file" },
      { keys: "Esc", description: "Back from file list, or close image view" },
    ],
  },
  {
    id: "settings",
    title: "Settings & dialogs",
    focus: ["dialog"],
    shortcuts: [
      { keys: "Esc", description: "Close or go back (Backspace backs out without text input)" },
      { keys: "Tab", description: "Switch between categories and content" },
      { keys: "Left / Right", description: "Jump between categories rail and content" },
      { keys: "Up/Down or J/K", description: "Move selection; Enter selects or saves" },
      { keys: "1…4", description: "Friends inbox tabs (Requests / Add / Friends / Blocked)" },
      { keys: "PgUp / PgDn", description: "Scroll details text in settings panels" },
    ],
  },
  {
    id: "accessibility",
    title: "Accessibility & display",
    focus: ["composer", "history", "dialog"],
    shortcuts: [
      { keys: "Ctrl+P > Accessibility", description: "Toggle flashing warnings on or off" },
      { keys: "Mouse", description: "Click to select, scroll history, activate actions" },
      { keys: "Drag to select", description: "Copies chat text to clipboard (toast confirms)" },
      { keys: "Narrow terminals", description: "Layout stacks below 64 cols; this help scrolls" },
    ],
  },
];

export function HelpOverlay({
  width,
  height,
  focus,
  onClose,
}: {
  width: number;
  height: number;
  focus: HelpFocus;
  onClose: () => void;
}) {
  const overlayWidth = Math.max(20, Math.min(78, Math.max(1, width - 2)));
  const overlayHeight = Math.max(10, Math.min(30, Math.max(1, height - 2)));

  useKeyboard((key) => {
    if (isHelpHotkey(key) || key.name === "escape" || key.name === "?") {
      key.preventDefault();
      onClose();
    }
  });

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      backgroundColor={theme.overlay}
      alignItems="center"
      justifyContent="center"
      onMouseDown={(event) => {
        if (event.button === 0) onClose();
      }}
    >
      <box
        id="help-overlay"
        width={overlayWidth}
        height={overlayHeight}
        border
        borderColor={theme.line}
        backgroundColor={theme.surfaceRaised}
        padding={1}
        flexDirection="column"
        gap={0}
        overflow="hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <box flexDirection="row" flexShrink={0} justifyContent="space-between" gap={1}>
          <text fg={theme.accent} wrapMode="none">
            <b>Keyboard shortcuts</b>
          </text>
          <box id="help-close" onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); onClose(); } }}>
            <text fg={theme.muted} wrapMode="none">
              <u>Close [Esc]</u>
            </text>
          </box>
        </box>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          Relevant now: {helpFocusLabel(focus)}. Showing all groups.
        </text>
        <scrollbox
          id="help-content"
          focused
          style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
          contentOptions={{ flexDirection: "column", gap: 1 }}
          verticalScrollbarOptions={{
            trackOptions: { foregroundColor: theme.line, backgroundColor: theme.surfaceRaised },
          }}
        >
          {HELP_SECTIONS.map((section) => {
            const relevant = section.focus.includes(focus);
            return (
              <box key={section.id} id={`help-section-${section.id}`} flexDirection="column" flexShrink={0}>
                <text fg={relevant ? theme.accent : theme.text} wrapMode="word">
                  <b>{relevant ? `● ${section.title} — relevant now` : section.title}</b>
                </text>
                {section.shortcuts.map((shortcut) => (
                  <text key={`${section.id}-${shortcut.keys}`} fg={theme.muted} wrapMode="word">
                    <span fg={theme.accent}>{shortcut.keys}</span>
                    <span fg={theme.muted}> — {shortcut.description}</span>
                  </text>
                ))}
              </box>
            );
          })}
        </scrollbox>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          Esc / Ctrl+/ closes · PgUp/PgDn scrolls · Click outside closes
        </text>
      </box>
    </box>
  );
}
