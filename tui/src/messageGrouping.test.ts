import { expect, test } from "bun:test";
import type { ConversationItem } from "./types";
import { MESSAGE_GROUP_WINDOW_SECONDS, shouldGroupWithPrev } from "./utils";

function msg(id: string, sender: string, createdAt: number, extra = {}): ConversationItem {
  return {
    type: "message",
    createdAt,
    message: {
      message_id: id,
      sender_id: sender,
      content: id,
      created_at: createdAt,
      ...extra,
    },
  };
}

function file(id: string, sender: string, createdAt: number): ConversationItem {
  return {
    type: "file",
    createdAt,
    file: {
      file_id: id,
      filename: `${id}.png`,
      file_size: 100,
      sender_id: sender,
      recipient_id: "peer",
      direction: "outbound",
      status: "sent",
      created_at: createdAt,
    },
    allFiles: [],
  };
}

const T0 = 1_700_000_000;

test("groups quick consecutive messages from the same sender", () => {
  expect(shouldGroupWithPrev(msg("a", "alice", T0), msg("b", "alice", T0 + 60))).toBe(true);
});

test("first message never groups", () => {
  expect(shouldGroupWithPrev(undefined, msg("a", "alice", T0))).toBe(false);
});

test("different sender breaks the group", () => {
  expect(shouldGroupWithPrev(msg("a", "alice", T0), msg("b", "bob", T0 + 10))).toBe(false);
});

test("5+ minute gap breaks the group", () => {
  expect(
    shouldGroupWithPrev(
      msg("a", "alice", T0),
      msg("b", "alice", T0 + MESSAGE_GROUP_WINDOW_SECONDS),
    ),
  ).toBe(false);
  expect(
    shouldGroupWithPrev(
      msg("a", "alice", T0),
      msg("b", "alice", T0 + MESSAGE_GROUP_WINDOW_SECONDS - 1),
    ),
  ).toBe(true);
});

test("day change breaks the group", () => {
  // A week later is a different calendar day in every timezone.
  const nextWeek = T0 + 7 * 24 * 3600;
  expect(shouldGroupWithPrev(msg("a", "alice", T0), msg("b", "alice", nextWeek))).toBe(false);
});

test("reply always starts a fresh header", () => {
  expect(
    shouldGroupWithPrev(
      msg("a", "alice", T0),
      msg("b", "alice", T0 + 10, { reply_to_message_id: "a" }),
    ),
  ).toBe(false);
});

test("system messages never group", () => {
  const join = msg("j", "alice", T0 + 10, { kind: "join" });
  expect(shouldGroupWithPrev(msg("a", "alice", T0), join)).toBe(false);
  expect(shouldGroupWithPrev(join, msg("b", "alice", T0 + 20))).toBe(false);
});

test("files group with adjacent same-sender messages", () => {
  expect(shouldGroupWithPrev(msg("a", "alice", T0), file("f", "alice", T0 + 10))).toBe(true);
  expect(shouldGroupWithPrev(file("f", "alice", T0), msg("b", "alice", T0 + 10))).toBe(true);
  expect(shouldGroupWithPrev(file("f", "alice", T0), file("g", "alice", T0 + 10))).toBe(true);
  expect(shouldGroupWithPrev(msg("a", "alice", T0), file("f", "bob", T0 + 10))).toBe(false);
});
