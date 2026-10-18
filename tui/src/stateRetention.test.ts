import { expect, test } from "bun:test"
import { retainRecentEntries, sameResponse, updateBoundedEntry } from "./stateRetention"

test("bounded records evict the oldest entry and keep the latest update", () => {
  const initial = { first: 1, second: 2 }
  const next = updateBoundedEntry(initial, "third", 3, 2)

  expect(next).toEqual({ second: 2, third: 3 })
  expect(updateBoundedEntry(next, "second", 4, 2)).toEqual({ third: 3, second: 4 })
  expect(updateBoundedEntry(next, "third", 3, 2)).toBe(next)
})

test("retention leaves small records untouched and caps large records", () => {
  const small = { one: 1 }
  expect(retainRecentEntries(small, 2)).toBe(small)
  expect(retainRecentEntries({ one: 1, two: 2, three: 3 }, 2)).toEqual({ two: 2, three: 3 })
})

test("response comparison skips structurally identical payloads", () => {
  expect(sameResponse([{ id: "a" }], [{ id: "a" }])).toBe(true)
  expect(sameResponse([{ id: "a" }], [{ id: "b" }])).toBe(false)
})
