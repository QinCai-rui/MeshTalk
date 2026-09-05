# Main chat design

MeshTalk uses a quiet workspace: a slate conversation rail, an open message history,
and a slightly raised composer. A restrained mint accent marks selection and actions.
The design deliberately avoids message bubbles, nested borders, moving status text,
and icons that require a particular terminal font. Typing retains the original animated dots. The main chat and file manager share this treatment;
settings, settings, and notifications use a centered settings panel. Startup retains
its existing UI.

## Layout and hierarchy

- At 100 columns and above the conversation rail is 30 columns; from 64–99 it is 25.
- Below 64 columns, navigation becomes a six-row strip above the full-width chat.
  The selected conversation scrolls into view after layout. Long list names shorten
  with `...`; the selected conversation's full name wraps in the chat header.
- MeshTalk displays the release version beside its title. DMs and groups have a
  plain section labels and separate scroll areas: DMs receive 60% of the available
  navigation height and groups receive 40%. Each section keeps its own scrollbar
  and brings the selected conversation into view. Unread counts have their own
  space beside the name.
- Each DM entry is a contiguous two-row target: the name, presence colour, and
  friend/request markers appear first; indented unread count, muted/limited
  state, and typing dots use the second row. Group rows show their member count
  beside the name, with a permanently reserved indented second row for unread
  activity or typing. This keeps group rows from shifting when activity arrives.
- Sidebar peers use the original green/amber/gray presence colours and heart/request
  arrow markers. The conversation header retains textual state labels; muted state,
  capability limits, and delivery state still use words. Selected rows and the active composer also have a plain `>` marker.
- The header holds the conversation name and connection/state details. Endpoint
  addresses and long relay descriptions simplify when space is limited.
- History retains Markdown, dates, reply navigation, delivery details, attachments,
  image previews, selection, scrolling, and unread highlights. Connection/delivery
  warnings remain outside the scrolling history and use static text.
- Typing, reply context, input, byte usage, and keyboard help each occupy their own
  layout rows. Temporary status messages replace keyboard hints in a fixed-height footer; long messages scroll inside that area without moving the composer. The footer aligns composer/history hints left and the highlighted settings shortcut right. Nothing is absolutely positioned over editable text.
- The chat pane receives its actual available width. Its zero flex basis prevents
  an old horizontal layout measurement from pushing the composer offscreen on resize.

## File manager

- The file manager uses the same slate canvas, raised surfaces, mint selection,
  muted supporting text, and plain `>` focus marker as the chat screen.
- Filters are compact text tabs rather than a row of bordered buttons. The file
  list scrolls independently and keeps keyboard and mouse selection intact.
- At 92 columns and above, the selected transfer opens in a detail pane beside
  the list. Narrow terminals use one column and reveal the selected file path and
  image preview within its row, preserving readable file names.
- Transfer rows show peer display names when available and fall back to the first
  eight characters of an unknown ID. Group transfers use the group name when it
  is available.
- Save, delete, location, refresh, and back controls stay in a fixed footer.
  Transfer progress and unavailable-file states remain visible without relying on
  color alone. Delete confirmation is the only bordered surface on this screen.

## Existing keyboard behavior

Settings open in a centered panel capped at 100 columns and 32 rows, with space
around the dialog. Wide panels have a category rail beside the content pane.
Narrow panels expose the same categories with Tab. First-run setup stays in its
own flow without category navigation. Preferences show explicit On, Off, Current,
and connection states, with wrapped descriptions and scrollable help.

Within settings, Tab switches category/content focus, arrows or J/K select rows,
Enter activates, and Escape follows the existing Back route. Backspace also
goes back outside text editors. PgUp/PgDn scroll menu help. Editors retain their
draft when categories gain focus. Destructive confirmations initially select
Cancel. All settings colours come from chatTheme.ts.

`ChatApp.tsx` remains the authority for global keys.

| Key | Action / context |
| --- | --- |
| Ctrl+P | Open or close settings |
| Ctrl+Up/Down | Switch peer/group conversation |
| Ctrl+N | Edit display name |
| Ctrl+U | Open file picker |
| Ctrl+V (also platform Meta/Super+V) | Clipboard/image paste in composer |
| Ctrl+D | Remove selected peer through existing action |
| Enter / Alt+Enter | Send / insert newline in composer |
| PgUp/PgDn | Focus and scroll history |
| Up/Down | Select a message or file while reading history |
| R / D | Reply / request deletion of selected history item |
| Enter | Open a selected image while reading history |
| Home / End | First / latest history while history is focused |
| Escape | Existing dialog, rename, reply, and deletion cancellation |
| Ctrl+C | Renderer exit |

Mouse selection, drag-to-select, scrolling, and existing detail/preview actions remain.
Draft ownership, sending, limits, resizing, clipboard integration, and IPC contracts
remain in their existing orchestration and action modules.

## Verification

Run from the repository root:

```sh
bun test tui/src/components/MainChat.test.tsx tui/src/components/FileManager.test.tsx tui/src/components/ImageAttachment.test.tsx
bun tui/node_modules/typescript/bin/tsc --noEmit -p tui/tsconfig.json
```

The OpenTUI tests render the actual components at 32, 48, 64, 80, and 120 columns,
exercise resize to 48×24, and cover selection visibility, textual states, drafts,
paste/newline/send, dialog focus, queued messages, replies, delivery metadata,
attachment rendering, unread visibility, file-manager breakpoints, peer-name
resolution, and file actions. Markdown worker completion is awaited
separately from initial layout. Fixtures do not connect to the backend or send messages.
Native image-protocol behavior still requires a supporting terminal; the existing
image tests exercise the block-rendering fallback and preview navigation.
