import { expect, test } from "bun:test"
import { act, createRef, useState, type ComponentProps } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { Sidebar } from "./Sidebar"
import { ConversationPanel } from "./ConversationPanel"
import { chatLayout, chatTheme } from "../chatTheme"
import { DEFAULT_STATUS, MAX_MESSAGE_BYTES } from "../utils"
import type { Peer } from "../types"

const noop = () => {}
const peers: Peer[] = [
  { peer_id: "alex", display_name: "Alex Morgan", is_online: 1, presence: "active", last_seen: 0, last_interaction: 0, unread_count: 3, is_friend: true, active_transport: "lan_tcp", endpoints: [] },
  { peer_id: "sam", display_name: "Sam Chen", is_online: 0, presence: "offline", last_seen: 0, last_interaction: 0, unread_count: 0, endpoints: [] },
]
const group = { group_id: "team", name: "Design studio", member_count: 4, unread_count: 2 }
function sidebarProps(width: number): ComponentProps<typeof Sidebar> {
  return { appVersion: "0.23.0", compact: width < 100, ...chatLayout(width), dialogOpen: false, editingName: false, groups: [group], groupMembers: {}, identity: { peer_id: "me", display_name: "Taylor" }, mutedPeers: {}, nameDraft: "", peers, selectedPeerId: "alex", selectedGroupId: undefined, typingConversationKeys: new Set(), openGroupDetails: noop, setEditingName: noop, setNameDraft: noop, setSelection: noop, setScrollFocused: noop, saveDisplayName: noop }
}
function panelProps(width: number): ComponentProps<typeof ConversationPanel> {
  return {
    width, compact: width < 70, controlStatus: { connected: true, reconnect_attempts: 0 },
    conversationItems: [
      { type: "message", createdAt: 1788580800, message: { message_id: "m1", sender_id: "alex", content: "I shared the **updated notes**. What do you think?", created_at: 1788580800 } },
      { type: "message", createdAt: 1788580860, message: { message_id: "m2", sender_id: "me", content: "Looks good. The simpler layout makes it much easier to read.", created_at: 1788580860, delivered: 1 } },
    ],
    deliveredMessageIds: new Set(), dialogOpen: false, draftLength: 0, drafts: {}, flashingEnabled: false, blinkOn: true, composerHeight: 3, composerRef: createRef<TextareaRenderable>(), groupMembers: {}, identity: { peer_id: "me", display_name: "Taylor" }, imageProtocol: "blocks", limitedGroupMembers: [], capabilityGapMessage: "", isSending: false, limitColor: undefined, mutedPeers: {}, peers, selected: peers[0], selectedGroup: undefined, selectedGroupId: undefined, selectedHasCapabilityGap: false, selectedReplyTargetId: undefined, replyTo: undefined, selectionKey: "peer:alex", unreadMessageStates: {}, unreadNow: 0, markUnreadMessageVisible: noop, openImage: noop, openDeliveryDetails: noop, typingNames: [], editingName: false, scrollFocused: false, scrollboxRef: createRef<ScrollBoxRenderable>(), status: DEFAULT_STATUS, setComposerHeight: noop, setDraftLength: noop, setScrollFocused: noop, selectReplyTarget: noop, clearReplyTarget: noop, onComposerChange: noop, send: noop,
  }
}
// Markdown's worker initializes asynchronously, independently of the renderer scheduler.
async function settle(setup: Awaited<ReturnType<typeof testRender>>, visibleText?: string) {
  let frame = ""
  for (let attempt = 0; attempt < 20; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); await setup.renderOnce() })
    frame = setup.captureCharFrame()
    if (!visibleText || frame.includes(visibleText)) return frame
  }
  throw new Error(`Markdown did not settle: ${frame}`)
}

async function close(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy())
}

for (const width of [120, 80, 64, 48, 32]) {
  test(`main chat fits ${width} columns with readable navigation and composer`, async () => {
    const { stacked, panelWidth } = chatLayout(width)
    const props = panelProps(panelWidth)
    const setup = await testRender(<box width={width} height={30} backgroundColor={chatTheme.canvas} gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}><Sidebar {...sidebarProps(width)} /><ConversationPanel {...props} /></box>, { width, height: 30 })
    try {
      const frame = await settle(setup, "Looks good")
      expect(frame).toContain("Alex Morgan")
      expect(frame).toContain("3 new")
      expect(frame).toContain("MeshTalk 0.23.0")
      expect(frame.match(/Ctrl\+P commands/g)?.length).toBe(1)
      if (width >= 64) expect(frame.match(/Ctrl\+Up\/Down switch/g)?.length).toBe(1)
      expect(frame).toContain("Write a message...")
      expect(frame).toContain("30,720 bytes")
      expect(frame).toContain("Ctrl+P commands")
      const commandsShortcut = setup.renderer.root.findDescendantById("commands-shortcut")!
      expect(commandsShortcut).toBeDefined()
      expect(commandsShortcut.screenX).toBeGreaterThan(props.composerRef.current!.screenX)
      expect(frame).not.toContain("PgUp/PgDn history")
      expect(frame).not.toContain("Drag text to select")
      expect(props.composerRef.current!.screenX + props.composerRef.current!.width).toBeLessThanOrEqual(width)
      expect(props.composerRef.current!.screenY + props.composerRef.current!.height).toBeLessThanOrEqual(30)
      expect(props.scrollboxRef.current!.viewport.height).toBeGreaterThan(2)
    } finally { await close(setup) }
  })
}

test("sidebar uses friend/request markers and mouse selection retains the conversation contract", async () => {
  let selection: unknown
  const props = sidebarProps(120)
  props.peers = [{ ...peers[0]!, presence: "away", capability_gap: true, friend_request: "both" }]
  props.mutedPeers = { alex: 1 }
  props.setSelection = value => { selection = value }
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Groups (1)")
    expect(frame).not.toContain("──── Groups")
    for (const label of ["♥", "↙", "↗", "Limited", "Muted", "3 new"]) expect(frame).toContain(label)
    for (const label of ["Away", "Offline", "Friend", "Request received", "Request sent"]) expect(frame).not.toContain(label)
    const row = setup.renderer.root.findDescendantById("nav-peer-alex")!
    await act(async () => { await setup.mockMouse.click(row.screenX + 1, row.screenY) })
    expect(selection).toEqual({ kind: "peer", id: "alex" })
  } finally { await close(setup) }
})

test("sidebar peers use contiguous two-line click targets", async () => {
  const props = sidebarProps(120)
  props.peers = Array.from({ length: 3 }, (_, index) => ({ ...peers[0]!, peer_id: `peer-${index}`, display_name: `Peer ${index}`, unread_count: 0, is_friend: false }))
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    await settle(setup)
    const rows = props.peers.map(peer => setup.renderer.root.findDescendantById(`nav-peer-${peer.peer_id}`)!)
    expect(rows.every(row => row.height === 2)).toBe(true)
    expect(rows[0]!.screenY + rows[0]!.height).toBe(rows[1]!.screenY)
    expect(rows[1]!.screenY + rows[1]!.height).toBe(rows[2]!.screenY)
  } finally { await close(setup) }
})

test("sidebar groups reserve a second line before unread activity arrives", async () => {
  const props = sidebarProps(120)
  props.selectedPeerId = undefined
  props.groups = Array.from({ length: 3 }, (_, index) => ({ ...group, group_id: `group-${index}`, name: `Group ${index}`, unread_count: 0 }))
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    await settle(setup)
    const rows = props.groups.map(item => setup.renderer.root.findDescendantById(`nav-group-${item.group_id}`)!)
    expect(rows.every(row => row.height === 2)).toBe(true)
    expect(rows[0]!.screenY + rows[0]!.height).toBe(rows[1]!.screenY)
    expect(rows[1]!.screenY + rows[1]!.height).toBe(rows[2]!.screenY)
  } finally { await close(setup) }
})

test("selected groups remain visible in the collapsed list", async () => {
  const props = sidebarProps(48)
  props.peers = Array.from({ length: 20 }, (_, i) => ({ ...peers[0]!, peer_id: `peer-${i}` }))
  props.selectedPeerId = undefined
  props.selectedGroupId = group.group_id
  const setup = await testRender(<Sidebar {...props} />, { width: 48, height: 8 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Design studio")
  } finally { await close(setup) }
})

test("sidebar indents unread detail beneath peer and group labels", async () => {
  const props = sidebarProps(120)
  props.peers = [{ ...peers[0]!, display_name: "Raymont", unread_count: 1 }]
  props.groups = [{ ...group, name: "The people", member_count: 8, unread_count: 1 }]
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Raymont")
    expect(frame).toContain("The people (8 members)")
    expect(frame).toMatch(/\n\s{3,}1 new/)
  } finally { await close(setup) }
})

test("the sidebar reserves 60% for DMs and 40% for groups, with independent scrolling", async () => {
  const props = sidebarProps(120)
  props.peers = Array.from({ length: 40 }, (_, index) => ({ ...peers[0]!, peer_id: `peer-${index}`, display_name: `Peer ${index}` }))
  props.groups = Array.from({ length: 40 }, (_, index) => ({ ...group, group_id: `group-${index}`, name: `Group ${index}` }))
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    await settle(setup)
    const dmSection = setup.renderer.root.findDescendantById("sidebar-dm-section")!
    const groupSection = setup.renderer.root.findDescendantById("sidebar-group-section")!
    expect(Math.abs(dmSection.height / (dmSection.height + groupSection.height) - 0.6)).toBeLessThan(0.06)

    const dmList = setup.renderer.root.findDescendantById("sidebar-dms") as ScrollBoxRenderable
    const groupList = setup.renderer.root.findDescendantById("sidebar-groups") as ScrollBoxRenderable
    expect(dmList.scrollHeight).toBeGreaterThan(dmList.viewport.height)
    expect(groupList.scrollHeight).toBeGreaterThan(groupList.viewport.height)
    await act(async () => {
      dmList.scrollTo(dmList.scrollHeight)
      groupList.scrollTo(groupList.scrollHeight)
    })
    expect(dmList.scrollTop).toBeGreaterThan(0)
    expect(groupList.scrollTop).toBeGreaterThan(0)
  } finally { await close(setup) }
})

test("composer restores its draft, accepts paste and Alt+Enter, and submits with Enter", async () => {
  const props = panelProps(70)
  props.drafts = { "peer:alex": "Saved draft" }
  let submitted = 0
  let content = ""
  props.send = () => { submitted++ }
  props.onComposerChange = value => { content = value }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 70, height: 26 })
  try {
    await settle(setup)
    expect(props.composerRef.current!.plainText).toBe("Saved draft")
    await act(async () => { setup.mockInput.pressEnter({ meta: true }); setup.mockInput.pasteBracketedText("pasted text") })
    await settle(setup)
    expect(content).toContain("\npasted text")
    expect(submitted).toBe(0)
    await act(async () => { setup.mockInput.pressEnter() })
    expect(submitted).toBe(1)
  } finally { await close(setup) }
})

test("offline notices, replies, typing, and byte limits have separate readable rows", async () => {
  const props = panelProps(48)
  props.selected = { ...peers[1]!, delivery_warnings: ["offline"] }
  props.draftLength = MAX_MESSAGE_BYTES + 1
  props.typingNames = ["A very long participant display name that should not hide the typing state"]
  props.replyTo = { id: "m1", senderId: "alex", label: "Updated notes", kind: "message" }
  props.conversationItems[1] = { type: "message", createdAt: 1788580860, message: { message_id: "queued", sender_id: "me", content: "For later", created_at: 1788580860, queued: 1 } }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 48, height: 30 })
  try {
    const frame = await settle(setup)
    for (const label of ["Offline: messages queue", "queued until online", "stored and queued", "cancels)", "Too long", "is typing"]) expect(frame).toContain(label)
  } finally { await close(setup) }
})

test("group history keeps system messages, replies, file status, and delivery details", async () => {
  const props = panelProps(80)
  props.selected = undefined
  props.selectedGroup = group
  props.selectedGroupId = group.group_id
  props.groupMembers = { team: [{ peer_id: "alex", display_name: "Alex Morgan" }] }
  props.conversationItems = [
    { type: "message", createdAt: 1788580800, message: { message_id: "join", sender_id: "alex", content: "", created_at: 1788580800, kind: "join" } },
    { type: "message", createdAt: 1788580860, message: { message_id: "reply", sender_id: "me", content: "Welcome!", created_at: 1788580860, reply_to_message_id: "join", deliveries: [{ recipient_id: "alex", display_name: "Alex Morgan", status: "delivered", updated_at: 1788580860 }] } },
    { type: "file", createdAt: 1788580860, file: { file_id: "file", filename: "notes.pdf", file_size: 1024, sender_id: "me", recipient_id: "alex", direction: "outgoing", status: "queued", created_at: 1788580860 }, allFiles: [] },
  ]
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 32 })
  try {
    const frame = await settle(setup, "joined the group")
    for (const label of ["Group / 4 members", "joined the group", "Replying to Alex Morgan", "delivered 1/1", "notes.pdf", "1.0 KiB"]) expect(frame).toContain(label)
  } finally { await close(setup) }
})

function ResizableChat({ props }: { props: ComponentProps<typeof ConversationPanel> }) {
  const { width, height } = useTerminalDimensions()
  const { stacked, panelWidth } = chatLayout(width)
  return <box width={width} height={height} gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}><Sidebar {...sidebarProps(width)} /><ConversationPanel {...props} width={panelWidth} compact={panelWidth < 70} /></box>
}

test("resizing to a short narrow terminal preserves the live draft and chat viewport", async () => {
  const props = panelProps(80)
  const setup = await testRender(<ResizableChat props={props} />, { width: 100, height: 24 })
  try {
    await settle(setup)
    await act(async () => { setup.mockInput.pasteBracketedText("Keep this draft") })
    const composer = props.composerRef.current
    await act(async () => { setup.resize(48, 24) })
    const frame = await settle(setup)
    expect(props.composerRef.current).toBe(composer)
    expect(composer!.plainText).toBe("Keep this draft")
    expect(frame).toContain("Ctrl+P commands")
    expect(frame).toContain("30,720 bytes")
    expect(props.scrollboxRef.current!.viewport.height).toBeGreaterThanOrEqual(3)
    expect(composer!.screenY + composer!.height).toBeLessThan(24)
  } finally { await close(setup) }
})

test("dialog focus prevents composer input or submission", async () => {
  const props = panelProps(80)
  props.dialogOpen = true
  props.drafts = { "peer:alex": "Unchanged" }
  let submitted = false
  props.send = () => { submitted = true }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 24 })
  try {
    await settle(setup)
    await act(async () => { setup.mockInput.pasteBracketedText("ignored"); setup.mockInput.pressEnter() })
    expect(props.composerRef.current!.plainText).toBe("Unchanged")
    expect(submitted).toBe(false)
  } finally { await close(setup) }
})

test("history selection and unread visibility retain their message IDs", async () => {
  const props = panelProps(80)
  props.scrollFocused = true
  props.selectedReplyTargetId = "m1"
  props.unreadMessageStates = { m1: { conversationKey: "peer:alex", receivedAt: Date.now() } }
  const visible: string[] = []
  let selected: unknown
  props.markUnreadMessageVisible = id => { visible.push(id) }
  props.selectReplyTarget = value => { selected = value }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    const frame = await settle(setup, "updated notes")
    expect(frame).toContain("Reading history")
    expect(visible).toContain("m1")
    const row = setup.renderer.root.findDescendantById("m1")!
    await act(async () => { await setup.mockMouse.click(row.screenX + 1, row.screenY) })
    expect(selected).toMatchObject({ id: "m1", senderId: "alex", kind: "message" })
  } finally { await close(setup) }
})

for (const width of [80, 48, 32]) {
  test(`status replaces hints without moving the composer at ${width} columns`, async () => {
    const props = panelProps(chatLayout(width).panelWidth)
    let changeStatus: (status: string) => void = noop
    function Fixture() {
      const [status, setStatus] = useState(DEFAULT_STATUS)
      changeStatus = setStatus
      return <ResizableChat props={{ ...props, status }} />
    }
    const setup = await testRender(<Fixture />, { width, height: 30 })
    try {
      await settle(setup)
      const y = props.composerRef.current!.screenY
      const historyHeight = props.scrollboxRef.current!.viewport.height
      await act(async () => { changeStatus("Message sent.") })
      let frame = await settle(setup)
      expect(frame).toContain("Message sent.")
      expect(frame).not.toContain("Enter send")
      expect(frame).not.toContain("Ctrl+P commands")
      expect(props.composerRef.current!.screenY).toBe(y)
      expect(props.scrollboxRef.current!.viewport.height).toBe(historyHeight)
      await act(async () => { changeStatus("Connection error: " + "More details. ".repeat(50) + "End of status.") })
      await settle(setup)
      expect(props.composerRef.current!.screenY).toBe(y)
      const notification = setup.renderer.root.findDescendantById("chat-status") as ScrollBoxRenderable
      await act(async () => { notification.scrollTo(notification.scrollHeight) })
      frame = await settle(setup)
      expect(frame.replace(/\s+/g, " ")).toContain("End of status.")
      await act(async () => { changeStatus(DEFAULT_STATUS) })
      frame = await settle(setup)
      expect(frame).toContain("Enter send")
      expect(frame).toContain("Ctrl+P commands")
      expect(props.composerRef.current!.screenY).toBe(y)
    } finally { await close(setup) }
  })
}
