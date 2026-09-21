import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageStatus } from "./MessageStatus"

test("SQLite zero status flags do not render stray zeros under messages", () => {
  for (const own of [true, false]) {
    const html = renderToStaticMarkup(<MessageStatus message={{ failed: 0, queued: 0, pending: 0 }} own={own} restore={() => {}} name={id => id} />)
    expect(html).toBe("")
  }
})

test("pending state takes precedence over queued state; receipts remain available", () => {
  const html = renderToStaticMarkup(<MessageStatus message={{ pending: 1, queued: 1, failed: 0, deliveries: [{ recipient_id: "alice", status: "delivered" }] }} own restore={() => {}} name={() => "Alice"} />)
  expect(html).toContain("Sending…")
  expect(html).not.toContain("Queued —")
  expect(html).toContain("Delivered to 1 of 1")
  expect(html).toContain("Alice")
})
