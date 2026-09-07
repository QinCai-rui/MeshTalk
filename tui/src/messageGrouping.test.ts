import { expect, test } from "bun:test";
import type { ConversationItem } from "./types";
import { MESSAGE_GROUP_WINDOW_SECONDS, groupStartIndexes } from "./utils";

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

function starts(items: ConversationItem[]): number[] {
  return groupStartIndexes(items);
}

const T0 = 1_700_000_000;
const MIN = 60;

test("groups a quick burst from the same sender", () => {
  expect(starts([msg("a", "alice", T0), msg("b", "alice", T0 + MIN)])).toEqual([0, 0]);
});

test("window constant is Discord's 8 minutes", () => {
  expect(MESSAGE_GROUP_WINDOW_SECONDS).toBe(8 * 60);
});

test("different sender starts a fresh group", () => {
  expect(
    starts([msg("a", "alice", T0), msg("b", "bob", T0 + 10)]),
  ).toEqual([0, 1]);
});

test("group ends 8 minutes after its FIRST message, not the previous one", () => {
  // Rapid typing never extends the window: everything past 8 minutes
  // from the first message starts a new block even with tiny gaps.
  const items = [
    msg("a", "alice", T0),
    msg("b", "alice", T0 + 4 * MIN),
    msg("c", "alice", T0 + 7 * MIN),
    msg("d", "alice", T0 + 8 * MIN),
    msg("e", "alice", T0 + 9 * MIN),
  ];
  expect(starts(items)).toEqual([0, 0, 0, 3, 3]);
});

test("indefinite chaining is broken: steady typing still splits every 8 minutes", () => {
  const items = Array.from(
    { length: 11 },
    (_, i) => msg(`m${i}`, "alice", T0 + i * 2 * MIN),
  );
  // m0..m3 group (0-6 min), m4 (8 min) restarts, m5..m7 group, m8 restarts, m9..m10 group.
  expect(starts(items)).toEqual([0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8]);
});

test("day change starts a fresh group", () => {
  // A week later is a different calendar day in every timezone.
  const nextWeek = T0 + 7 * 24 * 3600;
  expect(starts([msg("a", "alice", T0), msg("b", "alice", nextWeek)])).toEqual([0, 1]);
});

test("reply always starts a fresh header, next message groups under it", () => {
  expect(
    starts([
      msg("a", "alice", T0),
      msg("b", "alice", T0 + 10, { reply_to_message_id: "a" }),
      msg("c", "alice", T0 + 20),
    ]),
  ).toEqual([0, 1, 1]);
});

test("system messages never group on either side", () => {
  expect(
    starts([
      msg("a", "alice", T0),
      msg("j", "alice", T0 + 10, { kind: "join" }),
      msg("b", "alice", T0 + 20),
    ]),
  ).toEqual([0, 1, 2]);
});

test("files group with adjacent same-sender messages", () => {
  expect(
    starts([msg("a", "alice", T0), file("f", "alice", T0 + 10)]),
  ).toEqual([0, 0]);
  expect(
    starts([file("f", "alice", T0), msg("b", "alice", T0 + 10)]),
  ).toEqual([0, 0]);
  expect(
    starts([msg("a", "alice", T0), file("f", "bob", T0 + 10)]),
  ).toEqual([0, 1]);
});
