import { act, createRef, type ComponentProps } from "react"
import { testRender } from "@opentui/react/test-utils"
import { SyntaxStyle, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { ConversationPanel } from "./components/ConversationPanel"
import { chatTheme } from "./chatTheme"
import type { Peer } from "./types"
import { DEFAULT_STATUS } from "./utils"

const noop = () => {}
const peers: Peer[] = [
  { peer_id: "alex", display_name: "Alex Morgan", is_online: 1, presence: "active", last_seen: 0, last_interaction: 0, unread_count: 0, endpoints: [] },
]
const group = { group_id: "team", name: "Design studio", member_count: 4, unread_count: 0 }

function props(): ComponentProps<typeof ConversationPanel> {
  return {
    width: 80, compact: false, controlStatus: { connected: true, reconnect_attempts: 0 }, hasRooms: true,
    conversationItems: [
      { type: "message", createdAt: 1788580800, message: { message_id: "m1", sender_id: "alex", content: "hi <@me>!", mentions: ["me"], created_at: 1788580800 } },
    ],
    deliveredMessageIds: new Set(), dialogOpen: false, draftLength: 11, drafts: { "group:team": "line one\n@Taylor here" }, flashingEnabled: false, blinkOn: true, composerHeight: 3, composerRef: createRef<TextareaRenderable>(), groupMembers: { team: [{ peer_id: "alex", display_name: "Alex Morgan" }, { peer_id: "me", display_name: "Taylor" }] }, identity: { peer_id: "me", display_name: "Taylor" }, imageProtocol: "blocks", limitedGroupMembers: [], capabilityGapMessage: "", isSending: false, limitColor: undefined, mutedPeers: {}, peers, selected: undefined, selectedGroup: group, selectedGroupId: "team", selectedHasCapabilityGap: false, selectedReplyTargetId: undefined, replyTo: undefined, selectionKey: "group:team", unreadMessageStates: {}, unreadNow: 0, markUnreadMessageVisible: noop, openSettings: noop, onToggleMute: noop,
    mentionOpen: false, mentionCandidates: [], mentionSelected: 0, onMentionPick: noop,
    openImage: noop, openDeliveryDetails: noop, typingNames: [], editingName: false, scrollFocused: false, scrollboxRef: createRef<ScrollBoxRenderable>(), status: DEFAULT_STATUS, setComposerHeight: noop, setDraftLength: noop, setScrollFocused: noop, selectReplyTarget: noop, clearReplyTarget: noop, onComposerChange: noop, send: noop,
  }
}

test("scratch: mention code span conceals backticks and tints light blue", async () => {
  const p = props()
  const setup = await testRender(<ConversationPanel {...p} />, { width: 80, height: 30 })
  try {
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); await setup.renderOnce() })
    const frame = setup.captureCharFrame()
    console.log(frame.split("\n").slice(5, 10).join("\n"))
    expect(frame).not.toContain("`")
    expect(frame).toContain("@Taylor")
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const at = spans.find((s) => s.text.includes("@Taylor") && !s.text.includes("Do Not"))
    console.log("history mention fg:", (at?.fg as unknown as { toInts?: () => number[] })?.toInts?.())
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("scratch: composer char-range highlight tints mention", async () => {
  const p = props()
  const setup = await testRender(<ConversationPanel {...p} />, { width: 80, height: 30 })
  try {
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); await setup.renderOnce() })
    const composer = p.composerRef.current!
    const style = SyntaxStyle.fromStyles({ mention: { fg: chatTheme.markdown.raw } })
    const id = style.getStyleId("mention")!
    composer.syntaxStyle = style
    composer.clearAllHighlights()
    // multi-line: "line one\n@Taylor here" — probe single-char ranges
    for (const [s, e] of [[8, 9], [9, 10], [10, 11]]) {
      composer.clearAllHighlights()
      composer.addHighlightByCharRange({ start: s, end: e, styleId: id })
      await act(async () => { await setup.renderOnce() })
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      for (const x of spans) {
        const fg = (x.fg as unknown as { toInts?: () => number[] })?.toInts?.()
        if (fg && fg[0] === 165) console.log(`range [${s},${e}) tinted:`, JSON.stringify(x.text))
      }
    }
    style.destroy()
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
