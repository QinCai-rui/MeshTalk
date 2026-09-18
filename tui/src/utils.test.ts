import { expect, test } from "bun:test"
import { groupDeliveryLabel, isMuteActive, normalizeDeliveryStatus } from "./utils"

test("treats only permanent and unexpired mutes as active", () => {
  const now = 1_000
  expect(isMuteActive(undefined, now)).toBe(false)
  expect(isMuteActive(0, now)).toBe(true)
  expect(isMuteActive(1_001, now)).toBe(true)
  expect(isMuteActive(1_000, now)).toBe(false)
})

test("normalizes file transfer delivery statuses to message buckets", () => {
  expect(normalizeDeliveryStatus("completed")).toBe("delivered")
  expect(normalizeDeliveryStatus("transferring")).toBe("pending")
  expect(normalizeDeliveryStatus("receiving")).toBe("pending")
  expect(normalizeDeliveryStatus("delivered")).toBe("delivered")
  expect(normalizeDeliveryStatus("queued")).toBe("queued")
  expect(normalizeDeliveryStatus("unavailable")).toBe("unavailable")
  expect(normalizeDeliveryStatus("sent")).toBe("sent")
  expect(normalizeDeliveryStatus("failed")).toBe("failed")
  expect(normalizeDeliveryStatus("blocked")).toBe("blocked")
})

test("counts completed file deliveries as delivered", () => {
  const deliveries = [
    { recipient_id: "a", display_name: "A", status: "completed", updated_at: 1 },
    { recipient_id: "b", display_name: "B", status: "completed", updated_at: 1 },
    { recipient_id: "c", display_name: "C", status: "queued", updated_at: 1 },
    { recipient_id: "d", display_name: "D", status: "unavailable", updated_at: 1 },
    { recipient_id: "e", display_name: "E", status: "transferring", updated_at: 1 },
  ]
  expect(groupDeliveryLabel(deliveries)).toBe("delivered 2/5 · queued 1 · unavailable 1 · pending 1")
})

test("surfaces unknown delivery statuses instead of dropping them", () => {
  const deliveries = [
    { recipient_id: "a", display_name: "A", status: "delivered", updated_at: 1 },
    { recipient_id: "b", display_name: "B", status: "warp-drive", updated_at: 1 },
  ]
  expect(groupDeliveryLabel(deliveries)).toBe("delivered 1/2 · other 1")
})
