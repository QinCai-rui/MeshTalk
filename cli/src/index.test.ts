import { describe, expect, spyOn, test } from "bun:test";
import { fileMetadataLines, parseFileArguments, printTransferStarted } from "./index";

test("failed batches report errors without success; partial batches retain successes", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    const response = { id: 1, batch_id: "batch", results: [], errors: [{ path: "one.txt", error: "Recipient does not support file_transfer_v2" }] };
    printTransferStarted(response);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain("does not support file_transfer_v2");
    expect(process.exitCode).toBe(1);
    printTransferStarted({ ...response, results: [{ file_id: "file", recipient_id: "peer" }] });
    expect(log).toHaveBeenCalledWith("File transfer batch batch started");
    expect(log).toHaveBeenCalledWith("  file -> peer");
    printTransferStarted({ id: 2, batch_id: "batch", results: [], errors: [{ path: "one.txt", error: "Failed to deliver", file_id: "abc123" }] });
    expect(error.mock.calls.flat().join(" ")).toContain("abc123");
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = exitCode;
  }
});

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

  test("treats options after -- as paths", () => {
    expect(parseFileArguments(["--caption", "Notes", "--", "--caption"])).toEqual({
      paths: ["--caption"],
      caption: "Notes",
    });
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
