import { expect, test } from "bun:test"
import { createDemoClient } from "./demo"

test("demo changes are isolated to one in-memory client", async () => {
  const first = createDemoClient()
  const second = createDemoClient()
  await first.invoke("request", { action: "set_display_name", params: { display_name: "Casey" } })
  await first.invoke("request", { action: "analytics", params: { level: "extended" } })
  expect(await first.invoke("request", { action: "identity" })).toMatchObject({ display_name: "Casey" })
  expect(await second.invoke("request", { action: "identity" })).toMatchObject({ display_name: "Alex Morgan" })
  expect(await second.invoke("request", { action: "analytics" })).toMatchObject({ analytics_level: "off" })
  await expect(first.invoke("choose_attachments")).rejects.toThrow("Native desktop actions are unavailable")
})

test("demo supports sample search, send, and listener cleanup", async () => {
  const client = createDemoClient()
  let events = 0
  const unlisten = client.listen("backend-event", () => events++)
  const sent = await client.invoke("request", { action: "send", params: { recipient_id: "alice", content: "Sample test message" } })
  expect(sent).toHaveProperty("message_id")
  const result = await client.invoke("request", { action: "search_messages", params: { peer_id: "alice", query: "Sample test" } })
  expect(result).toMatchObject({ next_offset: null, results: [{ content: "Sample test message", kind: "peer", conversation_id: "alice" }] })
  expect(events).toBe(1)
  unlisten()
  await client.invoke("request", { action: "dnd", params: { enabled: true } })
  expect(events).toBe(1)
})
