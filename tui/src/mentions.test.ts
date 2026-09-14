import { expect, test } from "bun:test"
import {
  filterMentionCandidates,
  mentionQueryAt,
  mentionsPeer,
  parseMentions,
  payloadMentions,
  renderMentionedContent,
  spansToTokens,
  updateSpansAfterEdit,
} from "./mentions"

test("parseMentions extracts unique IDs in order", () => {
  expect(parseMentions("hello <@abc> and <@def> plus <@abc>")).toEqual(["abc", "def"])
  expect(parseMentions("no tokens here")).toEqual([])
  expect(parseMentions("not a token <@> or <@a b>")).toEqual([])
})

test("mentionsPeer detects a specific peer", () => {
  expect(mentionsPeer("hi <@abc>", "abc")).toBe(true)
  expect(mentionsPeer("hi <@abc>", "def")).toBe(false)
  expect(mentionsPeer("hi <@abc>", "")).toBe(false)
})

test("renderMentionedContent shows display names", () => {
  const names: Record<string, string> = { abc: "Alex Morgan", me: "Taylor" }
  expect(renderMentionedContent("hi <@abc> and <@me>!", (id) => names[id])).toBe(
    "hi @Alex Morgan and @Taylor!",
  )
  expect(renderMentionedContent("hi <@gone>!", (id) => names[id])).toBe("hi @unknown!")
  expect(renderMentionedContent("plain text", () => undefined)).toBe("plain text")
})

test("mentionQueryAt triggers only on @query before cursor", () => {
  expect(mentionQueryAt("hello @al", 9)).toEqual({ start: 6, query: "al" })
  expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" })
  expect(mentionQueryAt("hello @al rest", 9)).toEqual({ start: 6, query: "al" })
  // Cursor moved past the token: no popup.
  expect(mentionQueryAt("hello @al rest", 14)).toBeUndefined()
  // Emails and stored tokens never trigger.
  expect(mentionQueryAt("mail foo@bar", 12)).toBeUndefined()
  expect(mentionQueryAt("hi <@abc>", 9)).toBeUndefined()
  expect(mentionQueryAt("hi <@ab", 7)).toBeUndefined()
  expect(mentionQueryAt("no at sign", 10)).toBeUndefined()
})

test("filterMentionCandidates matches names case-insensitively", () => {
  const members = [
    { peerId: "a", displayName: "Alex Morgan" },
    { peerId: "s", displayName: "Sam Chen" },
    { peerId: "v", displayName: "Avery Away" },
  ]
  expect(filterMentionCandidates(members, "").map((m) => m.peerId)).toEqual(["a", "v", "s"])
  expect(filterMentionCandidates(members, "al").map((m) => m.peerId)).toEqual(["a"])
  expect(filterMentionCandidates(members, "A").map((m) => m.peerId)).toEqual(["a", "v", "s"])
  expect(filterMentionCandidates(members, "zzz")).toEqual([])
  expect(
    filterMentionCandidates(
      Array.from({ length: 10 }, (_, i) => ({ peerId: `p${i}`, displayName: `Member ${i}` })),
      "",
    ),
  ).toHaveLength(6)
})

test("payloadMentions reads only the server payload, never content", () => {
  expect(payloadMentions(["abc", "abc", "def"])).toEqual(["abc", "def"])
  expect(payloadMentions([])).toEqual([])
  expect(payloadMentions(undefined)).toEqual([])
  expect(payloadMentions("not-an-array")).toEqual([])
  expect(payloadMentions([123])).toEqual([])
  expect(payloadMentions(["abc", 123])).toEqual(["abc"])
})

test("updateSpansAfterEdit keeps, shifts, or drops spans", () => {
  const spans = [
    { peerId: "a", name: "Alex", start: 0, end: 5 },
    { peerId: "b", name: "Bo", start: 10, end: 13 },
  ]
  // Insertion before everything shifts all spans.
  expect(updateSpansAfterEdit(spans, "hi there", "oh hi there")).toEqual([
    { peerId: "a", name: "Alex", start: 3, end: 8 },
    { peerId: "b", name: "Bo", start: 13, end: 16 },
  ])
  // Edit overlapping the first span drops it but keeps the second (shifted).
  expect(updateSpansAfterEdit(spans, "@Alex x @Bo", "@Alx x @Bo")).toEqual([
    { peerId: "b", name: "Bo", start: 9, end: 12 },
  ])
  // Identical text keeps spans by reference.
  expect(updateSpansAfterEdit(spans, "same", "same")).toBe(spans)
})

test("spansToTokens converts validated spans only", () => {
  expect(
    spansToTokens("hi @Alex and @Bo!", [
      { peerId: "a", name: "Alex", start: 3, end: 8 },
      { peerId: "b", name: "Bo", start: 13, end: 16 },
    ]),
  ).toBe("hi <@a> and <@b>!")
  // Stale span text is left alone.
  expect(spansToTokens("hi @Alec!", [{ peerId: "a", name: "Alex", start: 3, end: 8 }])).toBe(
    "hi @Alec!",
  )
  expect(spansToTokens("plain", [])).toBe("plain")
})
