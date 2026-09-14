import { describe, expect, test } from "bun:test";
import { fileMetadataLines, parseFileArguments } from "./index";

describe("file command arguments", () => {
  test("parses multiple paths and a caption", () => {
    expect(parseFileArguments(["one.txt", "two.txt", "--caption", "Trip photos"])).toEqual({
      paths: ["one.txt", "two.txt"],
      caption: "Trip photos",
    });
  });

  test("rejects a missing or duplicate caption value", () => {
    expect(() => parseFileArguments(["one.txt", "--caption"])).toThrow("--caption requires");
    expect(() => parseFileArguments(["one.txt", "--caption", "--caption"])).toThrow("--caption requires");
    expect(() => parseFileArguments(["--caption", "one", "--caption", "two"])).toThrow("--caption requires");
  });
});

describe("file metadata output", () => {
  test("includes caption, batch position, and deliveries", () => {
    expect(fileMetadataLines({
      caption: "Receipts",
      batch_id: "batch-1",
      batch_index: 1,
      batch_count: 3,
      deliveries: [
        { recipient_id: "peer-a", status: "completed" },
        { recipient_id: "peer-b", status: "queued" },
      ],
    })).toEqual([
      "  Caption: Receipts",
      "  Batch: batch-1 (2/3)",
      "  Deliveries:",
      "    peer-a: completed",
      "    peer-b: queued",
    ]);
  });
});
