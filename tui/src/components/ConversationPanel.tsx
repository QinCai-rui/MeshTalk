import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import type { ReactNode, RefObject } from "react"
import type { ConversationItem, Group, GroupMember, Peer } from "../types"
import { MarqueeText } from "./MarqueeText"
import { dayKey, formatDateSeparator, formatDateTime, formatTime, formatTimeMinute, getComposerHeight, groupDeliveryLabel, isImageFile, MAX_MESSAGE_BYTES, peerPresence, toFileUrl, transportName } from "../utils"

type ConversationPanelProps = {
  compact: boolean
  controlStatus: { connected: boolean; reconnect_attempts: number; control_url?: string | null }
  conversationItems: ConversationItem[]
  deliveredMessageIds: Set<string>
  dialogOpen: boolean
  draftLength: number
  drafts: Record<string, string>
  flashingEnabled: boolean
  blinkOn: boolean
  composerHeight: number
  composerRef: RefObject<TextareaRenderable | null>
  groupMembers: Record<string, GroupMember[]>
  identity: { peer_id: string; display_name: string } | undefined
  imageRenderGeneration: number
  limitedGroupMembers: GroupMember[]
  capabilityGapMessage: string
  isSending: boolean
  limitColor: string | undefined
  mutedPeers: Record<string, number>
  peers: Peer[]
  selected: Peer | undefined
  selectedGroup: Group | undefined
  selectedGroupId: string | undefined
  selectedHasCapabilityGap: boolean
  selectionKey: string | undefined
  typingNames: string[]
  editingName: boolean
  scrollFocused: boolean
  scrollboxRef: RefObject<ScrollBoxRenderable | null>
  status: string
  width: number
  setComposerHeight: (height: number) => void
  setDraftLength: (length: number) => void
  setScrollFocused: (focused: boolean) => void
  onComposerChange: (content: string) => void
  send: () => void
}

export function ConversationPanel(props: ConversationPanelProps) {
  const { compact, controlStatus, conversationItems, deliveredMessageIds, dialogOpen, draftLength, drafts, flashingEnabled, blinkOn, composerHeight, composerRef, groupMembers, identity, imageRenderGeneration, limitedGroupMembers, capabilityGapMessage, isSending, limitColor, mutedPeers, peers, selected, selectedGroup, selectedGroupId, selectedHasCapabilityGap, selectionKey, typingNames, editingName, scrollFocused, scrollboxRef, status, width, setComposerHeight, setDraftLength, setScrollFocused, onComposerChange, send } = props
  const typingText = typingNames.length === 1 ? `${typingNames[0]} is typing` : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing...` : typingNames.length > 2 ? "Multiple people are typing..." : undefined
  const composerTitle = selectedGroup || selected?.is_online ? (compact ? "Message" : "Message: Enter sends, Alt+Enter adds a line") : "Message: queued until peer is online"
  const byteCount = `${draftLength.toLocaleString()} / ${MAX_MESSAGE_BYTES.toLocaleString()} bytes`
  return <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", gap: 1 }}>
    {controlStatus.control_url && !controlStatus.connected ? <box style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}><MarqueeText width={width - 4} fg={(flashingEnabled ? blinkOn : true) ? "#ff9f43" : "#7a4b12"} text={`Out-of-sync with rendezvous server. Peer connectivity may degrade over time; reconnecting (${controlStatus.reconnect_attempts}).`} /></box> : null}
    <box title={selectedGroup ? `Group: ${selectedGroup.name} (${selectedGroup.member_count} members)` : selected ? `Chat: ${selected.display_name}${selected.is_friend ? " \u2665" : ""}${selected.peer_id in mutedPeers ? " (muted)" : ""} (${peerPresence(selected) === "offline" ? "offline" : `${peerPresence(selected)}: ${transportName(selected.active_transport)} ${selected.active_endpoint ?? ""}`}${selectedHasCapabilityGap ? ", limited" : ""})` : "Chat"} bottomTitle={compact ? "PgUp/PgDn scroll" : "PgUp/PgDn scroll  End latest  Drag text to select"} style={{ border: true, borderColor: scrollFocused ? "#6ea8fe" : undefined, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}>
      {selected && ((selected.delivery_warnings ?? []).length > 0 || selectedHasCapabilityGap) ? <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        {(selected.delivery_warnings ?? []).map((kind) => kind === "offline" ? <MarqueeText key="offline" width={width - 6} fg="#e0a34a" text="This peer is offline. Messages will be queued and delivered automatically upon reconnection." /> : kind === "not_friend" ? <MarqueeText key="not_friend" width={width - 6} fg="#e0a34a" text="Not friends yet. Your messages will be blocked until they accept your friend request (commands > friends > add friend)." /> : kind === "limited" && selectedHasCapabilityGap ? <text key="limited" wrapMode="word" fg={(flashingEnabled ? blinkOn : true) ? "#ff9f43" : "#7a4b12"}><b>{capabilityGapMessage}</b></text> : null)}
        {selectedHasCapabilityGap && !(selected.delivery_warnings ?? []).includes("limited") ? <text wrapMode="word" fg={(flashingEnabled ? blinkOn : true) ? "#ff9f43" : "#7a4b12"}><b>{capabilityGapMessage}</b></text> : null}
      </box> : null}
      {selectedGroup && limitedGroupMembers.length > 0 ? <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}><MarqueeText width={width - 6} fg={(flashingEnabled ? blinkOn : true) ? "#ff9f43" : "#7a4b12"} text={`Some group peers have capability differences: ${limitedGroupMembers.map((member) => member.display_name).join(", ")}. Shared features remain available.`} /></box> : null}
      <scrollbox ref={scrollboxRef} focused={scrollFocused && !dialogOpen} onMouseDown={() => setScrollFocused(true)} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, padding: 1 }} contentOptions={{ flexDirection: "column" }} stickyScroll stickyStart="bottom" viewportCulling={false} verticalScrollbarOptions={{ showArrows: true, trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" }, arrowOptions: { foregroundColor: "#6ea8fe" } }}>
        {!selected && !selectedGroup ? <text fg="#888888">Select a peer or group.</text> : null}
        {selected && !conversationItems.length && selected.is_online ? <text fg="#888888">No messages yet. Say hello.</text> : null}
        {selectedGroup && !conversationItems.length ? <text fg="#888888">No messages yet. Say hello to the group.</text> : null}
        {conversationItems.map((item, index) => {
          const rows: ReactNode[] = []
          const prev = conversationItems[index - 1]
          if (!prev || dayKey(prev.createdAt) !== dayKey(item.createdAt)) {
            rows.push(
              <box key={`sep-${dayKey(item.createdAt)}`} style={{ alignItems: "center", marginTop: 1, marginBottom: 1 }}>
                <text fg="#5b6b82">───── {formatDateSeparator(item.createdAt)} ─────</text>
              </box>
            )
          }
          if (item.type === "file") {
            const file = item.file
            const isLocal = file.sender_id === identity?.peer_id
            const senderName = peers.find((peer) => peer.peer_id === file.sender_id)?.display_name
              ?? groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === file.sender_id)?.display_name
              ?? "Unknown member"
            rows.push(
              <box key={`file-${file.file_id}`} style={{ flexDirection: "column", marginBottom: 1 }}>
                <text>
                  <span fg="#888888">{formatTime(file.created_at)} </span>
                  <span fg={isLocal ? "#65a9ff" : "#66dd88"}>{isLocal ? "You" : selectedGroup ? senderName : selected?.display_name}</span>
                  <span fg="#888888"> shared an attachment</span>
                </text>
                <text wrapMode="word"><span fg="#7aa2d6">{file.filename}</span><span fg="#888888"> · {(file.file_size / 1024).toFixed(1)} KiB</span></text>
                {isImageFile(file.filename) && (
                  <image key={`${file.file_id}-${file.completed_at ?? 0}-${imageRenderGeneration}`} source={toFileUrl(file.file_path!, file.completed_at)} fit="fit" protocol="auto" style={{ width: 40, height: 12 }} onError={() => {}} />
                )}
              </box>
            )
            return rows
          }
          const message = item.message
          const isLocal = message.sender_id === identity?.peer_id
          const delivered = Boolean(message.delivered) || deliveredMessageIds.has(message.message_id)
          const blocked = Boolean(message.blocked)
          const queued = Boolean(message.queued)
          const failed = Boolean(message.failed)
          const isSystem = Boolean(selectedGroup && message.kind && message.kind !== "message" && message.kind !== "text")
          const senderName = groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === message.sender_id)?.display_name
            ?? peers.find((peer) => peer.peer_id === message.sender_id)?.display_name
            ?? "Unknown member"
          const renderedContent = isSystem
            ? message.kind === "join"
              ? `${isLocal ? "You" : senderName} joined the group`
              : message.kind === "leave"
                ? `${isLocal ? "You" : senderName} left the group`
                : message.content
            : message.content
          const showReceived =
            typeof message.received_at === "number" &&
            formatTimeMinute(message.received_at) !== formatTimeMinute(message.created_at)
          rows.push(
            <box key={message.message_id} style={{ flexDirection: "column", marginBottom: 1 }}>
              <text>
                <span fg="#888888">{formatTime(message.created_at)} </span>
                <span fg={isSystem ? "#e0a34a" : isLocal ? "#65a9ff" : "#66dd88"}>{isSystem ? "System" : isLocal ? "You" : selectedGroup ? senderName : selected?.display_name}</span>
                {isLocal && !isSystem && (
                  <span fg={blocked || failed ? "#ff7777" : queued ? "#d9b36b" : "#888888"}>
                    {selectedGroup ? ` ${groupDeliveryLabel(message.deliveries)}` : blocked ? " blocked" : failed ? " disabled" : queued ? " stored and queued" : delivered ? " delivered" : " sent"}
                  </span>
                )}
                {showReceived && <span fg="#888888"> ({isLocal ? "delivered at " : "received at "}{formatDateTime(message.received_at!)})</span>}
              </text>
              <text wrapMode="word">{renderedContent}</text>
            </box>
          )
          return rows
        })}
      </scrollbox>
    </box>
    <box title={composerTitle} bottomTitle={isSending ? "Sending..." : byteCount} titleColor={limitColor ?? "#888888"} style={{ border: true, borderColor: limitColor ?? (!scrollFocused && !editingName && (selected?.is_online || selectedGroup) ? "#6ea8fe" : undefined), flexShrink: 0, overflow: "hidden", padding: 1 }}>
      <textarea key={selectionKey ?? "no-conversation"} ref={composerRef} initialValue={selectionKey ? drafts[selectionKey] ?? "" : ""} placeholder={selectedGroup ? `Message ${selectedGroup.name} — drop file/image here` : selected ? "Write a message — drop file/image to send" : "Select a peer or group"} focused={Boolean(selected || selectedGroup) && !editingName && !scrollFocused && !isSending && !dialogOpen} onMouseDown={() => setScrollFocused(false)} onContentChange={() => {
        const composer = composerRef.current
        const content = composer?.plainText ?? ""
        setDraftLength(new TextEncoder().encode(content).length)
        setComposerHeight(getComposerHeight(composer))
        onComposerChange(content)
      }} onSubmit={() => void send()} keyBindings={[{ name: "return", action: "submit" }, { name: "return", meta: true, action: "newline" }]} height={composerHeight} wrapMode="word" overflow="hidden" scrollMargin={1} selectionBg="#365b85" />
      {typingText && <box style={{ position: "absolute", right: 1, bottom: 0, flexDirection: "row", gap: 1 }}><text fg="#7aa2d6">{typingText}</text><spinner name="simpleDotsScrolling" color="#7aa2d6" /></box>}
    </box>
    <MarqueeText width={width - 2} fg={status.includes("error") || status.includes("lost") || status.includes("exceeds") ? "#ff7777" : "#888888"} text={status} />
  </box>
}
