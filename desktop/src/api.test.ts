import { expect, test } from "bun:test"
import { conversationKey, mergeMessages, sendTarget, target } from "./api"

test("switching conversations cannot drop failed or pending sends", () => {
  const pending = { message_id: "pending", pending: true, created_at: 2 }
  const failed = { message_id: "failed", failed: true, created_at: 3 }
  const delivered = { message_id: "sent", delivered: 1, created_at: 1 }
  expect(mergeMessages([delivered], [pending, failed, delivered])).toEqual([delivered, pending, failed])
  expect(mergeMessages([{ ...pending, pending: false }], [pending])).toHaveLength(1)
})

test("group and peer identifiers cannot alias conversation caches or IPC fields", () => {
  const peer = { kind: "peer" as const, id: "same", name: "P" }
  const group = { kind: "group" as const, id: "same", name: "G" }
  expect(conversationKey(peer)).not.toBe(conversationKey(group))
  expect(target(peer)).toEqual({ peer_id: "same" })
  expect(sendTarget(peer)).toEqual({ recipient_id: "same" })
  expect(sendTarget(group)).toEqual({ group_id: "same" })
})
