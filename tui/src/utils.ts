import type { Group, GroupDelivery, Peer } from "./types"
import type { TextareaRenderable } from "@opentui/core"

export const MIN_COMPOSER_HEIGHT = 3
export const MAX_COMPOSER_HEIGHT = 5
export const MAX_MESSAGE_BYTES = 30 * 1024
export const UNREAD_MESSAGE_FADE_MS = 3_000
export const DEFAULT_STATUS = "Ctrl+P: Commands  Ctrl+U: upload  Ctrl+V: paste image  Ctrl+Up/Down: select  Ctrl+D: remove offline  Ctrl+C: quit"

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
export function peerPresence(peer: Peer): "active" | "away" | "offline" { return peer.presence ?? "offline" }
export function sortPeersByInteraction(peers: Peer[]): Peer[] { return [...peers].sort((a, b) => (b.last_interaction ?? 0) - (a.last_interaction ?? 0) || a.display_name.localeCompare(b.display_name)) }
export function friendMarkers(peer: Peer): string { const markers: string[] = []; if (peer.is_friend) markers.push("\u2665"); if (peer.friend_request === "incoming" || peer.friend_request === "both") markers.push("\u2199"); if (peer.friend_request === "outgoing" || peer.friend_request === "both") markers.push("\u2197"); return markers.length ? ` ${markers.join("")}` : "" }
export function composerLimitColor(length: number): string | undefined { const usage = length / MAX_MESSAGE_BYTES; if (usage >= 1) return "#ff7777"; if (usage >= 0.9) return "#ff9f43"; if (usage >= 0.75) return "#e0a34a"; return undefined }
export function unreadMessageBackground(progress: number): string {
  const start = [103, 82, 40]
  const end = [40, 32, 24]
  const amount = Math.min(1, Math.max(0, progress))
  const channels = start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}
export function groupDeliveryLabel(deliveries: GroupDelivery[] = []): string { if (!deliveries.length) return "sent"; const delivered = deliveries.filter((d) => d.status === "delivered").length; const queued = deliveries.filter((d) => d.status === "queued"); const unavailable = deliveries.filter((d) => d.status === "unavailable"); const details = [`delivered ${delivered}/${deliveries.length}`]; if (queued.length) details.push(`queued for ${queued.map((d) => d.display_name).join(", ")}`); if (unavailable.length) details.push(`unavailable for ${unavailable.map((d) => d.display_name).join(", ")}`); return details.join(", ") }
export function groupFromResponse(response: Record<string, unknown>): Group | undefined { if (response.group && typeof response.group === "object") return response.group as Group; if (typeof response.group_id !== "string" || typeof response.name !== "string") return undefined; return { group_id: response.group_id, name: response.name, member_count: 1, unread_count: 0 } }
export function isImageFile(filename: string): boolean { return ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(filename.split(".").pop()?.toLowerCase() ?? "") }
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
