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

## Desktop interface

The chat window has a conversation sidebar and a message area. The sidebar
contains Chats and Groups filters, an unread filter, search, and a New conversation
button. People and Files remain accessible below the conversation list.

Settings occupy the app window and use the native dialog's focus handling.
The sections are Profile, Appearance, Notifications, Privacy, People, Rooms,
Connection, Diagnostics, and About. Connection exposes the control server URL,
remote discovery status, public endpoint, STUN server, and address pinning.
Appearance supports system, light, and dark themes with teal or blue accents.
Theme and accent preferences belong to the desktop frontend.

## Design demo

The development server supports `/?demo=teal` and `/?demo=blue` in a browser.
The demo uses in-memory sample data and session storage rather than desktop
preferences. It cannot access the backend, local identity, attachments, or native
desktop actions. The demo is disabled inside Tauri and excluded from production
builds. Its switches and forms update only sample data.

`desktop/tests/redesign.spec.ts` covers the demo, settings saves and errors,
keyboard dismissal, focus restoration, and narrow settings layouts.
`desktop/tests/messenger.spec.ts` covers the Tauri IPC bridge, legacy backend
compatibility, sending, appearance persistence, and narrow chat layouts.
