#!/usr/bin/env bun
/// <reference types="bun-types" />

import { spawn, type Subprocess } from "bun";
import { createConnection, type Socket } from "net";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const DATA_DIR = `${HOME}/.meshtalk`;
const SOCKET_PATH = `${DATA_DIR}/meshtalk.sock`;
const PORT_PATH = `${DATA_DIR}/meshtalk.port`;
const BACKEND_START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;

function resolveRoot(): string {
  const base = process.env.MESHTALK_ROOT || import.meta.dir;
  if (existsSync(join(base, "backend"))) return base;
  const parent = join(base, "..");
  if (existsSync(join(parent, "backend"))) return parent;
  return base;
}

function backendRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;

    function finish(result: boolean) {
      if (done) return;
      done = true;
      resolve(result);
    }

    const connectTcp = () => {
      try {
        const port = Number(readFileSync(PORT_PATH, "utf-8").trim());
        const socket: Socket = createConnection(port, "127.0.0.1");
        socket.setTimeout(3_000);
        socket.on("connect", () => {
          socket.write(JSON.stringify({ id: 1, action: "identity" }) + "\n");
        });
        socket.on("data", () => { socket.destroy(); finish(true); });
        socket.on("error", () => finish(false));
        socket.on("timeout", () => { socket.destroy(); finish(false); });
      } catch {
        finish(false);
      }
    };

    if (process.platform === "win32") {
      connectTcp();
    } else {
      const socket: Socket = createConnection(SOCKET_PATH);
      socket.setTimeout(3_000);
      socket.on("connect", () => {
        socket.write(JSON.stringify({ id: 1, action: "identity" }) + "\n");
      });
      socket.on("data", () => { socket.destroy(); finish(true); });
      socket.on("error", () => { socket.destroy(); connectTcp(); });
      socket.on("timeout", () => { socket.destroy(); finish(false); });
    }
  });
}

async function waitForBackend(): Promise<boolean> {
  if (await backendRunning()) return true;
  const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    if (await backendRunning()) return true;
  }
  return false;
}

function startBackend(repoRoot: string): Subprocess {
  const proc = spawn(["uv", "run", "meshtalk"], {
    cwd: join(repoRoot, "backend"),
    stdout: "inherit",
    stderr: "inherit",
  });
  console.error("[meshtalk] Starting backend (pid " + proc.pid + ")…");
  return proc;
}

async function main() {
  const repoRoot = resolveRoot();
  const args = process.argv.slice(2);
  let backendProcess: Subprocess | null = null;

  const alreadyRunning = await backendRunning();

  if (!alreadyRunning) {
    backendProcess = startBackend(repoRoot);
    const ready = await waitForBackend();
    if (!ready) {
      console.error("[meshtalk] Backend did not start within timeout.");
      backendProcess.kill();
      process.exit(1);
    }
  }

  let code = 0;
  try {
    if (args.length === 0) {
      const tui = spawn(["bun", "run", "src/index.tsx"], {
        cwd: join(repoRoot, "tui"),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const tuiExit = await tui.exited;
      code = tuiExit.code ?? 0;
    } else {
      const cli = spawn(["bun", "run", "src/index.ts", ...args], {
        cwd: join(repoRoot, "cli"),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const cliExit = await cli.exited;
      code = cliExit.code ?? 0;
    }
  } finally {
    if (backendProcess) {
      backendProcess.kill();
      console.error("[meshtalk] Backend stopped.");
    }
  }

  process.exit(code);
}

main();
