import type { ConversationItem, Group, GroupDelivery, Peer } from "./types"
import type { TextareaRenderable } from "@opentui/core"
import { chatTheme as theme, unreadMessageBackground as unreadBackground } from "./chatTheme"

export const MIN_COMPOSER_HEIGHT = 3
export const MAX_COMPOSER_HEIGHT = 5
export const MAX_MESSAGE_BYTES = 30 * 1024
export const UNREAD_MESSAGE_FADE_MS = 3_000
export const DEFAULT_STATUS = "Ctrl+P: Settings  Ctrl+U: upload  Ctrl+V: paste image  Ctrl+Up/Down: switch chats  PgUp: history  Ctrl+C: quit"

export function getComposerHeight(composer: TextareaRenderable | null): number {
  const lines = composer?.editorView.getTotalVirtualLineCount() ?? 0
  return Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, lines))
}

export function formatTime(timestamp: number): string { return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }
export function formatDateTime(timestamp: number): string { const d = new Date(timestamp * 1000); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)} ${formatTime(timestamp)}` }
export function formatDateSeparator(timestamp: number): string { return new Date(timestamp * 1000).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }) }
export function dayKey(timestamp: number): string { const d = new Date(timestamp * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
export function formatTimeMinute(timestamp: number): string { const d = new Date(timestamp * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}` }
export function transportName(transport?: Peer["active_transport"]): string { return transport === "lan_tcp" ? "LAN TCP" : transport === "remote_udp" ? "Remote UDP" : transport === "remote_derp" ? "MeshTalk Embedded Relay" : "No endpoint" }
export function peerConnectionLabel(peer: Peer): string { if (!peer.is_online) return "Offline"; return peer.active_transport === "lan_tcp" ? "Direct (TCP)" : peer.active_transport === "remote_udp" ? "Direct (UDP)" : peer.active_transport === "remote_derp" ? "MeshTalk Relay" : "No endpoint" }
export function peerPresence(peer: Peer): "active" | "away" | "offline" { return peer.presence ?? "offline" }
export function sortPeersByInteraction(peers: Peer[]): Peer[] { return [...peers].sort((a, b) => (b.last_interaction ?? 0) - (a.last_interaction ?? 0) || a.display_name.localeCompare(b.display_name)) }
export function friendMarkers(peer: Peer): string { const markers: string[] = []; if (peer.is_friend) markers.push("\u2665"); if (peer.friend_request === "incoming" || peer.friend_request === "both") markers.push("\u2199"); if (peer.friend_request === "outgoing" || peer.friend_request === "both") markers.push("\u2197"); return markers.length ? ` ${markers.join("")}` : "" }

export type FriendState = "friend" | "incoming" | "outgoing" | "both" | "blocked" | "stranger"

export function peerFriendState(peer: Peer): FriendState {
  if (peer.is_blocked) return "blocked"
  if (peer.is_friend) return "friend"
  if (peer.friend_request === "incoming" || peer.friend_request === "outgoing" || peer.friend_request === "both") return peer.friend_request
  return "stranger"
}

export function peerFriendStatusText(peer: Peer): string {
  const state = peerFriendState(peer)
  if (state === "friend") return "Friends — messages go through."
  if (state === "incoming") return "They sent you a friend request."
  if (state === "outgoing") return "Friend request sent — waiting for them to accept."
  if (state === "both") return "You both sent requests — accept to become friends."
  if (state === "blocked") return "Blocked — their requests and messages are ignored."
  return "Not friends yet — messages are blocked until they accept."
}

export type InlineFriendAction = "add" | "cancel" | "accept" | "decline" | "block" | "unblock" | "inbox"

export function inlineFriendActions(peer: Peer): { id: InlineFriendAction; label: string; hint: string }[] {
  const state = peerFriendState(peer)
  if (state === "friend") return [{ id: "inbox", label: "Inbox", hint: "Alt+1" }]
  if (state === "blocked") return [
    { id: "unblock", label: "Unblock", hint: "Alt+1" },
    { id: "inbox", label: "Inbox", hint: "Alt+2" },
  ]
  if (state === "incoming") return [
    { id: "accept", label: "Accept", hint: "Alt+1" },
    { id: "decline", label: "Decline", hint: "Alt+2" },
    { id: "block", label: "Block", hint: "Alt+3" },
  ]
  if (state === "outgoing") return [
    { id: "cancel", label: "Cancel request", hint: "Alt+1" },
    { id: "block", label: "Block", hint: "Alt+2" },
    { id: "inbox", label: "Inbox", hint: "Alt+3" },
  ]
  if (state === "both") return [
    { id: "accept", label: "Accept", hint: "Alt+1" },
    { id: "decline", label: "Decline", hint: "Alt+2" },
    { id: "cancel", label: "Cancel mine", hint: "Alt+3" },
    { id: "block", label: "Block", hint: "Alt+4" },
  ]
  return [
    { id: "add", label: "Add friend", hint: "Alt+1" },
    { id: "block", label: "Block", hint: "Alt+2" },
    { id: "inbox", label: "Inbox", hint: "Alt+3" },
  ]
}

export function addablePeers(peers: Peer[], identityPeerId?: string): Peer[] {
  return peers.filter((peer) => peer.peer_id !== identityPeerId && !peer.is_friend && !peer.is_blocked && !peer.friend_request).sort((a, b) => a.display_name.localeCompare(b.display_name))
}
export function composerLimitColor(length: number): string | undefined { const usage = length / MAX_MESSAGE_BYTES; if (usage >= 1) return theme.danger; if (usage >= 0.9) return theme.caution; if (usage >= 0.75) return theme.warning; return undefined }
export const unreadMessageBackground = unreadBackground
export function groupDeliveryLabel(deliveries: GroupDelivery[] = []): string {
  if (!deliveries.length) return "sent"
  const delivered = deliveries.filter((delivery) => delivery.status === "delivered").length
  const queued = deliveries.filter((delivery) => delivery.status === "queued").length
  const unavailable = deliveries.filter((delivery) => delivery.status === "unavailable").length
  const details = [`delivered ${delivered}/${deliveries.length}`]
  if (queued) details.push(`queued ${queued}`)
  if (unavailable) details.push(`unavailable ${unavailable}`)
  return details.join(" · ")
}
export function groupFromResponse(response: Record<string, unknown>): Group | undefined { if (response.group && typeof response.group === "object") return response.group as Group; if (typeof response.group_id !== "string" || typeof response.name !== "string") return undefined; return { group_id: response.group_id, name: response.name, member_count: 1, unread_count: 0 } }
export type RenderType = "FULL_HEADER" | "COMPACT_ROW";
// Intentional deviation from a sliding inter-message gap: the 8-minute window
// is anchored at the FIRST message of the group (Discord's current behavior),
// so continuous typing can never extend a group indefinitely.
export const MESSAGE_GROUP_CEILING_SECONDS = 480;

function groupingAuthor(item: ConversationItem): string {
  return item.type === "message" ? item.message.sender_id : item.file.sender_id;
}

function groupingIsReply(item: ConversationItem): boolean {
  return item.type === "message" && Boolean(item.message.reply_to_message_id);
}

export function isSystemMessage(message: { kind?: string | null }, isGroup: boolean): boolean {
  return Boolean(isGroup && message.kind && message.kind !== "message" && message.kind !== "text");
}

function groupingIsSystem(item: ConversationItem, isGroup: boolean): boolean {
  return item.type === "message" && isSystemMessage(item.message, isGroup);
}

export function groupDeliveriesNeedAttention(deliveries: GroupDelivery[] = []): boolean {
  return deliveries.some((delivery) => delivery.status !== "delivered" && delivery.status !== "sent");
}

export function groupRowMarginBottom(renderTypes: readonly RenderType[], index: number): 0 | 1 {
  return renderTypes[index + 1] === "COMPACT_ROW" ? 0 : 1;
}
export function computeRenderTypes(items: ConversationItem[], isGroup = true): RenderType[] {
  const result: RenderType[] = [];
  let currentGroupAuthorId: string | undefined;
  let currentGroupStartTimestamp = 0;
  let currentGroupDate = "";
  let prevWasSystem = false;
  for (const item of items) {
    const authorId = groupingAuthor(item);
    const timestamp = item.createdAt;
    const date = dayKey(timestamp);
    const isBreakType = groupingIsReply(item) || groupingIsSystem(item, isGroup);
    const shouldStartNewGroup =
      result.length === 0 ||
      authorId !== currentGroupAuthorId ||
      timestamp - currentGroupStartTimestamp >= MESSAGE_GROUP_CEILING_SECONDS ||
      isBreakType ||
      prevWasSystem ||
      date !== currentGroupDate;
    if (shouldStartNewGroup) {
      result.push("FULL_HEADER");
      currentGroupAuthorId = authorId;
      currentGroupStartTimestamp = timestamp;
      currentGroupDate = date;
    } else {
      result.push("COMPACT_ROW");
    }
    prevWasSystem = groupingIsSystem(item, isGroup);
  }
  return result;
}
export function isImageFile(filename: string): boolean { return ["png", "jpg", "jpeg", "gif", "webp"].includes(filename.split(".").pop()?.toLowerCase() ?? "") }
export function toFileUrl(path: string, version?: number | null): string { let normalized = path.replace(/\\/g, "/"); if (/^[a-zA-Z]:\//.test(normalized)) normalized = "/" + normalized; const encoded = normalized.split("/").map((segment) => encodeURIComponent(segment)).join("/"); return "file://" + encoded + (version != null ? `?v=${version}` : "") }
export function terminalWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined) continue
    if (codePoint >= 0x0300 && codePoint <= 0x036F) continue
    if (codePoint >= 0x1AB0 && codePoint <= 0x1AFF) continue
    if (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) continue
    if (codePoint >= 0x20D0 && codePoint <= 0x20FF) continue
    if (codePoint >= 0xFE20 && codePoint <= 0xFE2F) continue
    width += codePoint > 0xff ? 2 : 1
  }
  return width
}
export function clipTextToWidth(text: string, maxWidth: number): string {
  const chars: string[] = []
  let width = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined) continue
    const isCombining = (codePoint >= 0x0300 && codePoint <= 0x036F) || (codePoint >= 0x1AB0 && codePoint <= 0x1AFF) || (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) || (codePoint >= 0x20D0 && codePoint <= 0x20FF) || (codePoint >= 0xFE20 && codePoint <= 0xFE2F)
    const charWidth = isCombining ? 0 : codePoint > 0xff ? 2 : 1
    if (width + charWidth > maxWidth) break
    chars.push(char)
    width += charWidth
  }
  return chars.join("")
}
