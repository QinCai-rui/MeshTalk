import { expect, test } from "bun:test"
import {
  applyMentionCompletion,
  filterMentionCandidates,
  mentionQueryAt,
  mentionsPeer,
  parseMentions,
  renderMentionedContent,
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

test("applyMentionCompletion replaces @query with a token", () => {
  let text = "hello @al"
  let cursor = text.length
  const editor = {
    deleteCharBackward: () => {
      text = text.slice(0, cursor - 1) + text.slice(cursor)
      cursor -= 1
    },
    insertText: (value: string) => {
      text = text.slice(0, cursor) + value + text.slice(cursor)
      cursor += value.length
    },
  }
  applyMentionCompletion(editor, 2, "alex-id")
  expect(text).toBe("hello <@alex-id> ")
  expect(cursor).toBe(text.length)
})
