import { invoke } from "@tauri-apps/api/core"
export type Row = Record<string, any>
export async function request<T = Row>(action: string, params: Row = {}): Promise<T> {
  return invoke<T>("request", { action, params })
}
export { invoke }
export type Conversation = { kind: "peer" | "group"; id: string; name: string }
export function target(conversation: Conversation) {
  return conversation.kind === "group" ? { group_id: conversation.id } : { peer_id: conversation.id }
}
export function sendTarget(conversation: Conversation) {
  return conversation.kind === "group" ? { group_id: conversation.id } : { recipient_id: conversation.id }
}
export function conversationKey(conversation: Conversation) { return `${conversation.kind}:${conversation.id}` }
export function mergeMessages(history: Row[], local: Row[]) {
  const ids = new Set(history.map(row => row.message_id))
  return [...history, ...local.filter(row => (row.pending || row.failed) && !ids.has(row.message_id))]
    .sort((a, b) => a.created_at - b.created_at)
}
