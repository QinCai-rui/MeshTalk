#!/usr/bin/env bun
/// <reference types="bun-types" />

import { spawn } from "bun";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "net";
import { basename, dirname, join } from "path";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeFileSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";
import { checkForUpdate, installRelease, releaseInstallDir, saveGithubToken } from "../common/updater";

declare const APP_VERSION: string;
declare const MESHTALK_RELEASE: boolean;

const HOME = homedir();
const DATA_DIR = `${HOME}/.meshtalk`;
const SOCKET_PATH = `${DATA_DIR}/meshtalk.sock`;
const PORT_PATH = `${DATA_DIR}/meshtalk.port`;
const TOKEN_PATH = `${DATA_DIR}/meshtalk.token`;
const BACKEND_LOG_PATH = `${DATA_DIR}/backend.log`;
const BACKEND_START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;

const isWindows = process.platform === "win32";
const EXECUTABLE_SUFFIX = isWindows ? ".exe" : "";
const PROGRAM = basename(process.argv[1] ?? process.argv[0]);
const IS_RELEASE_BUILD = typeof MESHTALK_RELEASE !== "undefined" && MESHTALK_RELEASE;
const APP_RELEASE_VERSION = typeof APP_VERSION !== "undefined" ? APP_VERSION : "dev";

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

async function readConfirmation(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write("Install now? [y/N] ");
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (data) => resolve(data.toString().trim()));
  });
  return /^(y|yes)$/i.test(answer);
}

async function runUpdate(args: string[]): Promise<void> {
  if (args[0] === "token") {
    if (args[1] === "clear" && args.length === 2) {
      saveGithubToken(null);
      console.log("Saved GitHub token removed from ~/.meshtalk/settings.json.");
      return;
    }
    if (args.length !== 2 || !args[1]) throw new Error(`Usage: ${PROGRAM} update token <token>|clear`);
    console.error("Warning: this GitHub token is stored unencrypted in ~/.meshtalk/settings.json.");
    saveGithubToken(args[1]);
    console.log("GitHub token saved.");
    return;
  }
  if (!IS_RELEASE_BUILD) {
    console.log("Update checks are available only in compiled MeshTalk releases.");
    return;
  }
  if (args.length > 1 || (args[0] && args[0] !== "--install")) throw new Error(`Usage: ${PROGRAM} update [--install]`);
  const release = await checkForUpdate(APP_RELEASE_VERSION);
  if (!release) {
    console.log(`MeshTalk ${APP_RELEASE_VERSION} is up to date, or release metadata is unavailable.`);
    return;
  }
  console.log(`MeshTalk ${release.version} is available (installed: ${APP_RELEASE_VERSION}).`);
  if (args[0] !== "--install" && !await readConfirmation()) {
    console.log("Update skipped.");
    return;
  }
  const installDir = releaseInstallDir();
  if (!installDir) throw new Error("Unable to locate the standalone MeshTalk installation.");
  console.log(`Downloading and installing MeshTalk ${release.version}...`);
  await installRelease(release, installDir);
  console.log("Update installed. Restart MeshTalk to use the new version.");
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

    let token = "";
    try { token = readFileSync(TOKEN_PATH, "utf-8").trim(); } catch {}

    const onConnect = (socket: Socket) => {
      socket.write(JSON.stringify({ action: "authenticate", token }) + "\n");
      let authenticated = false;
      socket.removeAllListeners("data");
      socket.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (!authenticated) {
              if (msg.authenticated) {
                authenticated = true;
                socket.write(JSON.stringify({ id: 1, action }) + "\n");
              } else {
                finish(null);
              }
              return;
            }
            finish(msg);
          } catch {
            finish(null);
          }
        }
      });
    };

    const connectTcp = () => {
      try {
        const port = Number(readFileSync(PORT_PATH, "utf-8").trim());
        if (!Number.isInteger(port) || port < 1) return finish(null);
        const socket = createConnection(port, "127.0.0.1");
        activeSocket = socket;
        socket.setTimeout(3_000);
        socket.on("connect", () => onConnect(socket));
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
      socket.on("connect", () => onConnect(socket));
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

async function stopBackend(pid?: number, daemonise = true): Promise<void> {
  if (!pid && daemonise) {
    try { pid = Number(readFileSync(`${DATA_DIR}/meshtalk.pid`, "utf-8").trim()); } catch {}
  }
  if (!pid || !Number.isInteger(pid)) return;
  const useGroup = daemonise && process.platform !== "win32";
  const killGroup = (signal: NodeJS.Signal) => {
    try {
      process.kill(useGroup ? -pid! : pid!, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!killGroup("SIGTERM")) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    try { process.kill(pid!, 0); } catch { return; }
  }
  log("Backend did not stop gracefully; sending SIGKILL.");
  killGroup("SIGKILL");
}

function startBackend(backend: Component, daemonise = true): ChildProcess {
  const logFile = openSync(BACKEND_LOG_PATH, "a");
  try {
    const proc = spawnProcess(backend.command[0], backend.command.slice(1), {
      cwd: backend.cwd,
      detached: daemonise,
      stdio: ["ignore", logFile, logFile],
      windowsHide: true,
    });
    if (daemonise) {
      proc.unref();
      if (proc.pid) {
        writeFileSync(`${DATA_DIR}/meshtalk.pid`, String(proc.pid));
      }
    }
    log(`Starting backend${daemonise ? " daemon" : ""} (pid ${proc.pid}); logs: ${BACKEND_LOG_PATH}`);
    return proc;
  } finally {
    closeSync(logFile);
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const args = process.argv.slice(2);

  if (args[0] === "update") {
    await runUpdate(args.slice(1));
    return;
  }

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
      let pid: number | null = null;
      try { pid = Number(readFileSync(`${DATA_DIR}/meshtalk.pid`, "utf-8").trim()); } catch {}
      if (!pid || !Number.isInteger(pid)) {
        console.log("No backend PID file found.");
        return;
      }
      const useGroup = process.platform !== "win32";
      const killGroup = (signal: NodeJS.Signal) => {
        try {
          process.kill(useGroup ? -pid! : pid!, signal);
          return true;
        } catch {
          return false;
        }
      };
      if (!killGroup("SIGTERM")) { console.log("Backend is not running."); return; }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await Bun.sleep(200);
        try { process.kill(pid, 0); } catch { console.log("Backend stopped."); return; }
      }
      log("Backend did not stop gracefully; sending SIGKILL.");
      killGroup("SIGKILL");
      await Bun.sleep(1_000);
      try { process.kill(pid, 0); console.log("Backend still running."); } catch { console.log("Backend stopped."); }
      return;
    }
    if (command === "start" && args.length === 3 && args[2] === "--daemonise") {
      if (await backendRunning()) {
        console.log("Backend is already running.");
        return;
      }
      const backendProcess = startBackend(resolveComponents().backend);
      log("Waiting for backend to be ready...");
      if (!await waitForBackend(backendProcess)) {
        log("Backend did not start within timeout.");
        backendProcess.kill();
        log(`See ${BACKEND_LOG_PATH} for details.`);
        process.exitCode = 1;
      }
      return;
    }
    throw new Error(`Usage: ${PROGRAM} backend [status|stop|start --daemonise]`);
  }

  const components = resolveComponents();
  let backendPid: number | undefined;

  const alreadyRunning = await backendRunning();
  const launchTui = args.length === 0;
  let iStartedIt = false;

  if (alreadyRunning) {
    log("Connecting to existing backend...");
  } else {
    const backendProcess = startBackend(components.backend, !launchTui);
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
      return (cleanupPromise ??= stopBackend(backendPid, false));
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
