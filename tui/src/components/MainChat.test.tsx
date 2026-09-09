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

test("member overflow link aligns with group member presence indicators", async () => {
  const props = sidebarProps(120)
  props.selectedPeerId = undefined
  props.selectedGroupId = group.group_id
  props.groupMembers = { team: [{ peer_id: "alex", display_name: "Alex Morgan" }] }
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup)
    const lines = frame.split("\n")
    const headerIdx = lines.findIndex(line => line.includes("Design studio"))
    const memberIdx = lines.findIndex((line, i) => i > headerIdx && line.includes("● Alex Morgan"))
    const member = lines[memberIdx]!
    const link = lines[memberIdx + 1]!
    expect(link.trim()).toBe("+ 3 more")
    expect(link.indexOf("+")).toBe(member.indexOf("●"))
  } finally { await close(setup) }
})
const peers: Peer[] = [
  { peer_id: "alex", display_name: "Alex Morgan", is_online: 1, presence: "active", last_seen: 0, last_interaction: 0, unread_count: 3, is_friend: true, active_transport: "lan_tcp", endpoints: [] },
  { peer_id: "sam", display_name: "Sam Chen", is_online: 0, presence: "offline", last_seen: 0, last_interaction: 0, unread_count: 0, endpoints: [] },
]
const group = { group_id: "team", name: "Design studio", member_count: 4, unread_count: 2 }
function sidebarProps(width: number): ComponentProps<typeof Sidebar> {
  return { appVersion: "0.23.0", ...chatLayout(width), dialogOpen: false, editingName: false, groups: [group], groupMembers: {}, identity: { peer_id: "me", display_name: "Taylor" }, mutedPeers: {}, nameDraft: "", peers, selectedPeerId: "alex", selectedGroupId: undefined, typingConversationKeys: new Set(), openGroupDetails: noop, setEditingName: noop, setNameDraft: noop, setSelection: noop, setScrollFocused: noop, saveDisplayName: noop }
}
function panelProps(width: number): ComponentProps<typeof ConversationPanel> {
  return {
    width, compact: width < 70, controlStatus: { connected: true, reconnect_attempts: 0 }, hasRooms: true,
    conversationItems: [
      { type: "message", createdAt: 1788580800, message: { message_id: "m1", sender_id: "alex", content: "I shared the **updated notes**. What do you think?", created_at: 1788580800 } },
      { type: "message", createdAt: 1788580860, message: { message_id: "m2", sender_id: "me", content: "Looks good. The simpler layout makes it much easier to read.", created_at: 1788580860, delivered: 1 } },
    ],
    deliveredMessageIds: new Set(), dialogOpen: false, draftLength: 0, drafts: {}, flashingEnabled: false, blinkOn: true, composerHeight: 3, composerRef: createRef<TextareaRenderable>(), groupMembers: {}, identity: { peer_id: "me", display_name: "Taylor" }, imageProtocol: "blocks", limitedGroupMembers: [], capabilityGapMessage: "", isSending: false, limitColor: undefined, mutedPeers: {}, peers, selected: peers[0], selectedGroup: undefined, selectedGroupId: undefined, selectedHasCapabilityGap: false, selectedReplyTargetId: undefined, replyTo: undefined, selectionKey: "peer:alex", unreadMessageStates: {}, unreadNow: 0, markUnreadMessageVisible: noop, openSettings: noop, openImage: noop, openDeliveryDetails: noop, typingNames: [], editingName: false, scrollFocused: false, scrollboxRef: createRef<ScrollBoxRenderable>(), status: DEFAULT_STATUS, setComposerHeight: noop, setDraftLength: noop, setScrollFocused: noop, selectReplyTarget: noop, clearReplyTarget: noop, onComposerChange: noop, send: noop,
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

function foregroundFor(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  return setup.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes(text))?.fg
}

for (const width of [120, 80, 64, 48, 32]) {
  test(`main chat fits ${width} columns with readable navigation and composer`, async () => {
    const { stacked, panelWidth } = chatLayout(width)
    const props = panelProps(panelWidth)
    const setup = await testRender(<box width={width} height={30} backgroundColor={chatTheme.canvas} gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}><Sidebar {...sidebarProps(width)} /><ConversationPanel {...props} /></box>, { width, height: 30 })
    try {
      const frame = await settle(setup, "Looks good")
      expect(frame).toContain("Alex Morgan")
      expect(frame).toContain("●")
      expect(frame).toContain("3 new")
      expect(frame).toContain("MeshTalk 0.23.0")
      expect(frame.match(/Ctrl\+P settings/g)?.length).toBe(1)
      if (width >= 64) expect(frame.match(/Ctrl\+Up\/Down switch/g)?.length).toBe(1)
      expect(frame).toContain("Write a message...")
      expect(frame).toContain("30,720 bytes")
      expect(frame).toContain("Ctrl+P settings")
      expect(frame.replace(/\s+/g, " ")).toContain("Ctrl+↑↓ chats")
      const commandsShortcut = setup.renderer.root.findDescendantById("settings-shortcut")!
      expect(commandsShortcut).toBeDefined()
      if (!props.compact) expect(commandsShortcut.screenX).toBeGreaterThan(props.composerRef.current!.screenX)
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
  props.mutedPeers = {}
  props.setSelection = value => { selection = value }
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Groups (1)")
    expect(frame).not.toContain("──── Groups")
    for (const label of ["~", "♥", "↙", "↗", "Limited", "3 new"]) expect(frame).toContain(label)
    expect(frame).not.toContain("Muted")
    for (const label of ["Away", "Offline", "Friend", "Request received", "Request sent"]) expect(frame).not.toContain(label)
    const row = setup.renderer.root.findDescendantById("nav-peer-alex")!
    await act(async () => { await setup.mockMouse.click(row.screenX + 1, row.screenY) })
    expect(selection).toEqual({ kind: "peer", id: "alex" })
  } finally { await close(setup) }
})

test("muted peers and groups hide unread badges while staying dimmed", async () => {
  const props = sidebarProps(120)
  props.peers = [{ ...peers[0]!, unread_count: 3 }]
  props.groups = [{ ...group, unread_count: 2 }]
  props.mutedPeers = { alex: 0 }
  props.mutedGroups = { team: 0 }
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Muted")
    expect(frame).not.toContain("3 new")
    expect(frame).not.toContain("2 new")
  } finally { await close(setup) }
})

test("top bar shows a mute toggle for the selected conversation", async () => {
  const props = panelProps(80)
  let toggled = 0
  props.mutedPeers = {}
  props.mutedGroups = {}
  props.onToggleMute = () => { toggled++ }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    await settle(setup, "Alex Morgan")
    const toggle = setup.renderer.root.findDescendantById("mute-toggle")!
    expect(toggle).toBeDefined()
    await act(async () => { await setup.mockMouse.click(toggle.screenX + 1, toggle.screenY) })
    expect(toggled).toBe(1)
  } finally { await close(setup) }
})

test("peers with Do Not Disturb show a red circle and DND flag", async () => {
  const props = sidebarProps(120)
  props.peers = [{ ...peers[0]!, dnd: true }]
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup, "Alex Morgan")
    expect(frame).toContain("DND")
    const fg = foregroundFor(setup, "Alex Morgan") as unknown as { toInts: () => number[] }
    expect(fg?.toInts()).toEqual([255, 95, 95, 255])
  } finally { await close(setup) }
})

test("sidebar shows a Do Not Disturb indicator when DND is on", async () => {
  const props = sidebarProps(120)
  props.dndEnabled = true
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup, "Do Not Disturb on")
    expect(frame).toContain("Do Not Disturb on")
    const fg = foregroundFor(setup, "Do Not Disturb on") as unknown as { toInts: () => number[] }
    expect(fg?.toInts()).toEqual([255, 95, 95, 255])
  } finally { await close(setup) }
})

test("conversation header marks a peer with Do Not Disturb", async () => {
  const props = panelProps(80)
  props.selected = { ...peers[0]!, dnd: true }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    const frame = await settle(setup, "Alex Morgan")
    expect(frame).toContain("DND")
  } finally { await close(setup) }
})

test("Do Not Disturb blocks all desktop notifications", async () => {
  const { notify } = await import("../notifications")
  let triggered = 0
  const renderer = { capabilities: { notifications: true }, triggerNotification: () => { triggered++ } }
  const preferences = { setup_dismissed: true, delivery: "terminal" as const, events: { messages: true, friend_requests: true, file_offers: true, file_completed: true } }
  for (const event of ["messages", "friend_requests", "file_offers", "file_completed"] as const)
    await notify(preferences, event, renderer, "hello", true)
  expect(triggered).toBe(0)
  await notify(preferences, "messages", renderer, "hello", false)
  expect(triggered).toBe(1)
})

test("mention popup lists matching members above the input and picks on click", async () => {
  const props = panelProps(80)
  props.selected = undefined
  props.selectedGroup = group
  props.selectedGroupId = group.group_id
  props.selectionKey = "group:team"
  props.groupMembers = { team: [{ peer_id: "alex", display_name: "Alex Morgan" }, { peer_id: "me", display_name: "Taylor" }] }
  props.mentionOpen = true
  props.mentionCandidates = [
    { peerId: "alex", displayName: "Alex Morgan" },
    { peerId: "me", displayName: "Taylor", isSelf: true },
  ]
  props.mentionSelected = 1
  let picked: string | undefined
  props.onMentionPick = (peerId) => { picked = peerId }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 30 })
  try {
    const frame = await settle(setup, "Alex Morgan")
    expect(setup.renderer.root.findDescendantById("mention-popup")).toBeDefined()
    expect(frame).toContain("@Alex Morgan")
    expect(frame).toContain("@Taylor (you)")
    const row = setup.renderer.root.findDescendantById("mention-pick-alex")!
    await act(async () => { await setup.mockMouse.click(row.screenX + 1, row.screenY) })
    expect(picked).toBe("alex")
  } finally { await close(setup) }
})

test("stored mention tokens render as display names with a yellow highlight", async () => {
  const props = panelProps(80)
  props.selected = undefined
  props.selectedGroup = group
  props.selectedGroupId = group.group_id
  props.selectionKey = "group:team"
  props.groupMembers = { team: [{ peer_id: "alex", display_name: "Alex Morgan" }, { peer_id: "me", display_name: "Taylor" }] }
  props.conversationItems = [
    { type: "message", createdAt: 1788580800, message: { message_id: "m1", sender_id: "alex", content: "hi <@me> and <@sam> and <@gone>!", created_at: 1788580800 } },
    { type: "message", createdAt: 1788580860, message: { message_id: "m2", sender_id: "alex", content: "no mentions here", created_at: 1788580860 } },
  ]
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 30 })
  try {
    const frame = await settle(setup, "@Taylor")
    expect(frame).toContain("hi @Taylor and @Sam Chen and @unknown!")
    expect(frame).not.toContain("<@me>")
    expect(frame).toContain("no mentions here")
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const mentionSpan = spans.find((span) => span.text.includes("@Taylor"))
    expect(mentionSpan).toBeDefined()
    expect((mentionSpan!.bg as unknown as { toInts: () => number[] })?.toInts()).toEqual([77, 63, 30, 255])
  } finally { await close(setup) }
})

test("sidebar highlights groups with unread mentions", async () => {
  const props = sidebarProps(120)
  props.groups = [{ ...group, unread_count: 1 }]
  props.mentionCounts = { team: 2 }
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup, "Design studio")
    expect(frame).toContain("@2 mentioned")
  } finally { await close(setup) }
})

test("sidebar hides mention highlights for muted groups", async () => {
  const props = sidebarProps(120)
  props.groups = [{ ...group, unread_count: 1 }]
  props.mentionCounts = { team: 2 }
  props.mutedGroups = { team: 0 }
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup, "Design studio")
    expect(frame).not.toContain("mentioned")
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

test("expanded groups show only active and away members while counting offline members in overflow", async () => {
  const props = sidebarProps(120)
  props.selectedPeerId = undefined
  props.selectedGroupId = group.group_id
  props.groups = [{ ...group, member_count: 5 }]
  props.groupMembers = { team: [
    { peer_id: "alex", display_name: "Alex Morgan", is_online: true },
    { peer_id: "sam", display_name: "Sam Chen", is_online: false },
    { peer_id: "away", display_name: "Avery Away", is_online: false },
    { peer_id: "me", display_name: "Taylor", is_online: true },
  ] }
  props.peers = [...peers, { ...peers[0]!, peer_id: "away", display_name: "Avery Away", is_online: 1, presence: "away" }]
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup, "Avery Away")
    const groupRoster = frame.slice(frame.indexOf("Design studio"))
    expect(groupRoster).toContain("Alex Morgan")
    expect(groupRoster).toContain("Avery Away")
    expect(groupRoster).toContain("Taylor (you)")
    expect(groupRoster).not.toContain("Sam Chen")
    expect(groupRoster).toContain("+ 2 more")
  } finally { await close(setup) }
})

test("expanded groups subtly note when only you are online", async () => {
  const props = sidebarProps(120)
  props.selectedPeerId = undefined
  props.selectedGroupId = group.group_id
  props.groups = [{ ...group, member_count: 12 }]
  props.groupMembers = { team: [{ peer_id: "me", display_name: "Taylor", is_online: true }] }
  props.peers = []
  const setup = await testRender(<Sidebar {...props} />, { width: 40, height: 30 })
  try {
    const frame = await settle(setup)
    const groupRoster = frame.slice(frame.indexOf("Design studio")).replace(/\s+/g, " ")
    expect(groupRoster).toContain("Taylor (you)")
    expect(groupRoster).toContain("+ 11 more")
    expect(groupRoster).toContain("No one else online")
  } finally { await close(setup) }
})

test("clicking the settings footer opens settings", async () => {
  const props = panelProps(80)
  let opened = 0
  props.openSettings = () => { opened++ }
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    await settle(setup)
    const shortcut = setup.renderer.root.findDescendantById("settings-shortcut")!
    await act(async () => { await setup.mockMouse.click(shortcut.screenX + 1, shortcut.screenY) })
    expect(opened).toBe(1)
  } finally { await close(setup) }
})

test("conversation switches show an in-flow loading message instead of an empty-state flash", async () => {
  const props = panelProps(80)
  props.conversationItems = []
  props.conversationLoading = true
  const setup = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    const frame = await settle(setup, "Loading Messages")
    expect(frame).toContain("Loading Messages")
    expect(frame).not.toContain("No messages yet")
  } finally { await close(setup) }
})

test("sidebar groups use contiguous two-line targets like DMs", async () => {
  const props = sidebarProps(120)
  props.selectedPeerId = undefined
  props.groups = Array.from({ length: 3 }, (_, index) => ({ ...group, group_id: `group-${index}`, name: `Group ${index}`, unread_count: 0 }))
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    await settle(setup)
    const rows = props.groups.map(item => setup.renderer.root.findDescendantById(`nav-group-${item.group_id}`)!)
    expect(rows.every(row => row.height >= 2)).toBe(true)
    expect(rows[0]!.screenY + rows[0]!.height).toBe(rows[1]!.screenY)
    expect(rows[1]!.screenY + rows[1]!.height).toBe(rows[2]!.screenY)
  } finally { await close(setup) }
})

test("expanded group keeps its detail row above its members", async () => {
  const props = sidebarProps(120)
  props.selectedPeerId = undefined
  props.selectedGroupId = group.group_id
  props.groups = [{ ...group, unread_count: 0 }]
  props.groupMembers = { team: [{ peer_id: "alex", display_name: "Alex Morgan" }, { peer_id: "sam", display_name: "Sam Chen" }] }
  const setup = await testRender(<Sidebar {...props} />, { width: 30, height: 30 })
  try {
    const frame = await settle(setup, "Alex Morgan")
    const lines = frame.split("\n")
    const headerIdx = lines.findIndex(line => line.includes("Design studio"))
    const memberIdx = lines.findIndex((line, i) => i > headerIdx && line.includes("Alex Morgan"))
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(memberIdx).toBe(headerIdx + 2)
    // Name + detail row + online member + overflow link.
    expect(setup.renderer.root.findDescendantById(`nav-group-${group.group_id}`)!.height).toBe(4)
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

test("control status stays quiet until a room exists, then explains how to connect", async () => {
  const props = panelProps(80)
  props.controlStatus = { connected: false, reconnect_attempts: 0, control_url: "wss://control.example/v1/rendezvous" }
  props.hasRooms = false
  const idle = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    expect(await settle(idle)).not.toContain("Out-of-sync with MeshTalk rendezvous server")
  } finally { await close(idle) }

  props.hasRooms = true
  const disconnected = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    const frame = await settle(disconnected, "Out-of-sync with MeshTalk")
    expect(frame).toContain("reconnecting (0)")
    expect(frame).toContain("Peer connectivity may degrade")
  } finally { await close(disconnected) }

  props.controlStatus = { connected: false, reconnect_attempts: 0 }
  const unconfigured = await testRender(<ConversationPanel {...props} />, { width: 80, height: 26 })
  try {
    const frame = await settle(unconfigured, "Remote discovery is not configured")
    expect(frame.replace(/\s+/g, " ")).toContain("connect these rooms")
  } finally { await close(unconfigured) }
})

test("rendezvous and capability warnings pulse softly and remain readable", async () => {
  const warningProps = panelProps(80)
  warningProps.hasRooms = true
  warningProps.controlStatus = { connected: false, reconnect_attempts: 2, control_url: "wss://control.example/v1/rendezvous" }
  warningProps.selected = { ...peers[0]!, delivery_warnings: ["offline", "not_friend"] }
  warningProps.selectedHasCapabilityGap = true
  warningProps.capabilityGapMessage = "This peer needs a newer client."
  warningProps.flashingEnabled = true
  warningProps.blinkOn = true
  const bright = await testRender(<ConversationPanel {...warningProps} />, { width: 80, height: 26 })
  let brightRendezvous: ReturnType<typeof foregroundFor>
  let brightCapability: ReturnType<typeof foregroundFor>
  let brightOffline: ReturnType<typeof foregroundFor>
  let brightFriend: ReturnType<typeof foregroundFor>
  try {
    const frame = await settle(bright, "Out-of-sync with MeshTalk")
    expect(frame).toContain("Limited: This peer needs a newer client.")
    expect(frame).toContain("Offline: messages queue")
    expect(frame).toContain("Messages blocked until your friend request")
    brightRendezvous = foregroundFor(bright, "Out-of-sync with MeshTalk")
    brightCapability = foregroundFor(bright, "Limited: This peer")
    brightOffline = foregroundFor(bright, "Offline: messages queue")
    brightFriend = foregroundFor(bright, "Messages blocked until")
    expect(brightRendezvous).toBeDefined()
    expect(brightCapability).toBeDefined()
    expect(brightOffline).toBeDefined()
    expect(brightFriend).toBeDefined()
  } finally { await close(bright) }

  const dim = await testRender(<ConversationPanel {...warningProps} blinkOn={false} />, { width: 80, height: 26 })
  try {
    const dimFrame = await settle(dim, "Out-of-sync with MeshTalk")
    expect(dimFrame).toContain("Limited: This peer needs a newer client.")
    expect(foregroundFor(dim, "Out-of-sync with MeshTalk")).not.toEqual(brightRendezvous)
    expect(foregroundFor(dim, "Limited: This peer")).not.toEqual(brightCapability)
    expect(foregroundFor(dim, "Offline: messages queue")).not.toEqual(brightOffline)
    expect(foregroundFor(dim, "Messages blocked until")).not.toEqual(brightFriend)
  } finally { await close(dim) }

  const staticWarning = await testRender(<ConversationPanel {...warningProps} flashingEnabled={false} blinkOn={false} />, { width: 80, height: 26 })
  try {
    await settle(staticWarning, "Out-of-sync with MeshTalk")
    expect(foregroundFor(staticWarning, "Out-of-sync with MeshTalk")).toEqual(brightRendezvous)
    expect(foregroundFor(staticWarning, "Limited: This peer")).toEqual(brightCapability)
    expect(foregroundFor(staticWarning, "Offline: messages queue")).toEqual(brightOffline)
    expect(foregroundFor(staticWarning, "Messages blocked until")).toEqual(brightFriend)
  } finally { await close(staticWarning) }
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
    expect(frame).toContain("Ctrl+P settings")
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
      expect(frame).not.toContain("Ctrl+P settings")
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
      expect(frame).toContain("Ctrl+P settings")
      expect(props.composerRef.current!.screenY).toBe(y)
    } finally { await close(setup) }
  })
}
