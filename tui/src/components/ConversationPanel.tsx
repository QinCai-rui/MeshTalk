import { ChatFooter } from "./ChatFooter"
import { EmptyState } from "./EmptyState"
import { TypingDots } from "./TypingDots"
import { SyntaxStyle, type BoxRenderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useTimeline } from "@opentui/react"
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import type { ConversationItem, FileTransfer, Group, GroupDelivery, GroupMember, ImageProtocol, Message, Peer, ReplyTarget, UnreadMessageState } from "../types"
import { chatTheme as theme } from "../chatTheme"
import { clipTextToWidth, dayKey, formatDateSeparator, formatDateTime, formatTime, formatTimeMinute, getComposerHeight, groupDeliveryLabel, inlineFriendActions, isImageFile, MAX_MESSAGE_BYTES, peerFriendState, peerFriendStatusText, peerPresence, transportName, unreadMessageBackground, UNREAD_MESSAGE_FADE_MS, type InlineFriendAction } from "../utils"
import { ImageAttachment, isLocalFileMissing, notifyImageViewportChanged } from "./ImageAttachment"
import { updateBoundedEntry } from "../stateRetention"

type ConversationPanelProps = {
  compact: boolean
  controlStatus: { connected: boolean; reconnect_attempts: number; control_url?: string | null }
  hasRooms: boolean
  conversationItems: ConversationItem[]
  conversationLoading?: boolean
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
  markUnreadMessageVisible: (messageId: string) => void
  openSettings: () => void
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
  onRetryFile?: (fileId: string) => void
  inboxCount?: number
  onFriendAction?: (action: InlineFriendAction) => void
  onOpenConnection?: () => void
  onAttachFile?: () => void
  onAddFriend?: () => void
  onCreateGroup?: () => void
  onJoinGroup?: () => void
  onOpenHelp?: () => void
}

const MAX_CONVERSATION_TIP_ENTRIES = 200

function HighlightOverlay({ id }: { id: string }) {
  const overlayRef = useRef<BoxRenderable>(null)
  const timeline = useTimeline({
    autoplay: false,
    duration: UNREAD_MESSAGE_FADE_MS,
  })

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    timeline.add(overlay, {
      opacity: 0,
      duration: UNREAD_MESSAGE_FADE_MS,
      ease: "inQuad",
    })
    timeline.play()
    return () => {
      timeline.pause()
    }
  }, [timeline])

  return (
    <box
      id={id}
      ref={overlayRef}
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      backgroundColor={unreadMessageBackground(0)}
      opacity={1}
      style={{ zIndex: 0 }}
    />
  )
}

type ConversationRowHandlers = {
  selectReplyTarget: (target: ReplyTarget) => void
  clearReplyTarget: () => void
  highlightReplyTarget: (id: string) => void
  setScrollFocused: (focused: boolean) => void
  scrollboxRef: RefObject<ScrollBoxRenderable | null>
  openDeliveryDetails: (deliveries: GroupDelivery[]) => void
  openImage: (file: FileTransfer) => void
  onRetryFile?: (fileId: string) => void
}

type ConversationRowHandlersRef = { current: ConversationRowHandlers }
type MessageRefs = { current: Record<string, BoxRenderable | null> }

function replyTargetForItem(item: ConversationItem): ReplyTarget {
  return item.type === "message"
    ? { id: item.message.message_id, senderId: item.message.sender_id, label: item.message.content, groupId: item.message.group_id, kind: "message" }
    : { id: item.file.file_id, senderId: item.file.sender_id, label: `Attachment: ${item.file.filename}`, groupId: item.file.group_id ?? undefined, kind: "file" }
}

function fileStatusColor(status: string) {
  if (status === "completed" || status === "sent") return theme.muted
  if (status === "queued") return theme.warning
  if (status === "failed" || status === "unavailable" || status === "blocked") return theme.danger
  return theme.muted
}

function fileStatusLabel(status: string) {
  if (status === "completed") return " delivered"
  if (status === "sent") return " sent"
  if (status === "queued") return " stored and queued"
  if (status === "failed") return " failed"
  if (status === "blocked") return " blocked"
  if (status === "unavailable") return " unavailable"
  if (status === "receiving") return " receiving"
  if (status === "transferring") return " sending"
  return ""
}

type FileRowProps = {
  file: FileTransfer
  fileDeliveries: GroupDelivery[]
  fileUnavailable: boolean
  isLocal: boolean
  senderName: string | undefined
  selectedGroup: boolean
  selectedPeerName: string | undefined
  selectedReplyTargetId: string | undefined
  scrollFocused: boolean
  fileReplyHighlighted: boolean
  canRetryFile: boolean
  retryEnabled: boolean
  imageProtocol: ImageProtocol
  width: number
  messageRefs: MessageRefs
  handlers: ConversationRowHandlersRef
}

const ConversationFileRow = memo(function ConversationFileRow({ file, fileDeliveries, fileUnavailable, isLocal, senderName, selectedGroup, selectedPeerName, selectedReplyTargetId, scrollFocused, fileReplyHighlighted, canRetryFile, retryEnabled, imageProtocol, width, messageRefs, handlers }: FileRowProps) {
  const selectedRow = scrollFocused && selectedReplyTargetId === file.file_id
  return (
    <box id={file.file_id} ref={(node) => { if (node) messageRefs.current[file.file_id] = node; else delete messageRefs.current[file.file_id] }} onMouseDown={() => handlers.current.selectReplyTarget(replyTargetForItem({ type: "file", createdAt: file.created_at, file, allFiles: [file] }))} style={{ position: "relative", flexDirection: "column", marginBottom: 1, backgroundColor: selectedRow && !fileReplyHighlighted ? theme.selected : undefined }}>
      {fileReplyHighlighted && <HighlightOverlay id={`reply-highlight-${file.file_id}`} />}
      <box style={{ position: "relative", zIndex: 1, flexDirection: "column" }}>
        <text>
          <span fg={selectedRow ? theme.accent : theme.muted}>{selectedRow ? "> " : ""}</span><span fg={theme.muted}>{formatTime(file.created_at)} </span>
          <span fg={isLocal ? theme.accent : theme.text}>{isLocal ? "You" : selectedGroup ? senderName : selectedPeerName}</span>
          <span fg={theme.muted}> shared an attachment</span>
          {isLocal && !selectedGroup && <span fg={fileStatusColor(file.status)}>{fileStatusLabel(file.status)}</span>}
          {canRetryFile && retryEnabled && <span fg={theme.text}> · </span>}
        </text>
        {canRetryFile && retryEnabled && <box onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); handlers.current.onRetryFile?.(file.file_id) } }}><text fg={theme.text}><u>Retry</u></text></box>}
        {isLocal && selectedGroup && <box onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); handlers.current.openDeliveryDetails(fileDeliveries) } }}><text fg={theme.muted}>{groupDeliveryLabel(fileDeliveries)} <u>(click for details)</u></text></box>}
        <text wrapMode="word"><span fg={theme.accent}>{file.filename}</span><span fg={theme.muted}> · {(file.file_size / 1024).toFixed(1)} KiB</span></text>
        {fileUnavailable ? <text fg={theme.danger}>File unavailable: not found or deleted locally</text> : null}
        {!fileUnavailable && file.file_path ? <ImageAttachment filePath={file.file_path} filename={file.filename} protocol={imageProtocol} expectedImage={isImageFile(file.filename)} scrollboxRef={handlers.current.scrollboxRef} maxWidth={Math.max(1, (handlers.current.scrollboxRef.current?.viewport.width ?? width - 3) - 2)} maxHeight={Math.min(16, Math.max(4, (handlers.current.scrollboxRef.current?.viewport.height ?? 16) - 4))} onOpen={() => handlers.current.openImage(file)} /> : null}
      </box>
    </box>
  )
})

type MessageRowProps = {
  message: Message
  isLocal: boolean
  isSystem: boolean
  senderName: string
  renderedContent: string
  replyTarget: ConversationItem | undefined
  replySender: string | undefined
  replyContent: string | undefined
  replySnippet: string | undefined
  selectedRow: boolean
  unreadHighlighted: boolean
  replyHighlighted: boolean
  delivered: boolean
  blocked: boolean
  queued: boolean
  failed: boolean
  showReceived: boolean
  messageSyntaxStyle: SyntaxStyle
  messageRefs: MessageRefs
  handlers: ConversationRowHandlersRef
}

const ConversationMessageRow = memo(function ConversationMessageRow({ message, isLocal, isSystem, senderName, renderedContent, replyTarget, replySender, replyContent, replySnippet, selectedRow, unreadHighlighted, replyHighlighted, delivered, blocked, queued, failed, showReceived, messageSyntaxStyle, messageRefs, handlers }: MessageRowProps) {
  const markdown = useMemo(() => <markdown content={renderedContent} syntaxStyle={messageSyntaxStyle} conceal={true} concealCode={true} style={{ width: "100%" }} />, [messageSyntaxStyle, renderedContent])
  return (
    <box id={message.message_id} ref={(node) => { if (node) messageRefs.current[message.message_id] = node; else delete messageRefs.current[message.message_id] }} onMouseDown={() => handlers.current.selectReplyTarget(replyTargetForItem({ type: "message", createdAt: message.created_at, message }))} style={{ position: "relative", width: "100%", flexDirection: "column", marginBottom: 1, backgroundColor: selectedRow && !replyHighlighted ? theme.selected : undefined }}>
      {replyHighlighted && <HighlightOverlay id={`reply-highlight-${message.message_id}`} />}
      {unreadHighlighted && <HighlightOverlay id={`unread-highlight-${message.message_id}`} />}
      <box style={{ position: "relative", zIndex: 1, width: "100%", flexDirection: "column" }}>
        <text>
          <span fg={selectedRow ? theme.accent : theme.muted}>{selectedRow ? "> " : ""}</span><span fg={theme.muted}>{formatTime(message.created_at)} </span>
          <span fg={isSystem ? theme.warning : isLocal ? theme.accent : theme.text}>{isSystem ? "System" : isLocal ? "You" : senderName}</span>
          {isLocal && !isSystem && <span fg={blocked || failed ? theme.danger : queued ? theme.warning : theme.muted}>{blocked ? " blocked" : failed ? " disabled" : queued ? " stored and queued" : delivered ? " delivered" : " sent"}</span>}
          {showReceived && <span fg={theme.muted}> ({isLocal ? "delivered at " : "received at "}{formatDateTime(message.received_at!)})</span>}
        </text>
        {isLocal && !isSystem && <box onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); handlers.current.openDeliveryDetails(message.deliveries ?? []) } }}><text fg={theme.muted}>{groupDeliveryLabel(message.deliveries)} <u>(click for details)</u></text></box>}
        {message.reply_to_message_id && <box onMouseDown={replyTarget ? (event) => { if (event.button === 0) { event.stopPropagation(); const target = replyTargetForItem(replyTarget); handlers.current.clearReplyTarget(); handlers.current.highlightReplyTarget(target.id); handlers.current.setScrollFocused(true); handlers.current.scrollboxRef.current?.scrollChildIntoView(target.id) } } : undefined}><text fg={theme.accent}>&gt; Replying to {replySender ?? "an unavailable message"}{replySnippet ? <>: <u>{replySnippet}{replyContent && replyContent.replace(/\s+/g, " ").trim().length > 60 ? "..." : ""}</u></> : ""}</text></box>}
        {markdown}
      </box>
    </box>
  )
})

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
  const { compact, controlStatus, hasRooms, conversationItems, conversationLoading = false, deliveredMessageIds, dialogOpen, draftLength, drafts, flashingEnabled, blinkOn, composerHeight, composerRef, groupMembers, identity, imageProtocol, limitedGroupMembers, capabilityGapMessage, isSending, limitColor, mutedPeers, peers, selected, selectedGroup, selectedGroupId, selectedHasCapabilityGap, selectedReplyTargetId, replyTo, selectionKey, unreadMessageStates, markUnreadMessageVisible, openSettings, openImage, openDeliveryDetails, typingNames, editingName, scrollFocused, scrollboxRef, status, width, setComposerHeight, setDraftLength, setScrollFocused, selectReplyTarget, clearReplyTarget, onComposerChange, send, inboxCount = 0, onFriendAction, onOpenConnection, onAttachFile, onAddFriend,   onCreateGroup, onJoinGroup, onRetryFile, onOpenHelp } = props
  const [dismissedEmpty, setDismissedEmpty] = useState<Record<string, boolean>>({})
  const [showConversationTips, setShowConversationTips] = useState<Record<string, boolean>>({})
  const openConnection = onOpenConnection ?? openSettings
  const dismissKey = selectionKey ?? "no-selection"
  const messageRefs = useRef<Record<string, BoxRenderable | null>>({})
  const visibleUnreadCheck = useRef<() => void>(() => {})
  const [replyHighlight, setReplyHighlight] = useState<{ id: string; startedAt: number }>()
  const messageSyntaxStyle = useMemo(() => SyntaxStyle.fromStyles(MESSAGE_MARKDOWN_STYLES), [])
  const rowHandlers = useRef<ConversationRowHandlers>(null!)
  const typingText = typingNames.length === 1
    ? `${clipTextToWidth(typingNames[0]!, Math.max(1, width - 18)).trimEnd()} is typing`
    : typingNames.length > 1 ? `${typingNames.length} people are typing` : undefined
  const composerTitle = !selected && !selectedGroup ? "Message" : selectedGroup || selected?.is_online ? "Message" : "Message / queued until online"
  const byteCount = `${draftLength.toLocaleString()} / ${MAX_MESSAGE_BYTES.toLocaleString()} bytes`
  const hasConversation = Boolean(selected || selectedGroup)
  const friendState = selected ? peerFriendState(selected) : undefined
  const hasFriendActions = Boolean(selected && !selectedGroup && friendState !== "friend" && onFriendAction)
  const peerState = selected ? peerPresence(selected) === "active" ? "Online" : peerPresence(selected) === "away" ? "Away" : "Offline" : ""
  // Keep warning text readable during the accessibility pulse. The prior UI faded
  // it almost away; the calmer shell shifts between two amber tones instead.
  const flashingWarningColor = !flashingEnabled || blinkOn ? theme.warning : theme.warningPulse


  useEffect(() => () => messageSyntaxStyle.destroy(), [messageSyntaxStyle])

  useEffect(() => {
    if (!replyHighlight) return
    const timeout = setTimeout(() => setReplyHighlight(undefined), UNREAD_MESSAGE_FADE_MS)
    return () => clearTimeout(timeout)
  }, [replyHighlight])

  const highlightReplyTarget = (id: string) => {
    const startedAt = Date.now()
    setReplyHighlight({ id, startedAt })
  }

  rowHandlers.current = {
    selectReplyTarget,
    clearReplyTarget,
    highlightReplyTarget,
    setScrollFocused,
    scrollboxRef,
    openDeliveryDetails,
    openImage,
    onRetryFile,
  }

  useEffect(() => {
    if (!selectionKey || !Object.entries(unreadMessageStates).some(([, message]) => message.conversationKey === selectionKey && message.visibleAt === undefined)) {
      visibleUnreadCheck.current = () => {}
      return
    }
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
    visibleUnreadCheck.current = markVisibleMessages
    markVisibleMessages()
    // Rows mount after this effect; one retry handles the initial layout without
    // keeping a polling timer alive for the rest of the conversation.
    const initialCheck = setTimeout(markVisibleMessages, 100)
    const scrollbar = scrollboxRef.current?.verticalScrollBar
    scrollbar?.on("change", markVisibleMessages)
    return () => {
      clearTimeout(initialCheck)
      scrollbar?.off("change", markVisibleMessages)
      if (visibleUnreadCheck.current === markVisibleMessages) visibleUnreadCheck.current = () => {}
    }
  }, [selectionKey, unreadMessageStates, scrollboxRef])

  useEffect(() => {
    if (!selectedReplyTargetId) return
    scrollboxRef.current?.scrollChildIntoView(selectedReplyTargetId)
  }, [selectedReplyTargetId])

  useEffect(() => {
    const scrollbar = scrollboxRef.current?.verticalScrollBar
    if (!scrollbar) return
    const refreshImageViewport = () => {
      notifyImageViewportChanged()
      visibleUnreadCheck.current()
    }
    scrollbar.on("change", refreshImageViewport)
    return () => {
      scrollbar.off("change", refreshImageViewport)
    }
  }, [scrollboxRef])

  const conversationItemById = useMemo(() => {
    const items = new Map<string, ConversationItem>()
    for (const item of conversationItems) items.set(item.type === "message" ? item.message.message_id : item.file.file_id, item)
    return items
  }, [conversationItems])
  const groupMemberNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const member of groupMembers[selectedGroupId ?? ""] ?? []) {
      const id = member.peer_id ?? member.member_id
      if (id) names.set(id, member.display_name)
    }
    return names
  }, [groupMembers, selectedGroupId])
  const peerNames = useMemo(() => new Map(peers.map((peer) => [peer.peer_id, peer.display_name])), [peers])
  const fileDeliveriesById = useMemo(() => {
    const deliveries = new Map<string, GroupDelivery[]>()
    for (const item of conversationItems) {
      if (item.type !== "file") continue
      deliveries.set(item.file.file_id, item.allFiles.map((file) => ({
        recipient_id: file.recipient_id,
        display_name: groupMemberNames.get(file.recipient_id) ?? peerNames.get(file.recipient_id) ?? file.recipient_id.slice(0, 8),
        status: file.status === "completed" ? "delivered" : file.status === "failed" ? "unavailable" : file.status === "transferring" || file.status === "receiving" ? "pending" : file.status,
        updated_at: file.completed_at ?? file.created_at,
      })))
    }
    return deliveries
  }, [conversationItems, groupMemberNames, peerNames])

  return <box style={{ width, flexBasis: 0, flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, flexDirection: "column", backgroundColor: theme.canvas }}>
    <box style={{ flexShrink: 0, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: theme.surface }}>
      <text fg={theme.text} wrapMode="word"><b>{selectedGroup?.name ?? selected?.display_name ?? "Your conversations"}</b></text>
      <text fg={theme.muted} wrapMode="word">{selectedGroup ? `Group / ${selectedGroup.member_count} members` : selected ? `${peerState}${selected.is_online ? ` / ${compact && selected.active_transport === "remote_derp" ? "Relay" : transportName(selected.active_transport)}` : ""}${!compact && selected.active_endpoint && selected.active_transport !== "remote_derp" ? ` / ${selected.active_endpoint}` : ""}${selected.is_friend ? " / Friend" : ""}${selected.peer_id in mutedPeers ? " / Muted" : ""}${selectedHasCapabilityGap ? " / Limited" : ""}${selected.friend_request === "incoming" ? " / Request received" : selected.friend_request === "outgoing" ? " / Request sent" : selected.friend_request === "both" ? " / Requests exchanged" : ""}` : "Choose a peer or group to get started"}</text>
    </box>
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}>
      <box paddingLeft={2} paddingRight={1} flexShrink={0} flexDirection="column">
        {hasRooms && !controlStatus.connected && <box flexDirection="column" flexShrink={0}>
          <text id="rendezvous-warning" fg={flashingWarningColor} wrapMode="word">{controlStatus.control_url ? `Out-of-sync with MeshTalk rendezvous server. Peer connectivity may degrade over time; reconnecting (${controlStatus.reconnect_attempts}). LAN-only chats keep working.` : "Remote discovery is not configured. LAN-only? You're good — remote discovery is optional. Open Ctrl+P > Connection to connect these rooms."}</text>
          <box id="rendezvous-actions" flexDirection="row" gap={2}>
            <box id="rendezvous-action-open" onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); openConnection() } }}><text fg={theme.accent} wrapMode="none"><u>Ctrl+P Open connection</u></text></box>
            {!dismissedEmpty["rendezvous"] && <box id="rendezvous-action-dismiss" onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); setDismissedEmpty(current => updateBoundedEntry(current, "rendezvous", true, MAX_CONVERSATION_TIP_ENTRIES)) } }}><text fg={theme.accent} wrapMode="none"><u>Dismiss</u></text></box>}
            {dismissedEmpty["rendezvous"] && <box id="rendezvous-action-show" onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); setDismissedEmpty(current => updateBoundedEntry(current, "rendezvous", false, MAX_CONVERSATION_TIP_ENTRIES)) } }}><text fg={theme.accent} wrapMode="none"><u>Show</u></text></box>}
          </box>
        </box>}
        {selected && <>
{(selected.delivery_warnings ?? []).map(kind => kind === "offline" ? <text id="offline-warning" key={kind} fg={flashingWarningColor} wrapMode="word">Offline: messages queue until this peer reconnects.</text> : kind === "not_friend" && !hasFriendActions ? <text id="friend-warning" key={kind} fg={flashingWarningColor} wrapMode="word">Messaging is blocked until you become friends. Ctrl+P &gt; Friends &gt; Add friend.</text> : null)}
          {selectedHasCapabilityGap && <text id="capability-warning" fg={flashingWarningColor} wrapMode="word">Limited: {capabilityGapMessage}</text>}
          {hasFriendActions && <box id="friend-inline-actions" flexDirection="column">
            <text fg={theme.muted} wrapMode="word">{peerFriendStatusText(selected!)}</text>
            <box flexDirection="row" gap={2}>
              {inlineFriendActions(selected!).map((action, index) => <box key={action.id} id={`friend-inline-${action.id}`} onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); onFriendAction!(action.id) } }}><text fg={index === 0 ? theme.accent : theme.muted}><u>{action.label}</u></text></box>)}
            </box>
          </box>}
        </>}
        {selectedGroup && limitedGroupMembers.length > 0 && <text id="group-capability-warning" fg={flashingWarningColor} wrapMode="word">Limited features: {limitedGroupMembers.map(member => member.display_name).join(", ")}. Shared features remain available.</text>}
      </box>
       <scrollbox ref={scrollboxRef} focused={scrollFocused && !dialogOpen} viewportCulling={true} onMouseDown={() => setScrollFocused(true)} onMouseScroll={() => { notifyImageViewportChanged(); queueMicrotask(() => visibleUnreadCheck.current()) }} onKeyDown={(key) => { if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)) queueMicrotask(() => { notifyImageViewportChanged(); visibleUnreadCheck.current() }) }} onSizeChange={() => { notifyImageViewportChanged(); queueMicrotask(() => visibleUnreadCheck.current()) }} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 2, paddingRight: 1 }} contentOptions={{ flexDirection: "column" }} stickyScroll stickyStart="bottom" verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas } }}>
        {!selected && !selectedGroup && !dismissedEmpty["no-selection"] ? <box marginTop={1} flexDirection="column"><text fg={theme.text}><b>A little closer, wherever you are.</b></text><EmptyState id="empty-no-selection" message="No conversation selected. Pick a chat with Ctrl+Up/Down, or start something new." compact={compact || width < 70} actions={[
            { id: "add", label: "Add friend", hint: "Ctrl+F", onSelect: () => { if (onAddFriend) onAddFriend(); else openSettings() } },
            { id: "create", label: "Create group", onSelect: () => { if (onCreateGroup) onCreateGroup(); else openSettings() } },
            { id: "join", label: "Join with invite", onSelect: () => { if (onJoinGroup) onJoinGroup(); else openSettings() } },
            ...(onOpenHelp ? [{ id: "help", label: "Keyboard shortcuts", hint: "Ctrl+/", onSelect: () => onOpenHelp() } as const] : []),
            { id: "dismiss", label: "Hide tips", onSelect: () => setDismissedEmpty(current => updateBoundedEntry(current, "no-selection", true, MAX_CONVERSATION_TIP_ENTRIES)) },
          ]} /></box> : null}
        {!selected && !selectedGroup && dismissedEmpty["no-selection"] ? <box marginTop={1} id="empty-no-selection-dismissed" onMouseDown={event => { if (event.button === 0) setDismissedEmpty(current => updateBoundedEntry(current, "no-selection", false, MAX_CONVERSATION_TIP_ENTRIES)) }}><text fg={theme.muted} wrapMode="word">Choose a peer or group to get started. <span fg={theme.accent}><u>Show tips</u></span></text></box> : null}
        {conversationLoading ? <box style={{ alignItems: "center", marginTop: 2 }}><text fg={theme.warning}>Loading Messages</text></box> : null}
        {selected && friendState === "friend" && !conversationLoading && !conversationItems.length && !showConversationTips[dismissKey] ? <box id="empty-conversation-dm" style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1 }}>
          <text fg={theme.muted} wrapMode="word">No messages yet. Say hello.</text>
          <box id="empty-conversation-dm-tips" onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); setShowConversationTips(current => updateBoundedEntry(current, dismissKey, true, MAX_CONVERSATION_TIP_ENTRIES)) } }}><text fg={theme.accent}><u>Tips</u></text></box>
        </box> : null}
        {selected && friendState === "friend" && !conversationLoading && !conversationItems.length && showConversationTips[dismissKey] ? <EmptyState id="empty-conversation-dm-tips-expanded" message="No messages yet. Say hello." compact={compact || width < 70} actions={[
            { id: "write", label: "Write first message", hint: "Enter", onSelect: () => setScrollFocused(false) },
            { id: "attach", label: "Attach file", hint: "Ctrl+U", onSelect: () => onAttachFile?.() },
            { id: "dismiss", label: "Hide tips", onSelect: () => setShowConversationTips(current => updateBoundedEntry(current, dismissKey, false, MAX_CONVERSATION_TIP_ENTRIES)) },
          ].filter(action => action.id !== "attach" || onAttachFile !== undefined)} /> : null}
        {selectedGroup && !conversationLoading && !conversationItems.length && !showConversationTips[dismissKey] ? <box id="empty-conversation-group" style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1 }}>
          <text fg={theme.muted} wrapMode="word">No messages yet. Say hello to the group.</text>
          <box id="empty-conversation-group-tips" onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); setShowConversationTips(current => updateBoundedEntry(current, dismissKey, true, MAX_CONVERSATION_TIP_ENTRIES)) } }}><text fg={theme.accent}><u>Tips</u></text></box>
        </box> : null}
        {selectedGroup && !conversationLoading && !conversationItems.length && showConversationTips[dismissKey] ? <EmptyState id="empty-conversation-group-tips-expanded" message="No messages yet. Say hello to the group." compact={compact || width < 70} actions={[
            { id: "write", label: "Write first message", hint: "Enter", onSelect: () => setScrollFocused(false) },
            { id: "attach", label: "Attach file", hint: "Ctrl+U", onSelect: () => onAttachFile?.() },
            { id: "dismiss", label: "Hide tips", onSelect: () => setShowConversationTips(current => updateBoundedEntry(current, dismissKey, false, MAX_CONVERSATION_TIP_ENTRIES)) },
          ].filter(action => action.id !== "attach" || onAttachFile !== undefined)} /> : null}
        {conversationItems.map((item, index) => {
          const rows: ReactNode[] = []
          const previous = conversationItems[index - 1]
          if (!previous || dayKey(previous.createdAt) !== dayKey(item.createdAt)) {
            rows.push(
              <box key={`sep-${dayKey(item.createdAt)}`} style={{ alignItems: "center", marginTop: 1, marginBottom: 1 }}>
                <text fg={theme.muted}>{formatDateSeparator(item.createdAt)}</text>
              </box>,
            )
          }
          if (item.type === "file") {
            const file = item.file
            const isLocal = file.sender_id === identity?.peer_id
            rows.push(
              <ConversationFileRow
                key={`file-${file.file_id}`}
                file={file}
                fileDeliveries={fileDeliveriesById.get(file.file_id) ?? []}
                fileUnavailable={isLocalFileMissing(file.file_path) && file.status !== "queued" && file.status !== "transferring" && file.status !== "receiving"}
                isLocal={isLocal}
senderName={selectedGroup ? groupMemberNames.get(file.sender_id) ?? peerNames.get(file.sender_id) ?? "Unknown member" : undefined}
                selectedGroup={Boolean(selectedGroup)}
                selectedPeerName={selected?.display_name}
                selectedReplyTargetId={selectedReplyTargetId}
                scrollFocused={scrollFocused}
                fileReplyHighlighted={replyHighlight?.id === file.file_id}
                canRetryFile={isLocal && (file.status === "failed" || file.status === "blocked" || file.status === "unavailable")}
                retryEnabled={onRetryFile !== undefined}
                imageProtocol={imageProtocol}
                width={width}
                messageRefs={messageRefs}
                handlers={rowHandlers}
              />,
            )
            return rows
          }
          const message = item.message
          const isLocal = message.sender_id === identity?.peer_id
          const unread = !isLocal ? unreadMessageStates[message.message_id] : undefined
          const replyHighlighted = replyHighlight?.id === message.message_id
          const selectedRow = scrollFocused && selectedReplyTargetId === message.message_id
          const unreadHighlighted = unread?.visibleAt !== undefined && !replyHighlighted && !selectedRow
          const isSystem = Boolean(selectedGroup && message.kind && message.kind !== "message" && message.kind !== "text")
const senderName = selectedGroup ? groupMemberNames.get(message.sender_id) ?? peerNames.get(message.sender_id) ?? "Unknown member" : selected?.display_name ?? "Unknown member"
          const replyTarget = message.reply_to_message_id ? conversationItemById.get(message.reply_to_message_id) : undefined
          const replySenderId = replyTarget?.type === "message" ? replyTarget.message.sender_id : replyTarget?.file.sender_id
const replySender = replySenderId === identity?.peer_id ? "You"
            : replySenderId ? (selectedGroup ? groupMemberNames.get(replySenderId) ?? peerNames.get(replySenderId) : selected?.display_name) ?? "Unknown member" : undefined
          const replyContent = replyTarget?.type === "message" ? replyTarget.message.content : replyTarget ? `Attachment: ${replyTarget.file.filename}` : undefined
          const replySnippet = replyContent?.replace(/\s+/g, " ").trim().slice(0, 60)
          const renderedContent = isSystem
            ? message.kind === "join"
              ? `${isLocal ? "You" : senderName} joined the group`
              : message.kind === "leave"
                ? `${isLocal ? "You" : senderName} left the group`
                : message.content
            : message.content
          rows.push(
            <ConversationMessageRow
              key={message.message_id}
              message={message}
              isLocal={isLocal}
              isSystem={isSystem}
              senderName={senderName}
              renderedContent={renderedContent}
              replyTarget={replyTarget}
              replySender={replySender}
              replyContent={replyContent}
              replySnippet={replySnippet}
              selectedRow={selectedRow}
              unreadHighlighted={unreadHighlighted}
              replyHighlighted={replyHighlighted}
              delivered={Boolean(message.delivered) || deliveredMessageIds.has(message.message_id)}
              blocked={Boolean(message.blocked)}
              queued={Boolean(message.queued)}
              failed={Boolean(message.failed)}
              showReceived={typeof message.received_at === "number" && formatTimeMinute(message.received_at) !== formatTimeMinute(message.created_at)}
              messageSyntaxStyle={messageSyntaxStyle}
              messageRefs={messageRefs}
              handlers={rowHandlers}
            />,
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
    <ChatFooter width={width} status={status} openSettings={openSettings} onOpenHelp={onOpenHelp} />
  </box>
}
