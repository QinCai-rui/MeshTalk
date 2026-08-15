#!/usr/bin/env bun
/// <reference types="bun-types" />

import { spawn } from "bun";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "net";
import { join } from "path";
import { closeSync, existsSync, openSync, readFileSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";

const HOME = homedir();
const DATA_DIR = `${HOME}/.meshtalk`;
const SOCKET_PATH = `${DATA_DIR}/meshtalk.sock`;
const PORT_PATH = `${DATA_DIR}/meshtalk.port`;
const TOOLS_DIR = `${DATA_DIR}/tools`;
const BACKEND_LOG_PATH = `${DATA_DIR}/backend.log`;
const BACKEND_START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function log(msg: string) {
  console.error(`[meshtalk] ${msg}`);
}

function findExecutable(name: string): string | null {
  const exe = isWindows ? `${name}.exe` : name;
  const envPath = process.env.PATH || "";
  const dirs = envPath.split(isWindows ? ";" : ":").filter(Boolean);
  const candidates = [
    ...dirs.map((d) => join(d, exe)),
    join(TOOLS_DIR, exe),
    join(HOME, ".local", "bin", exe),
    join(HOME, ".bun", "bin", exe),
    join(HOME, ".cargo", "bin", exe),
    `/usr/local/bin/${exe}`,
    `/usr/bin/${exe}`,
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

async function installTool(name: string, installCmd: string[], env?: Record<string, string>): Promise<string> {
  mkdirSync(TOOLS_DIR, { recursive: true });
  log(`Installing ${name}...`);
  const proc = spawn(installCmd, {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
  const exit = await proc.exited;
  if (exit.code !== 0) {
    log(`Failed to install ${name}. Please install it manually.`);
    process.exit(1);
  }
  const found = findExecutable(name);
  if (!found) {
    log(`${name} installed but not found in PATH. Please add ${TOOLS_DIR} to your PATH.`);
    process.exit(1);
  }
  log(`${name} installed to ${found}`);
  return found;
}

async function ensureUv(): Promise<string> {
  const existing = findExecutable("uv");
  if (existing) return existing;

  if (isWindows) {
    return installTool("uv", [
      "powershell", "-ExecutionPolicy", "ByPass", "-c",
      "irm https://astral.sh/uv/install.ps1 | iex",
    ], { UV_INSTALL_DIR: TOOLS_DIR });
  }

  return installTool("uv", [
    "sh", "-c", `curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="${TOOLS_DIR}" sh`,
  ]);
}

async function ensureBun(): Promise<string> {
  const existing = findExecutable("bun");
  if (existing) return existing;

  if (isWindows) {
    return installTool("bun", [
      "powershell", "-ExecutionPolicy", "ByPass", "-c",
      "irm bun.sh/install.ps1 | iex",
    ]);
  }

  return installTool("bun", [
    "sh", "-c", `curl -fsSL https://bun.sh/install | BUN_INSTALL="${join(HOME, ".bun")}" bash`,
  ]);
}

function resolveRoot(): string {
  const candidates = [
    process.env.MESHTALK_ROOT,
    import.meta.dir,
    join(import.meta.dir, ".."),
    // Bun places global package executables in ~/.bun/bin and links the package here.
    join(import.meta.dir, "..", "install", "global", "node_modules", "meshtalk"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "backend"))) return candidate;
  }

  return candidates[0];
}

function backendRequest(action: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let done = false;
    let activeSocket: Socket | null = null;

    function finish(result: Record<string, unknown> | null) {
      if (done) return;
      done = true;
      activeSocket?.destroy();
      resolve(result);
    }

    const connectTcp = () => {
      try {
        const port = Number(readFileSync(PORT_PATH, "utf-8").trim());
        if (!Number.isInteger(port) || port < 1) return finish(null);
        const socket = createConnection(port, "127.0.0.1");
        activeSocket = socket;
        socket.setTimeout(3_000);
        socket.on("connect", () => {
          socket.write(JSON.stringify({ id: 1, action }) + "\n");
        });
        socket.on("data", (data) => {
          try {
            finish(JSON.parse(data.toString().split("\n", 1)[0]));
          } catch {
            finish(null);
          }
        });
        socket.on("error", () => finish(null));
        socket.on("timeout", () => finish(null));
      } catch {
        finish(null);
      }
    };

    if (isWindows) {
      connectTcp();
    } else {
      const socket = createConnection(SOCKET_PATH);
      activeSocket = socket;
      socket.setTimeout(3_000);
      socket.on("connect", () => {
        socket.write(JSON.stringify({ id: 1, action }) + "\n");
      });
      socket.on("data", (data) => {
        try {
          finish(JSON.parse(data.toString().split("\n", 1)[0]));
        } catch {
          finish(null);
        }
      });
      socket.on("error", () => { socket.destroy(); connectTcp(); });
      socket.on("timeout", () => finish(null));
    }
  });
}

async function backendRunning(): Promise<boolean> {
  return Boolean(await backendRequest("identity"));
}

async function waitForBackend(backendProcess?: ChildProcess): Promise<boolean> {
  if (await backendRunning()) return true;
  const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    if (backendProcess?.exitCode !== null && backendProcess?.exitCode !== undefined) return false;
    if (await backendRunning()) return true;
  }
  return false;
}

async function stopBackend(): Promise<void> {
  if (!await backendRunning()) return;
  await backendRequest("shutdown");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && await backendRunning()) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  if (await backendRunning()) {
    log("Backend did not stop after the TUI closed; use `meshtalk backend stop`.");
  }
}

async function ensureBackendDeps(uv: string, backendDir: string) {
  const lockfile = join(backendDir, "uv.lock");
  const venv = join(backendDir, ".venv");
  if (!existsSync(venv)) {
    log("Setting up Python virtual environment...");
    const proc = spawn([uv, "sync"], {
      cwd: backendDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}

function startBackend(repoRoot: string, uv: string): ChildProcess {
  const backendDir = join(repoRoot, "backend");
  const logFile = openSync(BACKEND_LOG_PATH, "a");
  try {
    const proc = spawnProcess(uv, ["run", "meshtalk"], {
      cwd: backendDir,
      detached: true,
      stdio: ["ignore", logFile, logFile],
      windowsHide: true,
    });
    proc.unref();
    log(`Starting backend daemon (pid ${proc.pid}); logs: ${BACKEND_LOG_PATH}`);
    return proc;
  } finally {
    closeSync(logFile);
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const repoRoot = resolveRoot();
  const args = process.argv.slice(2);

  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) {
    const bun = await ensureBun();
    const cli = spawn([bun, "run", "src/index.ts", "help"], {
      cwd: join(repoRoot, "cli"),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await cli.exited.then((result) => result.code ?? 0));
  }

  const uv = await ensureUv();
  const bun = await ensureBun();

  await ensureBackendDeps(uv, join(repoRoot, "backend"));

  if (args[0] === "backend") {
    const command = args[1] || "status";
    if (command === "status") {
      console.log(`Backend: ${await backendRunning() ? "running" : "stopped"}`);
      console.log(`Logs: ${BACKEND_LOG_PATH}`);
      return;
    }
    if (command === "stop") {
      if (!await backendRunning()) {
        console.log("Backend is not running.");
        return;
      }
      await backendRequest("shutdown");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && await backendRunning()) {
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      if (await backendRunning()) throw new Error("Backend did not stop.");
      console.log("Backend stopped.");
      return;
    }
    throw new Error("Usage: meshtalk backend [status|stop]");
  }

  const alreadyRunning = await backendRunning();

  if (!alreadyRunning) {
    const backendProcess = startBackend(repoRoot, uv);
    const ready = await waitForBackend(backendProcess);
    if (!ready) {
      log("Backend did not start within timeout.");
      backendProcess.kill();
      log(`See ${BACKEND_LOG_PATH} for details.`);
      process.exit(1);
    }
  }

  let code = 0;
  if (args.length === 0) {
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= stopBackend();
    const handleSignal = () => {
      void cleanup().finally(() => process.exit(130));
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    const tui = spawn([bun, "run", "src/index.tsx"], {
      cwd: join(repoRoot, "tui"),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const tuiExit = await tui.exited;
    code = tuiExit.code ?? 0;
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await cleanup();
  } else {
    const cli = spawn([bun, "run", "src/index.ts", ...args], {
      cwd: join(repoRoot, "cli"),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const cliExit = await cli.exited;
    code = cliExit.code ?? 0;
  }

  process.exit(code);
}

main();
