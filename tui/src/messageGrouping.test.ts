import { expect, test } from "bun:test";
import {
  computeRenderTypes,
  dayKey,
  groupDeliveriesNeedAttention,
  groupRowMarginBottom,
  isSystemMessage,
} from "./utils";
import type { ConversationItem } from "./types";

function msg(id: string, sender: string, at: number): ConversationItem {
  return {
    type: "message",
    createdAt: at,
    message: { message_id: id, sender_id: sender, content: "hi", created_at: at },
  };
}

function file(id: string, sender: string, at: number): ConversationItem {
  return {
    type: "file",
    createdAt: at,
    file: {
      file_id: id,
      filename: "a.png",
      file_size: 1024,
      sender_id: sender,
      recipient_id: "bob",
      direction: "out",
      status: "sent",
      created_at: at,
    },
    allFiles: [],
  };
}

test("groups two quick messages from the same sender", () => {
  const items = [msg("m1", "alice", 1_000_000), msg("m2", "alice", 1_000_060)];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "COMPACT_ROW"]);
});

test("starts a new header when the author changes", () => {
  const items = [msg("m1", "alice", 1_000_000), msg("m2", "bob", 1_000_030)];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "FULL_HEADER"]);
});

test("enforces the 8-minute hard ceiling from the group start", () => {
  const items = [
    msg("m1", "alice", 1_000_000),
    msg("m2", "alice", 1_000_060),
    msg("m3", "alice", 1_000_120),
    msg("m4", "alice", 1_000_480),
  ];

  expect(computeRenderTypes(items)).toEqual([
    "FULL_HEADER",
    "COMPACT_ROW",
    "COMPACT_ROW",
    "FULL_HEADER",
  ]);
});

test("keeps grouping just inside the 8-minute ceiling", () => {
  const items = [msg("m1", "alice", 1_000_000), msg("m2", "alice", 1_000_479)];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "COMPACT_ROW"]);
});

test("a reply always starts a fresh header", () => {
  const reply: ConversationItem = {
    type: "message",
    createdAt: 1_000_060,
    message: {
      message_id: "m2",
      sender_id: "alice",
      content: "reply",
      created_at: 1_000_060,
      reply_to_message_id: "m1",
    },
  };
  const items = [msg("m1", "alice", 1_000_000), reply];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "FULL_HEADER"]);
});

test("system join/leave notices break groups and never group themselves", () => {
  const join: ConversationItem = {
    type: "message",
    createdAt: 1_000_060,
    message: {
      message_id: "m2",
      sender_id: "alice",
      content: "joined",
      created_at: 1_000_060,
      kind: "join",
    },
  };
  const after: ConversationItem = msg("m3", "alice", 1_000_090);
  const items = [msg("m1", "alice", 1_000_000), join, after];

  expect(computeRenderTypes(items)).toEqual([
    "FULL_HEADER",
    "FULL_HEADER",
    "FULL_HEADER",
  ]);
});

test("a new calendar day starts a fresh header", () => {
  // 1_000_000 and 1_090_000 fall on different local days in most zones;
  // compute the boundary dynamically to stay zone-independent.
  const first = 1_000_000;
  let second = first + 60;
  while (dayKey(second) === dayKey(first)) second += 3600;

  expect(computeRenderTypes([msg("m1", "alice", first), msg("m2", "alice", second)])).toEqual([
    "FULL_HEADER",
    "FULL_HEADER",
  ]);
});

test("file attachments group with adjacent same-sender messages", () => {
  const items = [msg("m1", "alice", 1_000_000), file("f1", "alice", 1_000_030), msg("m2", "alice", 1_000_060)];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "COMPACT_ROW", "COMPACT_ROW"]);
});

test("returns an empty array for no messages", () => {
  expect(computeRenderTypes([])).toEqual([]);
});

test("group rows have no bottom gap while the group continues", () => {
  const types = ["FULL_HEADER", "COMPACT_ROW", "COMPACT_ROW", "FULL_HEADER"] as const;

  expect(groupRowMarginBottom(types, 0)).toBe(0);
  expect(groupRowMarginBottom(types, 1)).toBe(0);
  expect(groupRowMarginBottom(types, 2)).toBe(1);
  expect(groupRowMarginBottom(types, 3)).toBe(1);
});

function sysMsg(id: string, sender: string, at: number, kind: string): ConversationItem {
  return {
    type: "message",
    createdAt: at,
    message: { message_id: id, sender_id: sender, content: kind, created_at: at, kind },
  };
}

test("kind message/text does not break a group", () => {
  const items = [msg("m1", "alice", 1_000_000), sysMsg("m2", "alice", 1_000_030, "message")];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "COMPACT_ROW"]);
});

test("consecutive system notices each start a fresh header", () => {
  const items = [
    msg("m1", "alice", 1_000_000),
    sysMsg("m2", "alice", 1_000_030, "join"),
    sysMsg("m3", "alice", 1_000_060, "leave"),
  ];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "FULL_HEADER", "FULL_HEADER"]);
});

test("empty reply_to_message_id does not break a group", () => {
  const noReply: ConversationItem = {
    type: "message",
    createdAt: 1_000_030,
    message: {
      message_id: "m2", sender_id: "alice", content: "hi",
      created_at: 1_000_030, reply_to_message_id: "",
    },
  };
  const items = [msg("m1", "alice", 1_000_000), noReply];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "COMPACT_ROW"]);
});

test("a join notice outside a group does not break, matching the renderer", () => {
  const items = [msg("m1", "alice", 1_000_000), sysMsg("m2", "alice", 1_000_030, "join")];

  expect(computeRenderTypes(items, false)).toEqual(["FULL_HEADER", "COMPACT_ROW"]);
  expect(computeRenderTypes(items, true)).toEqual(["FULL_HEADER", "FULL_HEADER"]);
});

test("unsorted input groups on negative deltas (callers must pass oldest-first)", () => {
  const items = [msg("m1", "alice", 1_000_000), msg("m2", "alice", 999_900)];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "COMPACT_ROW"]);
});

test("same-timestamp message and file tie groups", () => {
  const items = [msg("m1", "alice", 1_000_000), file("f1", "alice", 1_000_000)];

  expect(computeRenderTypes(items)).toEqual(["FULL_HEADER", "COMPACT_ROW"]);
});

test("isSystemMessage matches the renderer's group-gated check", () => {
  expect(isSystemMessage({ kind: "join" }, true)).toBe(true);
  expect(isSystemMessage({ kind: "join" }, false)).toBe(false);
  expect(isSystemMessage({ kind: "message" }, true)).toBe(false);
  expect(isSystemMessage({ kind: "text" }, true)).toBe(false);
  expect(isSystemMessage({}, true)).toBe(false);
});

test("groupDeliveriesNeedAttention flags only non-nominal delivery states", () => {
  const at = 1_000_000;
  const delivery = (status: string) => ({ recipient_id: "bob", display_name: "Bob", status, updated_at: at });
  expect(groupDeliveriesNeedAttention([])).toBe(false);
  expect(groupDeliveriesNeedAttention([delivery("delivered"), delivery("sent")])).toBe(false);
  expect(groupDeliveriesNeedAttention([delivery("delivered"), delivery("queued")])).toBe(true);
  expect(groupDeliveriesNeedAttention([delivery("unavailable")])).toBe(true);
  expect(groupDeliveriesNeedAttention([delivery("pending")])).toBe(true);
});
