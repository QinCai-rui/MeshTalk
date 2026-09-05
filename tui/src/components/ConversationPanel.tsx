import { ChatFooter } from "./ChatFooter"
import { TypingDots } from "./TypingDots"
import { SyntaxStyle, type BoxRenderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import type { ConversationItem, FileTransfer, Group, GroupDelivery, GroupMember, ImageProtocol, Peer, ReplyTarget, UnreadMessageState } from "../types"
import { chatTheme as theme } from "../chatTheme"
import { clipTextToWidth, dayKey, formatDateSeparator, formatDateTime, formatTime, formatTimeMinute, getComposerHeight, groupDeliveryLabel, isImageFile, MAX_MESSAGE_BYTES, peerPresence, transportName, unreadMessageBackground, UNREAD_MESSAGE_FADE_MS } from "../utils"
import { ImageAttachment, isLocalFileMissing } from "./ImageAttachment"

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
  imageProtocol: ImageProtocol
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
  selectedReplyTargetId: string | undefined
  replyTo: ReplyTarget | undefined
  selectionKey: string | undefined
  unreadMessageStates: Record<string, UnreadMessageState>
  unreadNow: number
  markUnreadMessageVisible: (messageId: string) => void
  openImage: (file: FileTransfer) => void
  openDeliveryDetails: (deliveries: GroupDelivery[]) => void
  typingNames: string[]
  editingName: boolean
  scrollFocused: boolean
  scrollboxRef: RefObject<ScrollBoxRenderable | null>
  status: string
  width: number
  setComposerHeight: (height: number) => void
  setDraftLength: (length: number) => void
  setScrollFocused: (focused: boolean) => void
  selectReplyTarget: (target: ReplyTarget) => void
  clearReplyTarget: () => void
  onComposerChange: (content: string) => void
  send: () => void
}

const MESSAGE_MARKDOWN_STYLES = {
  default: { fg: theme.markdown.default },
  "markup.heading.1": { fg: theme.markdown.heading, bold: true },
  "markup.heading.2": { fg: theme.markdown.heading, bold: true },
  "markup.heading.3": { fg: theme.markdown.heading, bold: true },
  "markup.heading.4": { fg: theme.markdown.heading, bold: true },
  "markup.heading.5": { fg: theme.markdown.heading, bold: true },
  "markup.heading.6": { fg: theme.markdown.heading, bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.link.label": { fg: theme.markdown.heading, underline: true },
  "markup.link.url": { fg: theme.markdown.link, underline: true },
  "markup.raw": { fg: theme.markdown.raw },
  "markup.list": { fg: theme.markdown.list },
  keyword: { fg: theme.markdown.keyword, bold: true },
  string: { fg: theme.markdown.raw },
  comment: { fg: theme.markdown.comment, italic: true },
  number: { fg: theme.markdown.number },
  boolean: { fg: theme.markdown.number },
  function: { fg: theme.markdown.function },
  type: { fg: theme.markdown.type },
  operator: { fg: theme.markdown.keyword },
  punctuation: { fg: theme.markdown.punctuation },
} as const

export function ConversationPanel(props: ConversationPanelProps) {
  const { compact, controlStatus, conversationItems, deliveredMessageIds, dialogOpen, draftLength, drafts, flashingEnabled, blinkOn, composerHeight, composerRef, groupMembers, identity, imageProtocol, limitedGroupMembers, capabilityGapMessage, isSending, limitColor, mutedPeers, peers, selected, selectedGroup, selectedGroupId, selectedHasCapabilityGap, selectedReplyTargetId, replyTo, selectionKey, unreadMessageStates, unreadNow, markUnreadMessageVisible, openImage, openDeliveryDetails, typingNames, editingName, scrollFocused, scrollboxRef, status, width, setComposerHeight, setDraftLength, setScrollFocused, selectReplyTarget, clearReplyTarget, onComposerChange, send } = props
  const messageRefs = useRef<Record<string, BoxRenderable | null>>({})
  const [replyHighlight, setReplyHighlight] = useState<{ id: string; startedAt: number }>()
  const [replyHighlightNow, setReplyHighlightNow] = useState(0)
  const messageSyntaxStyle = useMemo(() => SyntaxStyle.fromStyles(MESSAGE_MARKDOWN_STYLES), [])
  const typingText = typingNames.length === 1
    ? `${clipTextToWidth(typingNames[0]!, Math.max(1, width - 18)).trimEnd()} is typing`
    : typingNames.length > 1 ? `${typingNames.length} people are typing` : undefined
  const composerTitle = !selected && !selectedGroup ? "Message" : selectedGroup || selected?.is_online ? "Message" : "Message / queued until online"
  const byteCount = `${draftLength.toLocaleString()} / ${MAX_MESSAGE_BYTES.toLocaleString()} bytes`
  const hasConversation = Boolean(selected || selectedGroup)
  const peerState = selected ? peerPresence(selected) === "active" ? "Online" : peerPresence(selected) === "away" ? "Away" : "Offline" : ""


  useEffect(() => () => messageSyntaxStyle.destroy(), [messageSyntaxStyle])

  useEffect(() => {
    if (!replyHighlight) return
    const interval = setInterval(() => setReplyHighlightNow(Date.now()), 100)
    const timeout = setTimeout(() => setReplyHighlight(undefined), UNREAD_MESSAGE_FADE_MS)
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [replyHighlight])

  const highlightReplyTarget = (id: string) => {
    const startedAt = Date.now()
    setReplyHighlight({ id, startedAt })
    setReplyHighlightNow(startedAt)
  }
  const replyHighlightProgress = (id: string) => replyHighlight?.id === id
    ? Math.min(1, Math.max(0, (replyHighlightNow - replyHighlight.startedAt) / UNREAD_MESSAGE_FADE_MS))
    : undefined

  useEffect(() => {
    if (!selectionKey || !Object.entries(unreadMessageStates).some(([, message]) => message.conversationKey === selectionKey && message.visibleAt === undefined)) return
    const markVisibleMessages = () => {
      const scrollbox = scrollboxRef.current
      if (!scrollbox) return
      const viewportTop = scrollbox.viewport.screenY
      const viewportBottom = viewportTop + scrollbox.viewport.height
      for (const [messageId, message] of Object.entries(unreadMessageStates)) {
        if (message.conversationKey !== selectionKey || message.visibleAt !== undefined) continue
        const row = messageRefs.current[messageId]
        if (!row) continue
        const rowTop = row.screenY
        const rowBottom = rowTop + row.height
        if (rowBottom > viewportTop && rowTop < viewportBottom) markUnreadMessageVisible(messageId)
      }
    }
    markVisibleMessages()
    const interval = setInterval(markVisibleMessages, 100)
    return () => clearInterval(interval)
  }, [selectionKey, unreadMessageStates])

  useEffect(() => {
    if (!selectedReplyTargetId) return
    scrollboxRef.current?.scrollChildIntoView(selectedReplyTargetId)
  }, [selectedReplyTargetId])

  return <box style={{ width, flexBasis: 0, flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, flexDirection: "column", backgroundColor: theme.canvas }}>
    <box style={{ flexShrink: 0, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: theme.surface }}>
      <text fg={theme.text} wrapMode="word"><b>{selectedGroup?.name ?? selected?.display_name ?? "Your conversations"}</b></text>
      <text fg={theme.muted} wrapMode="word">{selectedGroup ? `Group / ${selectedGroup.member_count} members` : selected ? `${peerState}${selected.is_online ? ` / ${compact && selected.active_transport === "remote_derp" ? "Relay" : transportName(selected.active_transport)}` : ""}${!compact && selected.active_endpoint && selected.active_transport !== "remote_derp" ? ` / ${selected.active_endpoint}` : ""}${selected.is_friend ? " / Friend" : ""}${selected.peer_id in mutedPeers ? " / Muted" : ""}${selectedHasCapabilityGap ? " / Limited" : ""}${selected.friend_request === "incoming" ? " / Request received" : selected.friend_request === "outgoing" ? " / Request sent" : selected.friend_request === "both" ? " / Requests exchanged" : ""}` : "Choose a peer or group to get started"}</text>
    </box>
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}>
      <box paddingLeft={2} paddingRight={1} flexShrink={0}>
        {controlStatus.control_url && !controlStatus.connected && <text fg={theme.warning} wrapMode="word">Rendezvous out of sync; reconnecting ({controlStatus.reconnect_attempts}).</text>}
        {selected && <>
          {(selected.delivery_warnings ?? []).map(kind => kind === "offline" ? <text key={kind} fg={theme.warning} wrapMode="word">Offline: messages queue until this peer reconnects.</text> : kind === "not_friend" ? <text key={kind} fg={theme.warning} wrapMode="word">Messages blocked until your friend request is accepted. Ctrl+P &gt; Friends &gt; Add friend.</text> : null)}
          {selectedHasCapabilityGap && <text fg={theme.warning} wrapMode="word">Limited: {capabilityGapMessage}</text>}
        </>}
        {selectedGroup && limitedGroupMembers.length > 0 && <text fg={theme.warning} wrapMode="word">Limited features: {limitedGroupMembers.map(member => member.display_name).join(", ")}. Shared features remain available.</text>}
      </box>
      <scrollbox ref={scrollboxRef} focused={scrollFocused && !dialogOpen} onMouseDown={() => setScrollFocused(true)} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 2, paddingRight: 1 }} contentOptions={{ flexDirection: "column" }} stickyScroll stickyStart="bottom" verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
        {!selected && !selectedGroup ? <box marginTop={2} gap={1}><text fg={theme.text}><b>A little closer, wherever you are.</b></text><text fg={theme.muted}>Ctrl+Up/Down selects a conversation. Ctrl+P opens settings to find peers, join a group, or share files.</text></box> : null}
        {selected && !conversationItems.length ? <text fg={theme.muted}>No messages yet. Say hello.</text> : null}
        {selectedGroup && !conversationItems.length ? <text fg={theme.muted}>No messages yet. Say hello to the group.</text> : null}
        {conversationItems.map((item, index) => {
          const rows: ReactNode[] = []
          const prev = conversationItems[index - 1]
          if (!prev || dayKey(prev.createdAt) !== dayKey(item.createdAt)) {
            rows.push(
              <box key={`sep-${dayKey(item.createdAt)}`} style={{ alignItems: "center", marginTop: 1, marginBottom: 1 }}>
                <text fg={theme.muted}>{formatDateSeparator(item.createdAt)}</text>
              </box>
            )
          }
            if (item.type === "file") {
              const file = item.file
              const allFiles = item.allFiles
              const fileUnavailable = isLocalFileMissing(file.file_path) && file.status !== "queued" && file.status !== "transferring" && file.status !== "receiving"
            const isLocal = file.sender_id === identity?.peer_id
            const senderName = peers.find((peer) => peer.peer_id === file.sender_id)?.display_name
              ?? groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === file.sender_id)?.display_name
              ?? "Unknown member"
            const fileStatusColor = (s: string) => {
              if (s === "completed" || s === "sent") return theme.muted
              if (s === "queued") return theme.warning
              if (s === "failed" || s === "unavailable") return theme.danger
              if (s === "receiving" || s === "transferring") return theme.muted
              return theme.muted
            }
            const fileStatusLabel = (s: string) => {
              if (s === "completed") return " delivered"
              if (s === "sent") return " sent"
              if (s === "queued") return " stored and queued"
              if (s === "failed") return " failed"
              if (s === "unavailable") return " unavailable"
              if (s === "receiving") return " receiving"
              if (s === "transferring") return " sending"
              return ""
            }
            const fileDeliveries = allFiles.map((f) => ({
              recipient_id: f.recipient_id,
              display_name: groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === f.recipient_id)?.display_name
                ?? peers.find((peer) => peer.peer_id === f.recipient_id)?.display_name
                ?? f.recipient_id.slice(0, 8),
              status: f.status === "completed" ? "delivered" : f.status === "failed" ? "unavailable" : f.status === "transferring" || f.status === "receiving" ? "pending" : f.status,
              updated_at: f.completed_at ?? f.created_at,
            }))
            const fileReplyHighlightProgress = replyHighlightProgress(file.file_id)
            rows.push(
              <box id={file.file_id} key={`file-${file.file_id}`} ref={(node) => { messageRefs.current[file.file_id] = node }} onMouseDown={() => selectReplyTarget({ id: file.file_id, senderId: file.sender_id, label: `Attachment: ${file.filename}`, groupId: file.group_id ?? undefined, kind: "file" })} style={{ flexDirection: "column", marginBottom: 1, backgroundColor: fileReplyHighlightProgress !== undefined ? unreadMessageBackground(fileReplyHighlightProgress) : scrollFocused && selectedReplyTargetId === file.file_id ? theme.selected : undefined }}>
                <text>
                  <span fg={theme.accent}>{scrollFocused && selectedReplyTargetId === file.file_id ? "> " : ""}</span><span fg={theme.muted}>{formatTime(file.created_at)} </span>
                  <span fg={isLocal ? theme.accent : theme.text}>{isLocal ? "You" : selectedGroup ? senderName : selected?.display_name}</span>
                  <span fg={theme.muted}> shared an attachment</span>
                  {isLocal && !selectedGroup && <span fg={fileStatusColor(file.status)}>{fileStatusLabel(file.status)}</span>}
                </text>
                {isLocal && selectedGroup && <box onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); openDeliveryDetails(fileDeliveries) } }}><text fg={theme.muted}>{groupDeliveryLabel(fileDeliveries)} <u>(click for details)</u></text></box>}
                <text wrapMode="word"><span fg={theme.accent}>{file.filename}</span><span fg={theme.muted}> · {(file.file_size / 1024).toFixed(1)} KiB</span></text>
                {fileUnavailable ? <text fg={theme.danger}>File unavailable: not found or deleted locally</text> : null}
                {!fileUnavailable && file.file_path ? <ImageAttachment filePath={file.file_path} filename={file.filename} protocol={imageProtocol} expectedImage={isImageFile(file.filename)} scrollboxRef={scrollboxRef} maxWidth={Math.max(1, (scrollboxRef.current?.viewport.width ?? width - 3) - 2)} maxHeight={Math.min(16, Math.max(4, (scrollboxRef.current?.viewport.height ?? 16) - 4))} onOpen={() => openImage(file)} /> : null}
              </box>
            )
            return rows
          }
          const message = item.message
          const isLocal = message.sender_id === identity?.peer_id
          const unread = !isLocal ? unreadMessageStates[message.message_id] : undefined
          const fadeProgress = unread?.visibleAt === undefined ? 0 : Math.min(1, Math.max(0, (unreadNow - unread.visibleAt) / UNREAD_MESSAGE_FADE_MS))
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
          const replyTarget = message.reply_to_message_id
            ? conversationItems.find((candidate) => candidate.type === "message" ? candidate.message.message_id === message.reply_to_message_id : candidate.file.file_id === message.reply_to_message_id)
            : undefined
          const replySenderId = replyTarget?.type === "message" ? replyTarget.message.sender_id : replyTarget?.file.sender_id
          const replySender = replySenderId === identity?.peer_id ? "You"
            : replySenderId ? (selectedGroup ? groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === replySenderId)?.display_name : selected?.display_name) ?? "Unknown member" : undefined
          const replyContent = replyTarget?.type === "message" ? replyTarget.message.content : replyTarget ? `Attachment: ${replyTarget.file.filename}` : undefined
          const replySnippet = replyContent?.replace(/\s+/g, " ").trim().slice(0, 60)
          const replySelectTarget: ReplyTarget | undefined = replyTarget
            ? replyTarget.type === "message"
              ? { id: replyTarget.message.message_id, senderId: replyTarget.message.sender_id, label: replyTarget.message.content, groupId: replyTarget.message.group_id, kind: "message" }
              : { id: replyTarget.file.file_id, senderId: replyTarget.file.sender_id, label: `Attachment: ${replyTarget.file.filename}`, groupId: replyTarget.file.group_id ?? undefined, kind: "file" }
            : undefined
          const showReceived =
            typeof message.received_at === "number" &&
            formatTimeMinute(message.received_at) !== formatTimeMinute(message.created_at)
          const messageReplyHighlightProgress = replyHighlightProgress(message.message_id)
          rows.push(
              <box id={message.message_id} key={message.message_id} ref={(node) => { messageRefs.current[message.message_id] = node }} onMouseDown={() => selectReplyTarget({ id: message.message_id, senderId: message.sender_id, label: message.content, groupId: message.group_id, kind: "message" })} style={{ width: "100%", flexDirection: "column", marginBottom: 1, backgroundColor: messageReplyHighlightProgress !== undefined ? unreadMessageBackground(messageReplyHighlightProgress) : scrollFocused && selectedReplyTargetId === message.message_id ? theme.selected : unread ? unreadMessageBackground(fadeProgress) : undefined }}>
              <text>
                <span fg={theme.accent}>{scrollFocused && selectedReplyTargetId === message.message_id ? "> " : ""}</span><span fg={theme.muted}>{formatTime(message.created_at)} </span>
                <span fg={isSystem ? theme.warning : isLocal ? theme.accent : theme.text}>{isSystem ? "System" : isLocal ? "You" : selectedGroup ? senderName : selected?.display_name}</span>
                 {isLocal && !isSystem && !selectedGroup && <span fg={blocked || failed ? theme.danger : queued ? theme.warning : theme.muted}>{blocked ? " blocked" : failed ? " disabled" : queued ? " stored and queued" : delivered ? " delivered" : " sent"}</span>}
                 {showReceived && <span fg={theme.muted}> ({isLocal ? "delivered at " : "received at "}{formatDateTime(message.received_at!)})</span>}
                 </text>
                {isLocal && !isSystem && selectedGroup && <box onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); openDeliveryDetails(message.deliveries ?? []) } }}><text fg={theme.muted}>{groupDeliveryLabel(message.deliveries)} <u>(click for details)</u></text></box>}
                {message.reply_to_message_id && <box onMouseDown={replySelectTarget ? (event) => { if (event.button === 0) { event.stopPropagation(); clearReplyTarget(); highlightReplyTarget(replySelectTarget.id); setScrollFocused(true); scrollboxRef.current?.scrollChildIntoView(replySelectTarget.id) } } : undefined}><text fg={theme.accent}>&gt; Replying to {replySender ?? "an unavailable message"}{replySnippet ? <>: <u>{replySnippet}{replyContent && replyContent.replace(/\s+/g, " ").trim().length > 60 ? "..." : ""}</u></> : ""}</text></box>}
                <markdown content={renderedContent} syntaxStyle={messageSyntaxStyle} conceal={true} concealCode={true} style={{ width: "100%" }} />
            </box>
          )
          return rows
        })}
      </scrollbox>
    </box>
    <box paddingLeft={2} paddingRight={1} flexShrink={0} height={1} overflow="hidden" flexDirection="row" gap={1}><text fg={theme.accent} wrapMode="none">{typingText ?? (scrollFocused ? "Reading history" : "")}</text>{typingText && <TypingDots />}</box>
    <box style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1, backgroundColor: theme.surface }}>
      <text fg={limitColor ?? theme.accent}><b>{!scrollFocused && !editingName && hasConversation ? "> " : ""}{composerTitle}</b></text>
      {replyTo && <text fg={theme.accent}>Replying to {replyTo.senderId === identity?.peer_id ? "You" : selectedGroup ? groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === replyTo.senderId)?.display_name ?? "Unknown member" : selected?.display_name ?? "Unknown peer"}: {replyTo.label.replace(/\s+/g, " ").trim().slice(0, 60)}{replyTo.label.replace(/\s+/g, " ").trim().length > 60 ? "..." : ""} (Esc cancels)</text>}
      <textarea key={selectionKey ?? "no-conversation"} ref={composerRef} initialValue={selectionKey ? drafts[selectionKey] ?? "" : ""} placeholder={hasConversation ? "Write a message..." : "Select a peer or group"} focused={Boolean(selected || selectedGroup) && !editingName && !scrollFocused && !isSending && !dialogOpen} onMouseDown={() => setScrollFocused(false)} onContentChange={() => {
        const composer = composerRef.current
        const content = composer?.plainText ?? ""
        setDraftLength(new TextEncoder().encode(content).length)
        setComposerHeight(getComposerHeight(composer))
        onComposerChange(content)
      }} onSubmit={() => void send()} keyBindings={[{ name: "return", action: "submit" }, { name: "return", meta: true, action: "newline" }]} height={composerHeight} wrapMode="word" overflow="hidden" scrollMargin={1} textColor={theme.text} backgroundColor={theme.surface} focusedBackgroundColor={theme.surface} focusedTextColor={theme.text} selectionBg={theme.selected} />
      <text fg={limitColor ?? theme.muted}>{isSending ? "Sending... / " : ""}{byteCount}{draftLength > MAX_MESSAGE_BYTES ? " / Too long" : ""}</text>
    </box>
    <ChatFooter width={width} scrollFocused={scrollFocused} status={status} />
  </box>
}
