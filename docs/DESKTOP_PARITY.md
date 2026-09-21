# Desktop client parity

The Tauri desktop app is a peer of the TUI, not a reduced viewer. This matrix
tracks applicable user-facing functionality. Terminal-renderer details are
adapted to native desktop equivalents.

| Area | Desktop surface |
| --- | --- |
| DMs, groups, replies, typing, queues, delivery states | Conversation list, history, composer, and delivery panels |
| Keyboard operation | Native app menu, quick switcher, shortcut reference, focus-visible controls |
| Friend requests, friends, blocked peers | **People** inbox with Requests, Add friend, Friends, and Blocked tabs |
| Rooms and groups | Create/join dialogs, context actions, invite share sheet, group details and roster |
| Mentions | `@` completion in the group composer, mention badges, highlighted rendered mentions |
| Local message management | Copy, reply, local delete confirmation, date boundaries, history paging, local encrypted search |
| Files | Native picker, drag/drop, clipboard staging, confirmation, per-recipient retry, preview, Save As, and Files & transfers manager |
| Notifications | Native delivery selection/test, event controls, DND, timed per-conversation mute, generic privacy-preserving text |
| Connection and diagnostics | Connection status, public endpoint, diagnostics, peer endpoints, re-STUN, and DNS pinning |
| Preferences | Profile, appearance/system theme, launch at login, tray behavior, motion/accessibility, analytics, download directory, and update channel |
| Updates | Signed updater integration is included but deliberately inactive until a public key, HTTPS endpoint, and CI signing secrets are configured. |

## Platform adaptations

The desktop client intentionally does not expose terminal image protocol
selection, terminal notification delivery, terminal splash styles, or
terminal-column layout choices. It replaces them with native image previews,
operating-system notifications, normal desktop launch behavior, and responsive
window layouts.

New local desktop IPC calls (`search_messages`, `history_page`, and
`desktop_drafts`) are documented in `PROTOCOL.md`; they neither alter the
peer-to-peer wire protocol nor send new data to the control service.
