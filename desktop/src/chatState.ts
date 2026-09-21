import type { Conversation, Row } from "./api"

export const MAX_MESSAGE_BYTES = 30 * 1024
export function isMuted(until: number | undefined, now = Date.now() / 1000) { return until !== undefined && (until === 0 || until > now) }
export function restore<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback } catch { return fallback }
}
export function persist(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }
export function conversations(peers: Row[], groups: Row[], self: string): Conversation[] {
  return [...peers.filter(p => p.peer_id !== self && !p.is_blocked).map(p => ({ kind: "peer" as const, id: p.peer_id, name: p.display_name })), ...groups.map(g => ({ kind: "group" as const, id: g.group_id, name: g.name }))]
}
export function mentionAt(text: string, cursor: number) {
  const match = text.slice(0, cursor).match(/(?:^|\s)@([^@\s<>]*)$/)
  return match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : undefined
}
export function groupFiles(files: Row[]) {
  const grouped = new Map<string, Row>()
  for (const file of files) {
    const existing = grouped.get(file.file_id)
    if (existing) {
      const deliveries = existing.deliveries as Row[]
      if (file.recipient_id && !deliveries.some(d => d.recipient_id === file.recipient_id)) deliveries.push({ recipient_id: file.recipient_id, status: file.status })
    } else grouped.set(file.file_id, { ...file, deliveries: [...(file.deliveries ?? (file.group_id && file.recipient_id ? [{ recipient_id: file.recipient_id, status: file.status }] : []))] })
  }
  return [...grouped.values()]
}
