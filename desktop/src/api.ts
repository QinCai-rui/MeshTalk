import { invoke as tauriInvoke } from "@tauri-apps/api/core"
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event"
export type Row = Record<string, any>
export const demoMode = import.meta.env?.DEV === true && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo") && !("__TAURI_INTERNALS__" in window)
const demoClient = demoMode ? import("./demo").then(module => module.createDemoClient()) : undefined
export async function invoke<T = unknown>(command: string, args?: Row): Promise<T> {
  if (demoClient) return (await demoClient).invoke(command, args) as Promise<T>
  return tauriInvoke<T>(command, args)
}
export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  if (demoClient) return (await demoClient).listen(event, payload => handler({ event, id: 0, payload: payload as T }))
  return tauriListen<T>(event, handler)
}
export async function request<T = Row>(action: string, params: Row = {}): Promise<T> {
  return invoke<T>("request", { action, params })
}
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
