import { expect, test } from "bun:test"
import { act, createRef, type ComponentProps } from "react"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { ConversationPanel } from "./ConversationPanel"
import { ChatFooter } from "./ChatFooter"
import { DEFAULT_STATUS } from "../utils"
import type { Peer } from "../types"

const noop = () => {}

const peers: Peer[] = [
  { peer_id: "alex", display_name: "Alex Morgan", is_online: 1, presence: "active", last_seen: 0, last_interaction: 0, unread_count: 0, is_friend: true, active_transport: "lan_tcp", endpoints: [] },
]

function panelProps(width: number): ComponentProps<typeof ConversationPanel> {
  return {
    width, compact: width < 70, controlStatus: { connected: true, reconnect_attempts: 0 }, hasRooms: true,
    conversationItems: [
      { type: "message", createdAt: 1788580800, message: { message_id: "m1", sender_id: "alex", content: "Original text", created_at: 1788580800 } },
      { type: "message", createdAt: 1788580860, message: { message_id: "m2", sender_id: "me", content: "My corrected text", created_at: 1788580860, delivered: 1 } },
    ],
    deliveredMessageIds: new Set(), dialogOpen: false, draftLength: 0, drafts: {}, flashingEnabled: false, blinkOn: true, composerHeight: 3, composerRef: createRef<TextareaRenderable>(), groupMembers: {}, identity: { peer_id: "me", display_name: "Taylor" }, imageProtocol: "blocks", limitedGroupMembers: [], capabilityGapMessage: "", isSending: false, limitColor: undefined, mutedPeers: {}, peers, selected: peers[0], selectedGroup: undefined, selectedGroupId: undefined, selectedHasCapabilityGap: false, selectedReplyTargetId: undefined, replyTo: undefined, selectionKey: "peer:alex", unreadMessageStates: {}, unreadNow: 0, markUnreadMessageVisible: noop, openSettings: noop, openImage: noop, openDeliveryDetails: noop, typingNames: [], editingName: false, scrollFocused: false, scrollboxRef: createRef<ScrollBoxRenderable>(), status: DEFAULT_STATUS, setComposerHeight: noop, setDraftLength: noop, setScrollFocused: noop, selectReplyTarget: noop, clearReplyTarget: noop, onComposerChange: noop, send: noop,
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

test("edited messages show an (edited) marker in the header", async () => {
  const props = panelProps(120)
  const edited = props.conversationItems[1]!
  if (edited.type !== "message") throw new Error("fixture must be a message")
  edited.message.edited_at = 1788580900
  const setup = await testRender(<ConversationPanel {...props} />, { width: 120, height: 30 })
  try {
    const frame = await settle(setup, "My corrected text")
    expect(frame).toContain("(edited)")
  } finally { await close(setup) }
})

test("unedited messages show no (edited) marker", async () => {
  const props = panelProps(120)
  const setup = await testRender(<ConversationPanel {...props} />, { width: 120, height: 30 })
  try {
    const frame = await settle(setup, "My corrected text")
    expect(frame).not.toContain("(edited)")
  } finally { await close(setup) }
})

test("edit mode shows an Editing banner above the composer", async () => {
  const props = panelProps(120)
  const setup = await testRender(
    <ConversationPanel {...props} editingTarget={{ id: "m2", senderId: "me", label: "My corrected text" }} />,
    { width: 120, height: 30 },
  )
  try {
    const frame = await settle(setup, "My corrected text")
    expect(frame).toContain("Editing:")
    expect(frame).toContain("Esc cancel")
  } finally { await close(setup) }
})

for (const width of [120, 48]) {
  test(`history hint includes E edit at width ${width}`, async () => {
    const setup = await testRender(
      <ChatFooter width={width} scrollFocused status={DEFAULT_STATUS} openSettings={noop} />,
      { width, height: 8 },
    )
    try {
      const frame = await settle(setup, "R reply")
      expect(frame).toContain("E edit")
    } finally { await close(setup) }
  })
}
