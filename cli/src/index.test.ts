import { describe, expect, spyOn, test } from "bun:test";
import { fileMetadataLines, main, parseFileArguments, printTransferStarted, resolveMigrateChoice, splitMigrateFlags } from "./index";
import { IPCClient, type IPCEvent, type IPCResponse } from "../../common/ipc-client";
import { terminalText } from "../../common/terminal-text";

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
  test("encodes controls in captions and delivery fields without altering records", () => {
    const caption = "你好\n\tnote\u001b]0;dummy\u0007\u009c";
    const file = { caption, batch_id: "batch\u009b", deliveries: [{ recipient_id: "peer\u0085", status: "ok\r" }] };
    const lines = fileMetadataLines(file).join("\n");
    expect(lines).toContain(terminalText(caption));
    expect(lines).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(file.caption).toBe(caption);
  });
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

test("history, watch, requests and file output encode peer controls only for display", async () => {
  const content = "你好\n\tMT\u001b]0;dummy\u0007\u009c\r";
  const filename = "dummy\u009b.txt";
  const filePath = "/scratch/dummy\u009b.txt";
  const messages = [{ created_at: 1, sender_id: "peer", content }, { created_at: 1, kind: "join", content }];
  const requests = [{ direction: "incoming", sender_name: content, request_id: "req", note: content }, { direction: "outgoing", recipient_name: content, request_id: "req2" }];
  const file = { file_id: "file1234", filename, caption: content, file_path: filePath, file_size: 1 };
  const connect = spyOn(IPCClient.prototype, "connect").mockResolvedValue(undefined);
  const close = spyOn(IPCClient.prototype, "close").mockImplementation(() => {});
  const send = spyOn(IPCClient.prototype, "send").mockImplementation(async (action) => ({ id: 1, messages, requests, files: [file], file, dest_path: filePath }) as IPCResponse);
  const onEvent = spyOn(IPCClient.prototype, "onEvent").mockImplementation((handler) => {
    for (const event of [
      { event: "message", content, sender_id: "peer" },
      { event: "group_message", content, sender_id: "peer", group_id: "group" },
      { event: "group_member_joined", display_name: content },
      { event: "group_member_left", display_name: content },
      { event: "file_offer", filename },
      { event: "file_completed", filename, file_path: filePath },
    ]) handler(event as IPCEvent);
    queueMicrotask(() => process.emit("SIGINT"));
    return () => {};
  });
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
  const error = spyOn(console, "error").mockImplementation((line) => { lines.push(String(line)); });
  const argv = process.argv;
  try {
    for (const args of [["messages", "peer"], ["group", "messages", "group"], ["friend-requests"], ["files"], ["download", "file", "/scratch/dest"], ["watch"]]) {
      lines.length = 0;
      process.argv = ["bun", "meshtalk", ...args];
      await main();
      const output = lines.join("\n");
      expect(output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(output).toContain(terminalText(content));
    }
    process.argv = ["bun", "meshtalk", "send-file", "peer", filePath, "--caption", content];
    await main();
    expect(send).toHaveBeenLastCalledWith("file_send", { recipient_id: "peer", file_path: filePath, caption: content });
    expect(file.file_path).toBe(filePath);
    expect(file.caption).toBe(content);
  } finally {
    process.argv = argv;
    for (const spy of [connect, close, send, onEvent, log, error]) spy.mockRestore();
  }
});
