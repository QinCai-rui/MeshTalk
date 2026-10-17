import { expect, test } from "bun:test"
import { groupDeliveriesForDisplay } from "./DialogPanel"

const delivery = (recipient_id: string, status: string) => ({
  recipient_id,
  display_name: recipient_id,
  status,
  updated_at: 1,
})

test("groups completed file deliveries under delivered", () => {
  const grouped = groupDeliveriesForDisplay([
    delivery("a", "completed"),
    delivery("b", "completed"),
    delivery("c", "queued"),
    delivery("d", "unavailable"),
    delivery("e", "transferring"),
  ])
  expect(grouped.map(([status, deliveries]) => `${status}:${deliveries.length}`)).toEqual([
    "delivered:2",
    "queued:1",
    "pending:1",
    "unavailable:1",
  ])
})

test("never drops unknown delivery statuses", () => {
  const grouped = groupDeliveriesForDisplay([delivery("a", "warp-drive")])
  expect(grouped).toHaveLength(1)
  expect(grouped[0][0]).toBe("warp-drive")
  expect(grouped[0][1]).toHaveLength(1)
})
