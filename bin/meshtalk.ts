#!/usr/bin/env bun
/// <reference types="bun-types" />

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "net";
import { basename, dirname, join, resolve } from "path";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";
import { checkForUpdate, githubRepository, importLegacyWindowsUpdate, installRelease, isReleaseInstallDir, logUpdateHelper, releaseInstallDir, saveGithubRepository, saveGithubToken, takeUpdateRestartPath, UPDATE_RESTART_EXIT_CODE } from "../common/updater";
import { cleanupReleases, INSTALL_PROTOCOL, installationRoot, installFromDirectory, managedInstallRoot, pendingFlatInstallation, prepareInstalledLauncher, prepareUpdateRestart, releaseFlatHelper, releaseUsage, retainChildRelease, retainInstallerRelease, scheduleFlatEntryUpdate, stageReleaseDirectory, uninstallReleaseInstallation, type InstalledLauncher } from "../common/release-install";
import { closeInstallationProcesses, installationProcessPids, waitForInstallationToStop } from "../common/install-processes";
import { physicalPath as realpathSync } from "../common/install-paths";
import { main as cliMain } from "../cli/src/index";
import { runTui } from "./tui-entry";
import type { SplashStyle } from "../tui/src/SplashScreen";
import { hasExplicitAnalyticsChoice, isTier0Allowed, markPrompted, PRIVACY_URL, promptedVersions, readConsent, sendTier0, shouldPrompt, writeConsent } from "../common/analytics";

declare const APP_VERSION: string;
declare const MESHTALK_RELEASE: boolean;

const HOME = homedir();
function expandHomePath(value: string): string {
  const trimmed = value.trim();
  return HOME && (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
    ? HOME + trimmed.slice(1)
    : trimmed;
}

const DATA_DIR = process.env.MESHTALK_DATA_DIR ? expandHomePath(process.env.MESHTALK_DATA_DIR) : `${HOME}/.meshtalk`;
const SOCKET_PATH = process.env.MESHTALK_IPC_SOCKET || `${DATA_DIR}/meshtalk.sock`;
const PORT_PATH = `${DATA_DIR}/meshtalk.port`;
const TOKEN_PATH = process.env.MESHTALK_IPC_TOKEN || `${DATA_DIR}/meshtalk.token`;
const BACKEND_LOG_PATH = `${DATA_DIR}/backend.log`;
const BACKEND_START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;

const isWindows = process.platform === "win32";
const EXECUTABLE_SUFFIX = isWindows ? ".exe" : "";
const PROGRAM = basename(process.argv[1] ?? process.argv[0]);
const IS_RELEASE_BUILD = typeof MESHTALK_RELEASE !== "undefined" && MESHTALK_RELEASE;
const APP_RELEASE_VERSION = typeof APP_VERSION !== "undefined" ? APP_VERSION : "dev";
let installedLauncher: InstalledLauncher | null = null;

type Component = {
  command: string[];
  cwd?: string;
};

type Components = {
  backend: Component;
};

type SplashOption = SplashStyle | false;

function log(msg: string) {
  console.error(`[meshtalk] ${msg}`);
}

function savedSplashStyle(): SplashOption {
  try {
    const settings = JSON.parse(readFileSync(`${DATA_DIR}/settings.json`, "utf-8"));
    if (settings.splash_style === "card" || settings.splash_style === "boot-log")
      return settings.splash_style;
    if (settings.splash_style === "off") return false;
  } catch {}
  return "card";
}

function splashOption(args: string[]): SplashOption | undefined {
  const value = args.length === 1 && args[0].startsWith("--splash=")
    ? args[0].slice("--splash=".length)
    : args.length === 2 && args[0] === "--splash"
      ? args[1]
      : undefined;
  if (value === undefined) return undefined;
  if (value === "false" || value === "off") return false;
  if (value === "card" || value === "boot-log") return value;
  throw new Error(`Usage: ${PROGRAM} [--splash=false|card|boot-log]`);
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
  if (args[0] === "repo") {
    if (args[1] === "clear" && args.length === 2) {
      saveGithubRepository(null, null);
      console.log(`GitHub repository reset to ${githubRepository()}.`);
      return;
    }
    if (args.length === 1) {
      console.log(`GitHub repository: ${githubRepository()}`);
      return;
    }
    if (args.length !== 3) throw new Error(`Usage: ${PROGRAM} update repo <user> <repository>|clear`);
    saveGithubRepository(args[1], args[2]);
    console.log(`GitHub repository saved: ${githubRepository()}.`);
    return;
  }
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
  let install = false;
  let installDir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--install" && !install) install = true;
    else if (args[index] === "--dir" && !installDir && args[index + 1]) installDir = resolve(args[++index]);
    else throw new Error(`Usage: ${PROGRAM} update [--install] [--dir <directory>]`);
  }
  const release = await checkForUpdate(APP_RELEASE_VERSION);
  if (!release) {
    console.log(`MeshTalk ${APP_RELEASE_VERSION} is up to date, or release metadata is unavailable.`);
    return;
  }
  console.log(`MeshTalk ${release.version} is available (installed: ${APP_RELEASE_VERSION}).`);
  if (!install && !await readConfirmation()) {
    console.log("Update skipped.");
    return;
  }
  const destination = installDir ?? releaseInstallDir();
  if (!destination) throw new Error(`Unable to locate the standalone MeshTalk installation. Use --dir <directory> to select one. Try reinstalling MeshTalk using the quick install script: https://github.com/QinCai-rui/MeshTalk#quick-install`);
  if (!isReleaseInstallDir(destination)) throw new Error(`Update directory must contain the current MeshTalk release binaries. Try reinstalling MeshTalk using the quick install script: https://github.com/QinCai-rui/MeshTalk#quick-install`);
  console.log(`Downloading and installing MeshTalk ${release.version}...`);
  await installRelease(release, destination);
  console.log("Update installed and verified. Restart MeshTalk to use the new version.");
}

async function launchReplacement(path: string, args: string[] = process.argv.slice(2), wait = false): Promise<number> {
  if (!isWindows) {
    // Replace this process in-place so the updated TUI keeps the exact same
    // PID, terminal session, process group, and stdio handles. Spawning and
    // exiting the bootstrap can make terminal supervisors reclaim the PTY
    // before the replacement enables raw mode.
    if (!process.execve) throw new Error("This runtime cannot preserve the terminal during restart. Start MeshTalk again manually.");
    process.execve(path, [path, ...args], process.env);
  }

  return await new Promise<number>((resolveSpawn, reject) => {
    const env = { ...process.env };
    delete env.MESHTALK_BOOTSTRAP_PID;
    if (wait) env.MESHTALK_BOOTSTRAP_PID = String(process.pid);
    const child = spawnProcess(path, args, {
      detached: !wait,
      stdio: "inherit",
      windowsHide: true,
      env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      if (child.pid && installedLauncher) retainChildRelease(installedLauncher, child.pid, "launcher");
      child.removeListener("error", reject);
      if (!wait) {
        child.unref();
        resolveSpawn(0);
      }
    });
    if (wait) child.once("exit", (code) => resolveSpawn(code ?? 1));
  });
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
  if (IS_RELEASE_BUILD) {
    const path = join(dirname(realpathSync(process.execPath)), `${name}${EXECUTABLE_SUFFIX}`);
    return existsSync(path) && statSync(path).isFile() ? { command: [path] } : null;
  }
  for (const executable of [process.argv[0], process.argv[1], process.execPath]) {
    if (!executable) continue;
    const path = join(dirname(executable), `${name}${EXECUTABLE_SUFFIX}`);
    if (!existsSync(path)) continue;
    if (!isWindows) chmodSync(path, 0o755);
    return { command: [path] };
  }
  return null;
}

function resolveComponents(): Components {
  const backend = bundledComponent("meshtalk-backend");
  if (backend) return { backend };
  if (IS_RELEASE_BUILD) throw new Error("The bundled MeshTalk backend is missing. Run the MeshTalk installer to repair this installation.");

  const uv = findExecutable("uv");
  if (!uv) {
    throw new Error("Release components are missing. Source development requires uv in PATH.");
  }

  const repoRoot = resolveRoot();
  return {
    backend: { command: [uv, "run", "meshtalk"], cwd: join(repoRoot, "backend") },
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

async function requestBackendShutdown(): Promise<boolean> {
  if (!await backendRequest("shutdown")) return false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await backendRunning()) return true;
    await Bun.sleep(200);
  }
  return false;
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

function readPidFile(): number | undefined {
  try {
    const pid = Number(readFileSync(`${DATA_DIR}/meshtalk.pid`, "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

function backendPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Other windows share the backend. Refuse restart before stopping it, even
// though installing a separate release no longer overwrites locked binaries.
function otherLauncherPids(): number[] {
  const bootstrapPid = isWindows && process.env.MESHTALK_BOOTSTRAP_PID === String(process.ppid) ? process.ppid : undefined;
  if (!isWindows) {
    const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,comm="], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) throw new Error("Unable to check other MeshTalk windows. Close MeshTalk completely before restarting to update.");
    let sawSelf = false;
    const pids = new TextDecoder().decode(result.stdout).trim().split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) throw new Error("Unable to parse the running process list. Close MeshTalk completely before restarting to update.");
      if (Number(match[1]) === process.pid) sawSelf = true;
      return basename(match[2]) === "meshtalk" && Number(match[1]) !== process.pid ? [Number(match[1])] : [];
    });
    if (!sawSelf) throw new Error("The running process list is incomplete. Close MeshTalk completely before restarting to update.");
    return pids;
  }
  try {
    const result = Bun.spawnSync(["tasklist", "/fo", "csv", "/nh", "/fi", "IMAGENAME eq meshtalk.exe"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) {
      const detail = `tasklist exited with code ${result.exitCode}; deferring activation`;
      log(detail);
      try { logUpdateHelper(`otherLauncherPids: ${detail}`); } catch {}
      throw new Error("Unable to check other MeshTalk windows. Close MeshTalk completely before restarting to update.");
    }
    const output = new TextDecoder().decode(result.stdout);
    const pids: number[] = [];
    let sawSelf = false;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const match = line.match(/"meshtalk\.exe","\s*(\d+)\s*"/i);
      if (!match) throw new Error("Unable to parse the running process list.");
      const pid = Number(match[1]);
      if (pid === process.pid) sawSelf = true;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== bootstrapPid && !pids.includes(pid)) pids.push(pid);
    }
    if (!sawSelf) throw new Error("The running process list is incomplete.");
    return pids;
  } catch (error) {
    const detail = `tasklist failed (${error instanceof Error ? error.message : String(error)}); deferring activation`;
    log(detail);
    try { logUpdateHelper(`otherLauncherPids: ${detail}`); } catch {}
    throw new Error("Unable to check other MeshTalk windows. Close MeshTalk completely before restarting to update.");
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!backendPidAlive(pid)) return true;
    await Bun.sleep(200);
  }
  return !backendPidAlive(pid);
}

async function stopBackend(pid?: number, daemonise = true, proc?: ChildProcess): Promise<boolean> {
  if (!pid && daemonise) {
    try { pid = Number(readFileSync(`${DATA_DIR}/meshtalk.pid`, "utf-8").trim()); } catch {}
  }
  if (!pid || !Number.isInteger(pid)) return true;
  if (!backendPidAlive(pid)) return true;
  const useGroup = process.platform !== "win32" && (daemonise || process.platform === "darwin");
  if (!signalBackend(pid, useGroup, "SIGTERM")) return true;
  if (await waitForPidExit(pid, 5_000)) return true;
  log("Backend did not stop gracefully; sending SIGKILL.");
  signalBackend(pid, useGroup, "SIGKILL");
  try { proc?.kill("SIGKILL"); } catch {}
  // Wait for the kill to land so a lingering backend cannot keep its
  // executable locked (blocking a Windows update) or pile up as an orphan.
  return await waitForPidExit(pid, 3_000);
}

async function reapBackendProcess(proc?: ChildProcess): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.once("error", () => resolve());
    }),
    Bun.sleep(3_000),
  ]);
}

function signalBackend(pid: number, useGroup: boolean, signal: NodeJS.Signals): boolean {
  try {
    process.kill(useGroup ? -pid : pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function startBackend(backend: Component, daemonise = true): ChildProcess {
  const logFile = openSync(BACKEND_LOG_PATH, "a");
  try {
    const detached = daemonise || process.platform === "darwin";
    const proc = spawnProcess(backend.command[0], backend.command.slice(1), {
      cwd: backend.cwd,
      detached,
      stdio: ["ignore", logFile, logFile],
      windowsHide: true,
      env: { ...process.env, MESHTALK_RELEASE: IS_RELEASE_BUILD ? "1" : "0", MESHTALK_APP_VERSION: APP_RELEASE_VERSION },
    });
    if (proc.pid && installedLauncher) retainChildRelease(installedLauncher, proc.pid, "backend");
    if (daemonise) {
      proc.unref();
      if (proc.pid) {
        writeFileSync(`${DATA_DIR}/meshtalk.pid`, String(proc.pid));
      }
    }
    return proc;
  } finally {
    closeSync(logFile);
  }
}

async function closeForInstallation(destination: string): Promise<void> {
  if (!existsSync(destination)) return;
  const root = managedInstallRoot(destination);
  const additional = root === realpathSync(destination) ? [] : [root];
  if (installationProcessPids(destination, additional).length === 0) return;
  console.log("Closing MeshTalk for installation. Active sessions and file transfers will be interrupted.");
  // TUI windows already exit when their authenticated backend disconnects.
  // Give them time to restore their terminals before signalling any leftovers.
  if (await backendRunning()) {
    if (!await requestBackendShutdown()) throw new Error("MeshTalk's backend did not shut down. Close MeshTalk manually and retry; the installation was not changed.");
    await Bun.sleep(2000);
  }
  await closeInstallationProcesses(destination, additional);
}

async function main() {
  const args = process.argv.slice(2);

  if (IS_RELEASE_BUILD && args[0] === "--install-protocol" && args.length === 1) {
    console.log(INSTALL_PROTOCOL);
    return;
  }
  if (IS_RELEASE_BUILD && args[0] === "--install-status") {
    if (args.length !== 3 || args[1] !== "--install-dir") throw new Error("Invalid installation status arguments.");
    const destination = resolve(args[2]);
    if (!existsSync(destination)) {
      console.log("stopped");
      return;
    }
    const root = managedInstallRoot(destination);
    const additional = root === realpathSync(destination) ? [] : [root];
    console.log(installationProcessPids(destination, additional).length > 0 ? "running" : "stopped");
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  if (IS_RELEASE_BUILD && args[0] === "--apply-pending") {
    if (!isWindows || args.length !== 5 || args[1] !== "--install-dir" || args[3] !== "--release" || !/^release-[a-f0-9]{32}$/.test(args[4])) throw new Error("Invalid pending installer arguments.");
    const destination = resolve(args[2]);
    const lease = retainInstallerRelease(process.execPath);
    if (!lease || lease.root !== managedInstallRoot(destination)) throw new Error("The pending installer must run from this installation's verified release store.");
    let phase = "reading the selected release";
    try {
      const deadline = Date.now() + 5 * 60_000;
      while (true) {
        // A newer download may supersede the one that started this helper.
        // Always apply the latest verified selection after the windows close.
        phase = "reading the selected release";
        let update = pendingFlatInstallation(destination);
        if (!update) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        phase = "waiting for verified process inspection";
        if (!await waitForInstallationToStop(destination, [], remaining)) {
          logUpdateHelper("Offline entry refresh deferred because running processes or process inspection did not settle.");
          return;
        }
        // Downloads can supersede this helper's original release while it waits.
        phase = "reading the selected release";
        update = pendingFlatInstallation(destination);
        if (!update) return;
        phase = "replacing the entry executable";
        installFromDirectory(update.source, destination, update.version, { keepFlat: true, expectedRelease: update.release });
      }
    } catch (error) {
      logUpdateHelper(`Offline entry refresh failed while ${phase}.`);
      throw error;
    } finally {
      releaseUsage(lease);
      releaseFlatHelper(destination);
    }
    return;
  }
  if (IS_RELEASE_BUILD && args[0] === "--uninstall-releases") {
    if ((args.length !== 3 && !(args.length === 4 && args[3] === "--close-running")) || args[1] !== "--install-dir") throw new Error("Invalid uninstaller arguments.");
    if (args[3] === "--close-running") await closeForInstallation(resolve(args[2]));
    if (await backendRunning() || otherLauncherPids().length > 0) throw new Error("Close all MeshTalk windows and stop its backend before uninstalling.");
    uninstallReleaseInstallation(resolve(args[2]));
    return;
  }
  if (IS_RELEASE_BUILD && args[0] === "--install-from") {
    if ((args.length !== 4 && !(args.length === 5 && args[4] === "--close-running")) || args[2] !== "--install-dir") throw new Error("Invalid installer arguments.");
    const destination = resolve(args[3]);
    if (args[4] === "--close-running") await closeForInstallation(destination);
    if (await backendRunning() || otherLauncherPids().length > 0) {
      if (!existsSync(destination) || !existsSync(join(managedInstallRoot(destination), ".meshtalk-install.json"))) throw new Error("Close all MeshTalk windows and stop its backend before upgrading this legacy installation, or rerun the installer with --close-running.");
      stageReleaseDirectory(resolve(args[1]), destination, APP_RELEASE_VERSION);
      scheduleFlatEntryUpdate(destination);
      console.log("Update staged. Close MeshTalk and launch it again to activate it.");
    } else {
      installFromDirectory(resolve(args[1]), destination, APP_RELEASE_VERSION);
    }
    return;
  }

  if (IS_RELEASE_BUILD) {
    const executable = realpathSync(process.execPath);
    const root = installationRoot(executable);
    if (isWindows && root && existsSync(join(DATA_DIR, "pending-update.json")) && !importLegacyWindowsUpdate(root)) {
      logUpdateHelper("Legacy pending update was not imported; preserving its files and the installed release.");
    }
    let activatePending = false;
    if (!await backendRunning()) {
      try { activatePending = otherLauncherPids().length === 0; } catch { /* Keep the existing selection when process inspection is unavailable. */ }
    }
    installedLauncher = prepareInstalledLauncher(executable, activatePending, APP_RELEASE_VERSION);
    if (installedLauncher) {
      if (installedLauncher.warning) log(installedLauncher.warning);
      process.on("exit", () => {
        if (!installedLauncher) return;
        releaseUsage(installedLauncher);
        cleanupReleases(installedLauncher.root);
        scheduleFlatEntryUpdate(installedLauncher.root);
      });
      if (realpathSync(installedLauncher.executable) !== executable) {
        process.exit(await launchReplacement(installedLauncher.executable, args, true));
      }
      const cleanup = setInterval(() => cleanupReleases(installedLauncher!.root), 30_000);
      cleanup.unref();
    }
  }

  // This is deliberately detached from startup: analytics may never delay chat.
  // Tier 0 version pings send only after an explicit basic or extended choice.
  const consentState = readConsent(DATA_DIR);
  const dryRun = args.includes("--dry-run");
  if (isTier0Allowed(IS_RELEASE_BUILD, DATA_DIR, dryRun) && !consentState.seenVersions.includes(APP_RELEASE_VERSION)) {
    void sendTier0(APP_RELEASE_VERSION).then((sent) => {
      if (sent) {
        const current = readConsent(DATA_DIR);
        writeConsent(current.consent, [...current.seenVersions, APP_RELEASE_VERSION], DATA_DIR);
      }
    });
  }

  if (args[0] === "update") {
    await runUpdate(args.slice(1));
    process.exit(0);
  }

  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) {
    process.env.MESHTALK_PROGRAM = PROGRAM;
    await cliMain();
    process.exit(0);
  }

  if (args.length === 1 && ["--version", "-V"].includes(args[0])) {
    console.log(APP_RELEASE_VERSION);
    process.exit(0);
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
      try {
        if (!signalBackend(pid, useGroup, "SIGTERM")) { console.log("Backend is not running."); return; }
      } catch (error) {
        throw new Error(`Could not stop backend: ${error instanceof Error ? error.message : String(error)}`);
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await Bun.sleep(200);
        try { process.kill(pid, 0); } catch { console.log("Backend stopped."); return; }
      }
      log("Backend did not stop gracefully; sending SIGKILL.");
      signalBackend(pid, useGroup, "SIGKILL");
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

  const splash = splashOption(args);
  const components = resolveComponents();
  let backendPid: number | undefined;
  let backendProcess: ChildProcess | undefined;

  const alreadyRunning = await backendRunning();
  const launchTui = args.length === 0 || splash !== undefined;
  let iStartedIt = false;

  if (!alreadyRunning) {
    backendProcess = startBackend(components.backend, !launchTui);
    backendPid = backendProcess.pid ?? undefined;
    iStartedIt = true;
    if (!launchTui) {
      const ready = await waitForBackend(backendProcess);
      if (!ready) {
        log("Backend did not start within timeout.");
        log(`See ${BACKEND_LOG_PATH} for details.`);
        process.exit(1);
      }
    }
  }

  let code = 0;
  if (launchTui) {
    let cleanupPromise: Promise<boolean> | undefined;
    const cleanup = async () => {
      if (!iStartedIt) return Promise.resolve(true);
      return (cleanupPromise ??= stopBackend(backendPid, false, backendProcess).then(async (stopped) => {
        await reapBackendProcess(backendProcess);
        return stopped;
      }));
    };
    const tui = await runTui({ splashStyle: splash ?? savedSplashStyle(), analyticsPrompt: !dryRun && !hasExplicitAnalyticsChoice(DATA_DIR) && shouldPrompt(APP_RELEASE_VERSION, consentState, promptedVersions(DATA_DIR)) });
    if (iStartedIt) {
      // The TUI owns the visible startup state while the launcher waits silently.
      const ready = await waitForBackend(backendProcess);
      if (!ready) {
        log("Backend did not start within timeout.");
        tui.destroy();
        await cleanup();
        log(`See ${BACKEND_LOG_PATH} for details.`);
        process.exit(1);
      }
    }
    code = await tui.exited;
    if (code === UPDATE_RESTART_EXIT_CODE) {
      if (isWindows) logUpdateHelper(`restart requested (tui exit ${code})`);
      // Check before shutting down the shared backend, on every OS. Refusing
      // an update must not disconnect another open window.
      const others = otherLauncherPids();
      if (others.length > 0) throw new Error(`Another MeshTalk instance is still running (PID ${others.join(", ")}). Close other MeshTalk windows before restarting to update.`);
      if (!await requestBackendShutdown()) {
        // requestBackendShutdown returns false both when no backend is
        // listening on IPC and when a live backend ignored the shutdown.
        // Only signal the pid file in the latter case: a stale pid file may
        // otherwise point at a recycled PID belonging to an unrelated
        // process, which must never be signaled.
        if (await backendRunning()) {
          if (!await stopBackend(iStartedIt ? backendPid : undefined, !iStartedIt, iStartedIt ? backendProcess : undefined)) {
            if (isWindows) logUpdateHelper("restart ABORTED: backend did not stop");
            throw new Error("MeshTalk backend did not stop. Close MeshTalk completely and try the update again.");
          }
        } else if (isWindows) {
          logUpdateHelper("no backend on IPC; skipping pid-file signal (stale pid file is dropped below)");
        }
      }
      await reapBackendProcess(backendProcess);
      const backendPids = [iStartedIt ? backendPid : undefined, readPidFile()]
        .filter((pid): pid is number => Number.isInteger(pid) && (pid as number) > 0);
      for (const pid of new Set(backendPids)) {
        if (!await waitForPidExit(pid, 5_000)) throw new Error("MeshTalk backend is still running. Close MeshTalk completely before restarting to update.");
      }
      const restartPath = takeUpdateRestartPath();
      if (!restartPath) throw new Error("Update restart target was not provided.");
      const root = statSync(restartPath).isDirectory() ? restartPath : dirname(restartPath);
      const replacement = prepareUpdateRestart(root);
      if (installedLauncher) releaseUsage(installedLauncher);
      installedLauncher = replacement;
      code = await launchReplacement(replacement.executable, []);
    } else {
      await cleanup();
    }
  } else {
    if (IS_RELEASE_BUILD && process.stderr.isTTY && !hasExplicitAnalyticsChoice(DATA_DIR) && shouldPrompt(APP_RELEASE_VERSION, consentState, promptedVersions(DATA_DIR))) {
      console.error(`Analytics is disabled by default. Enable extended or basic analytics with MESHTALK_ANALYTICS=extended|basic, or choose in Settings > Diagnostics. Privacy policy: ${PRIVACY_URL}`);
      markPrompted(APP_RELEASE_VERSION, DATA_DIR);
    }
    process.env.MESHTALK_PROGRAM = PROGRAM;
    process.argv = [process.argv[0], process.argv[1], ...args];
    await cliMain();
    code = Number(process.exitCode ?? 0);
  }

  process.exit(code);
}

main();
