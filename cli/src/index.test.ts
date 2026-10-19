import { describe, expect, spyOn, test } from "bun:test";
import { fileMetadataLines, parseFileArguments, printTransferStarted, resolveMigrateChoice, splitMigrateFlags } from "./index";

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
    process.exitCode = exitCode ?? 0;
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

describe("storage location arguments", () => {
  test("rejects conflicting migrate flags", () => {
    expect(() => splitMigrateFlags(["target", "--migrate", "--no-migrate"])).toThrow("not both");
  });

  test("separates the path from migrate flags", () => {
    expect(splitMigrateFlags(["my path", "--migrate"])).toEqual({
      paths: ["my path"],
      migrate: true,
      noMigrate: false,
    });
    expect(splitMigrateFlags(["my path", "--no-migrate"])).toEqual({
      paths: ["my path"],
      migrate: false,
      noMigrate: true,
    });
  });
});

describe("migrate choice", () => {
  function withTTY<T>(value: boolean | undefined, run: () => Promise<T>): Promise<T> {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
    return run().finally(() => {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
    });
  }

  test("refuses to guess on non-interactive input", async () => {
    await withTTY(undefined, async () => {
      await expect(resolveMigrateChoice("files", true, async () => true)).rejects.toThrow("non-interactive");
    });
  });

  test("skips the prompt when there is nothing to transfer", async () => {
    await withTTY(true, async () => {
      let asked = 0;
      const migrate = await resolveMigrateChoice("files", false, async () => { asked += 1; return true; });
      expect(migrate).toBe(false);
      expect(asked).toBe(0);
    });
  });

  test("prompts for existing content and honours the answer", async () => {
    await withTTY(true, async () => {
      const asked: string[] = [];
      const yes = await resolveMigrateChoice("data", true, async (label) => { asked.push(label); return true; });
      const no = await resolveMigrateChoice("data", true, async () => false);
      expect(yes).toBe(true);
      expect(no).toBe(false);
      expect(asked).toEqual(["data"]);
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
