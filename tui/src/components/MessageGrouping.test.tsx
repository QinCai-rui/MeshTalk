import { expect, test } from "bun:test"
import { act, createRef, type ComponentProps } from "react"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { ConversationPanel } from "./ConversationPanel"
import { DEFAULT_STATUS, formatTime } from "../utils"
import type { ConversationItem, Peer } from "../types"

const noop = () => {}

const peers: Peer[] = [
  { peer_id: "alex", display_name: "Alex Morgan", is_online: 1, presence: "active", last_seen: 0, last_interaction: 0, unread_count: 0, is_friend: true, active_transport: "lan_tcp", endpoints: [] },
]

function burstProps(width: number): ComponentProps<typeof ConversationPanel> {
  const t0 = 1788580800
  const items: ConversationItem[] = [
    { type: "message", createdAt: t0, message: { message_id: "m1", sender_id: "alex", content: "first burst message", created_at: t0 } },
    { type: "message", createdAt: t0 + 20, message: { message_id: "m2", sender_id: "alex", content: "second burst message", created_at: t0 + 20 } },
  ]
  return {
    width, compact: false, controlStatus: { connected: true, reconnect_attempts: 0 }, hasRooms: true,
    conversationItems: items,
    deliveredMessageIds: new Set<string>(), dialogOpen: false, draftLength: 0, drafts: {}, flashingEnabled: false, blinkOn: true, composerHeight: 3, composerRef: createRef<TextareaRenderable>(), groupMembers: {}, identity: { peer_id: "me", display_name: "Taylor" }, imageProtocol: "blocks" as const, limitedGroupMembers: [], capabilityGapMessage: "", isSending: false, limitColor: undefined, mutedPeers: {}, peers, selected: peers[0], selectedGroup: undefined, selectedGroupId: undefined, selectedHasCapabilityGap: false, selectedReplyTargetId: undefined, replyTo: undefined, selectionKey: "peer:alex", unreadMessageStates: {}, unreadNow: 0, markUnreadMessageVisible: noop, openSettings: noop, openImage: noop, openDeliveryDetails: noop, typingNames: [], editingName: false, scrollFocused: false, scrollboxRef: createRef<ScrollBoxRenderable>(), status: DEFAULT_STATUS, setComposerHeight: noop, setDraftLength: noop, setScrollFocused: noop, selectReplyTarget: noop, clearReplyTarget: noop, onComposerChange: noop, send: noop,
  }
}

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

test("grouped follow-up shows content only with no repeated timestamp", async () => {
  const props = burstProps(120)
  const time = formatTime(1788580800)
  const setup = await testRender(<ConversationPanel {...props} />, { width: 120, height: 30 })
  try {
    const frame = await settle(setup, "second burst message")
    expect(frame).toContain("Alex Morgan")
    expect(frame.match(new RegExp(time.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length ?? 0).toBe(1)
    // Title bar + first message header; a repeated header on the follow-up would make it 3.
    expect(frame.match(/Alex Morgan/g)?.length ?? 0).toBe(2)
  } finally { await close(setup) }
})

test("compact follow-up with a warning status keeps its status line", async () => {
  const props = burstProps(120)
  props.conversationItems = [
    { type: "message", createdAt: 1788580800, message: { message_id: "m1", sender_id: "me", content: "first burst message", created_at: 1788580800, delivered: 1 } },
    { type: "message", createdAt: 1788580820, message: { message_id: "m2", sender_id: "me", content: "second burst message", created_at: 1788580820, queued: 1 } },
  ]
  const setup = await testRender(<ConversationPanel {...props} />, { width: 120, height: 30 })
  try {
    const frame = await settle(setup, "second burst message")
    expect(frame).toContain("stored and queued")
  } finally { await close(setup) }
})

test("compact group follow-up with disagreeing deliveries keeps its drill-down", async () => {
  const props = burstProps(120)
  const at = 1788580800
  const delivered = { recipient_id: "bob", display_name: "Bob", status: "delivered", updated_at: at }
  const queued = { recipient_id: "sam", display_name: "Sam", status: "queued", updated_at: at }
  props.selected = undefined
  props.selectedGroup = { group_id: "team", name: "Team", member_count: 3, unread_count: 0 }
  props.selectedGroupId = "team"
  props.selectionKey = "group:team"
  props.conversationItems = [
    { type: "message", createdAt: at, message: { message_id: "m1", sender_id: "me", group_id: "team", content: "first burst message", created_at: at, deliveries: [delivered, { ...delivered, recipient_id: "sam", display_name: "Sam" }] } },
    { type: "message", createdAt: at + 20, message: { message_id: "m2", sender_id: "me", group_id: "team", content: "second burst message", created_at: at + 20, deliveries: [delivered, queued] } },
  ]
  const setup = await testRender(<ConversationPanel {...props} />, { width: 120, height: 30 })
  try {
    const frame = await settle(setup, "second burst message")
    // First message header shows one; the compact follow-up must keep its own.
    expect(frame.match(/\(click for details\)/g)?.length ?? 0).toBe(2)
  } finally { await close(setup) }
})
