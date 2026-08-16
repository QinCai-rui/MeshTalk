#!/usr/bin/env bun
/// <reference types="bun-types" />

import { spawn } from "bun";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "net";
import { basename, dirname, join } from "path";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeFileSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";

const HOME = homedir();
const DATA_DIR = `${HOME}/.meshtalk`;
const SOCKET_PATH = `${DATA_DIR}/meshtalk.sock`;
const PORT_PATH = `${DATA_DIR}/meshtalk.port`;
const BACKEND_LOG_PATH = `${DATA_DIR}/backend.log`;
const BACKEND_START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;

const isWindows = process.platform === "win32";
const EXECUTABLE_SUFFIX = isWindows ? ".exe" : "";
const PROGRAM = basename(process.argv[1] ?? process.argv[0]);

type Component = {
  command: string[];
  cwd?: string;
};

type Components = {
  backend: Component;
  cli: Component;
  tui: Component;
};

function log(msg: string) {
  console.error(`[meshtalk] ${msg}`);
}

function findExecutable(name: string): string | null {
  const exe = isWindows ? `${name}.exe` : name;
  const envPath = process.env.PATH || "";
  const dirs = envPath.split(isWindows ? ";" : ":").filter(Boolean);
  const candidates = [
    ...dirs.map((d) => join(d, exe)),
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

function bundledComponent(name: string): Component | null {
  const path = join(dirname(process.execPath), `${name}${EXECUTABLE_SUFFIX}`);
  if (!existsSync(path)) return null;
  if (!isWindows) chmodSync(path, 0o755);
  return { command: [path] };
}

function resolveComponents(): Components {
  const backend = bundledComponent("meshtalk-backend");
  const cli = bundledComponent("meshtalk-cli");
  const tui = bundledComponent("meshtalk-tui");
  if (backend && cli && tui) return { backend, cli, tui };

  const uv = findExecutable("uv");
  if (!uv) {
    throw new Error("Release components are missing. Source development requires uv in PATH.");
  }

  const repoRoot = resolveRoot();
  return {
    backend: { command: [uv, "run", "meshtalk"], cwd: join(repoRoot, "backend") },
    cli: { command: [process.execPath, "run", "src/index.ts"], cwd: join(repoRoot, "cli") },
    tui: { command: [process.execPath, "run", "src/index.tsx"], cwd: join(repoRoot, "tui") },
  };
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

async function stopBackend(pid?: number): Promise<void> {
  if (!await backendRunning()) return;
  await backendRequest("shutdown");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && await backendRunning()) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  if (await backendRunning()) {
    if (pid) {
      log("Backend did not stop gracefully; sending SIGKILL.");
      try { process.kill(pid, "SIGKILL"); } catch {}
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline && await backendRunning()) {
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }
    if (await backendRunning()) {
      log(`Backend still running; use \`${PROGRAM} backend stop\` manually.`);
    }
  }
}

function startBackend(backend: Component): ChildProcess {
  const logFile = openSync(BACKEND_LOG_PATH, "a");
  try {
    const proc = spawnProcess(backend.command[0], backend.command.slice(1), {
      cwd: backend.cwd,
      detached: true,
      stdio: ["ignore", logFile, logFile],
      windowsHide: true,
    });
    proc.unref();
    if (proc.pid) {
      writeFileSync(`${DATA_DIR}/meshtalk.pid`, String(proc.pid));
    }
    log(`Starting backend daemon (pid ${proc.pid}); logs: ${BACKEND_LOG_PATH}`);
    return proc;
  } finally {
    closeSync(logFile);
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const args = process.argv.slice(2);

  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) {
    const cliComponent = resolveComponents().cli;
    const cli = spawn([...cliComponent.command, "help"], {
      cwd: cliComponent.cwd,
      env: { ...process.env, MESHTALK_PROGRAM: PROGRAM },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await cli.exited.then((result) => result.code ?? 0));
  }

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
      if (await backendRunning()) {
        log("Backend did not stop gracefully; sending SIGKILL.");
        const identity = await backendRequest("identity") as Record<string, unknown> | null;
        // If we can't get the PID, try reading from the socket
        try {
          const pid = Number(readFileSync(`${DATA_DIR}/meshtalk.pid`, "utf-8").trim());
          process.kill(pid, "SIGKILL");
        } catch {}
        const killDeadline = Date.now() + 5_000;
        while (Date.now() < killDeadline && await backendRunning()) {
          await Bun.sleep(POLL_INTERVAL_MS);
        }
      }
      if (await backendRunning()) {
        log("Backend did not stop after SIGKILL.");
      }
      console.log("Backend stopped.");
      return;
    }
    throw new Error(`Usage: ${PROGRAM} backend [status|stop]`);
  }

  const components = resolveComponents();
  let backendPid: number | undefined;

  const alreadyRunning = await backendRunning();
  let iStartedIt = false;

  if (alreadyRunning) {
    log("Connecting to existing backend daemon...");
  } else {
    const backendProcess = startBackend(components.backend);
    backendPid = backendProcess.pid ?? undefined;
    iStartedIt = true;
    log("Waiting for backend to be ready...");
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
    const cleanup = () => {
      if (!iStartedIt) return Promise.resolve();
      return (cleanupPromise ??= stopBackend(backendPid));
    };
    const handleSignal = () => {
      void cleanup().finally(() => process.exit(130));
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    const tui = spawn(components.tui.command, {
      cwd: components.tui.cwd,
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
    const cli = spawn([...components.cli.command, ...args], {
      cwd: components.cli.cwd,
      env: { ...process.env, MESHTALK_PROGRAM: PROGRAM },
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
