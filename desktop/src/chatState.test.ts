import { expect, test } from "bun:test"
import { conversations, groupFiles, isMuted, mentionAt } from "./chatState"

test("conversation helpers exclude self and preserve peer/group identity", () => {
  expect(conversations([{ peer_id: "me", display_name: "Me" }, { peer_id: "a", display_name: "A" }], [{ group_id: "a", name: "Group" }], "me"))
    .toEqual([{ kind: "peer", id: "a", name: "A" }, { kind: "group", id: "a", name: "Group" }])
})

test("mention detection only targets the active token", () => {
  expect(mentionAt("Hello @ali", 10)).toEqual({ start: 6, end: 10, query: "ali" })
  expect(mentionAt("Email a@b", 9)).toBeUndefined()
})

test("transfer grouping retains recipient delivery states", () => {
  const files = groupFiles([{ file_id: "f", recipient_id: "a", group_id: "g", status: "sent" }, { file_id: "f", recipient_id: "b", group_id: "g", status: "queued" }])
  expect(files).toHaveLength(1)
  expect(files[0].deliveries).toEqual([{ recipient_id: "a", status: "sent" }, { recipient_id: "b", status: "queued" }])
  expect(isMuted(0)).toBe(true)
  expect(isMuted(1, 2)).toBe(false)
})
