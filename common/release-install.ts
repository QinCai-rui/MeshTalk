import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { canLinkWindowsDirectory, cleanupWindowsMigration, publishWindowsEntry, removeWindowsEntry, windowsLinkStore, windowsRetiredDirectory, windowsStorePath } from "./windows-install-links"
import { installationEntryPath, physicalPath as realpathSync } from "./install-paths"

export const INSTALL_PROTOCOL = "1"
const STATE = ".meshtalk-install.json"
const RELEASE = ".meshtalk-release.json"
const USAGE = ".meshtalk-usage"
const RELEASE_NAME = /^release-[a-f0-9]{32}$/
const SUFFIX = process.platform === "win32" ? ".exe" : ""
export const releaseFiles = [`meshtalk${SUFFIX}`, `meshtalk-backend${SUFFIX}`]

type Selection = { schema: 1; current?: string; pending?: string; confirmed?: string; bootstrap?: string; legacy?: string[]; layout?: "file-link" | "directory-link" | "flat"; entry?: string }
type Payload = { schema: 1; version: string; files: Record<string, string> }
type Usage = { pid: number; release: string; kind: "launcher" | "backend" }
export type InstalledLauncher = { root: string; executable: string; usage: string; warning?: string }

function regularFile(path: string): boolean {
  try { return lstatSync(path).isFile() } catch { return false }
}

function ownedDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
  if (!lstatSync(path).isDirectory()) throw new Error("MeshTalk installation contains an unexpected directory link.")
}

// SQLite provides a crash-released OS file lock on all three platforms. Only
// short, synchronous filesystem operations belong in this transaction.
export function withInstallLock<T>(root: string, action: () => T, timeout = 10000): T {
  const lock = join(root, ".meshtalk-install-lock.sqlite")
  try {
    if (!lstatSync(lock).isFile()) throw new Error("MeshTalk installation lock is not a regular file.")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const database = new Database(lock, { create: true })
  try {
    chmodSync(lock, 0o600)
    database.exec(`PRAGMA busy_timeout = ${timeout}`)
    database.exec("BEGIN IMMEDIATE")
    try {
      const result = action()
      database.exec("COMMIT")
      return result
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  } finally {
    database.close()
  }
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
    const fd = openSync(temporary, "r+")
    try { fsyncSync(fd) } finally { closeSync(fd) }
    // Never unlink the old selector first: a failed replacement must leave it
    // usable, including on Windows when antivirus temporarily opens the file.
    renameSync(temporary, path)
    flushDirectory(dirname(path))
  } finally {
    rmSync(temporary, { force: true })
  }
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } catch (error) {
    if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
  } finally { closeSync(fd) }
}

function parseSelection(path: string): Selection | null {
  try {
    if (!regularFile(path)) return null
    const state = JSON.parse(readFileSync(path, "utf8"))
    if (state.schema !== 1) return null
    for (const key of ["current", "pending", "confirmed"]) {
      if (state[key] !== undefined && (typeof state[key] !== "string" || !RELEASE_NAME.test(state[key]))) return null
    }
    if (state.legacy !== undefined && (!Array.isArray(state.legacy) || state.legacy.some((name: unknown) => typeof name !== "string" || !/^\d+\.\d+\.\d+(?:-\d+)?-[a-f0-9]{12}$/.test(name)))) return null
    if (state.bootstrap !== undefined && (typeof state.bootstrap !== "string" || !/^[a-f0-9]{64}$/.test(state.bootstrap))) return null
    if (state.layout !== undefined && !["file-link", "directory-link", "flat"].includes(state.layout)) return null
    if (state.entry !== undefined && (typeof state.entry !== "string" || !isAbsolute(state.entry))) return null
    if (state.layout === "directory-link" && !state.entry) return null
    return { schema: 1, current: state.current, pending: state.pending, confirmed: state.confirmed, bootstrap: state.bootstrap, legacy: state.legacy, layout: state.layout, entry: state.entry }
  } catch { return null }
}

function readSelection(root: string): Selection {
  const path = join(root, STATE)
  const state = parseSelection(path) ?? parseSelection(`${path}.bak`)
  if (state) return state
  if (existsSync(path) || existsSync(`${path}.bak`)) throw new Error("MeshTalk's release selection is damaged. Run the installer to repair it.")
  return { schema: 1 }
}

function writeSelection(root: string, state: Selection): void {
  const path = join(root, STATE)
  const previous = parseSelection(path)
  if (previous && (!existsSync(`${path}.bak`) || previous.current === previous.confirmed)) writeJson(`${path}.bak`, previous)
  writeJson(path, state)
}

function digest(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")
}

// The public Windows directory can itself be a junction into a release. State
// and the installation lock live outside it, so switching releases cannot
// redirect either one. Unix command directories remain ordinary directories.
export function managedInstallRoot(installDir: string): string {
  const linked = process.platform === "win32" ? windowsLinkStore(installDir) ?? windowsLinkStore(installDir, true) : null
  if (linked) return realpathSync(linked)
  const actual = realpathSync(installDir)
  if (RELEASE_NAME.test(basename(actual)) && basename(dirname(actual)) === "versions") return dirname(dirname(actual))
  return actual
}

export function usesFlatWindowsEntry(installDir: string): boolean {
  if (process.platform !== "win32") return false
  try { return readSelection(managedInstallRoot(installDir)).layout !== "directory-link" } catch { return false }
}

export function pendingFlatInstallation(installDir: string): { root: string; release: string; source: string; version: string } | null {
  if (!usesFlatWindowsEntry(installDir)) return null
  const root = managedInstallRoot(installDir)
  const state = readSelection(root)
  const release = state.pending ?? state.current
  if (!release) return null
  const manifest = payload(root, release, true)
  if (!manifest || (!state.pending && regularFile(join(root, releaseFiles[0])) && digest(join(root, releaseFiles[0])) === manifest.files[releaseFiles[0]])) return null
  return { root, release, source: join(root, "versions", release), version: manifest.version }
}

// A shared Windows command directory cannot become a junction. A fresh copy
// of the downloaded launcher waits outside the root executable, then refreshes
// it after the last window closes. No installed launcher is retained forever.
export function scheduleFlatEntryUpdate(installDir: string): void {
  if (process.platform !== "win32") return
  try {
    const update = pendingFlatInstallation(installDir)
    if (!update) return
    withInstallLock(update.root, () => {
      const marker = join(update.root, ".meshtalk-flat-helper.json")
      try {
        const previous = JSON.parse(readFileSync(marker, "utf8"))
        const age = Date.now() - previous.createdAt
        if (Number.isInteger(previous.pid) && previous.pid > 0 && Number.isFinite(age) && age >= 0 && age < 6 * 60_000 && processMayBeAlive(previous.pid)) return
      } catch {}
      const child = spawn(join(update.source, releaseFiles[0]), ["--apply-pending", "--install-dir", update.root, "--release", update.release], { detached: true, stdio: "ignore", windowsHide: true })
      child.on("error", () => { /* Another launch/installer can retry the pending update. */ })
      if (child.pid) writeJson(marker, { pid: child.pid, release: update.release, createdAt: Date.now() })
      child.unref()
    })
  } catch { /* Updating must not interfere with an ordinary exit. */ }
}

export function releaseFlatHelper(installDir: string): void {
  try {
    const marker = join(managedInstallRoot(installDir), ".meshtalk-flat-helper.json")
    if (regularFile(marker) && JSON.parse(readFileSync(marker, "utf8")).pid === process.pid) rmSync(marker)
  } catch {}
}

export function retainInstallerRelease(executable: string): InstalledLauncher | null {
  const root = installationRoot(executable)
  if (!root) return null
  const actual = realpathSync(executable)
  const release = basename(dirname(actual))
  if (dirname(dirname(actual)) !== join(root, "versions") || !RELEASE_NAME.test(release)) return null
  return withInstallLock(root, () => {
    if (!payloadManifest(root, release)) throw new Error("The pending installer release is not owned by MeshTalk.")
    return { root, executable: actual, usage: retain(root, release, process.pid, "launcher") }
  })
}

function replaceSymlink(path: string, target: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    symlinkSync(target, temporary)
    renameSync(temporary, path)
    flushDirectory(dirname(path))
  } finally { rmSync(temporary, { force: true }) }
}

function publishEntry(root: string, state: Selection): void {
  if (!state.current) return
  const directory = join(root, "versions", state.current)
  if (state.layout === "file-link") {
    const currentLink = join(root, ".meshtalk-current")
    const currentInfo = lstatSync(currentLink, { throwIfNoEntry: false })
    if (currentInfo && !currentInfo.isSymbolicLink()) throw new Error("The MeshTalk current-link path is occupied by another file. The existing installation was left unchanged.")
    if (currentInfo) {
      const previous = resolve(root, readlinkSync(currentLink))
      if (dirname(previous) !== join(root, "versions") || !RELEASE_NAME.test(basename(previous))) throw new Error("The MeshTalk current link points outside its release store. Run the installer to repair it.")
    }
    replaceSymlink(currentLink, join("versions", state.current))
    const entry = join(root, releaseFiles[0])
    const target = join(".meshtalk-current", releaseFiles[0])
    // A command symlink must not point outside this installation. Replacing
    // its directory entry does not modify its old target or another program.
    let current: string | undefined
    try { current = readlinkSync(entry) } catch {}
    if (current !== target) replaceSymlink(entry, target)
  } else if (state.layout === "directory-link") {
    // Users may have added files through the public junction since migration.
    // Switching it would hide those files; refuse rather than take ownership.
    const existing = windowsLinkStore(state.entry!)
    if (existing && existsSync(state.entry!)) {
      const active = realpathSync(state.entry!)
      const allowed = new Set([...releaseFiles, RELEASE, ".meshtalk-staging.json"])
      if (readdirSync(active).some((name) => !allowed.has(name))) throw new Error("The MeshTalk command folder contains additional files. Move those files elsewhere before updating; nothing was removed.")
    }
    publishWindowsEntry(root, state.entry!, directory)
  }
}

function linkedEntryRelease(root: string, state: Selection): string | undefined {
  const entry = state.layout === "file-link" ? join(root, ".meshtalk-current") : state.layout === "directory-link" ? state.entry : undefined
  if (!entry) return
  try {
    const target = realpathSync(entry)
    if (dirname(target) === join(root, "versions") && RELEASE_NAME.test(basename(target))) return basename(target)
  } catch {}
}

function canCleanupWindowsMigration(root: string, state: Selection): boolean {
  try {
    const retired = windowsRetiredDirectory(root, state.entry!)
    if (!retired || !existsSync(retired)) return true
    const usage = liveUsage(retired)
    return Boolean(usage && !usage.some((entry) => entry.pid !== process.pid) && !hasUntrackedProcess(retired, new Set([process.pid])))
  } catch { return false }
}

function payloadManifest(root: string, name: string): Payload | null {
  if (!RELEASE_NAME.test(name)) return null
  const versions = join(root, "versions")
  const directory = join(versions, name)
  try {
    if (!lstatSync(versions).isDirectory() || !lstatSync(directory).isDirectory() || !regularFile(join(directory, RELEASE))) return null
    const value = JSON.parse(readFileSync(join(directory, RELEASE), "utf8")) as Payload
    if (value.schema !== 1 || typeof value.version !== "string" || !value.files || Object.keys(value.files).length !== releaseFiles.length) return null
    for (const file of releaseFiles) {
      if (!/^[a-f0-9]{64}$/.test(value.files[file] ?? "")) return null
    }
    return value
  } catch { return null }
}

function payload(root: string, name: string, verify = false): Payload | null {
  const value = payloadManifest(root, name)
  if (!value) return null
  try {
    for (const file of releaseFiles) {
      const path = join(root, "versions", name, file)
      if (!regularFile(path) || (verify && digest(path) !== value.files[file])) return null
    }
    return value
  } catch { return null }
}

function stageDirectory(root: string, source: string, version: string): string {
  ownedDirectory(join(root, "versions"))
  const staging = mkdtempSync(join(root, "versions", ".staging-"))
  try {
    writeJson(join(staging, ".meshtalk-staging.json"), { schema: 1 })
    const files: Record<string, string> = {}
    for (const name of releaseFiles) {
      if (!regularFile(join(source, name))) throw new Error(`Release is missing ${name}. Run the MeshTalk installer to repair it.`)
      const target = join(staging, name)
      copyFileSync(join(source, name), target)
      chmodSync(target, 0o755)
      const fd = openSync(target, "r+")
      try { fsyncSync(fd) } finally { closeSync(fd) }
      files[name] = digest(target)
    }
    const id = new Bun.CryptoHasher("sha256").update(JSON.stringify({ version, files })).digest("hex").slice(0, 32)
    let name = `release-${id}`
    writeJson(join(staging, RELEASE), { schema: 1, version, files })
    let destination = join(root, "versions", name)
    if (existsSync(destination) && !payload(root, name, true)) {
      // Repair alongside the damaged directory, never over a process that may
      // still be using it. The normal cleanup pass retires the old copy.
      name = `release-${randomUUID().replace(/-/g, "")}`
      destination = join(root, "versions", name)
    }
    if (!existsSync(destination)) {
      renameSync(staging, destination)
      flushDirectory(join(root, "versions"))
    }
    return name
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function processMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    // Access denied is not evidence that a process has stopped.
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function retain(root: string, release: string, pid: number, kind: Usage["kind"]): string {
  ownedDirectory(join(root, USAGE))
  const path = join(root, USAGE, `${randomUUID()}.json`)
  writeJson(path, { pid, release, kind })
  return path
}

// The launching process already holds a lease while a backend/child starts.
// Recording its PID before that lease can disappear closes the cleanup race.
export function retainChildRelease(launcher: InstalledLauncher, pid: number, kind: Usage["kind"]): void {
  if (!launcher.usage) return
  const release = basename(dirname(launcher.executable))
  try { retain(launcher.root, RELEASE_NAME.test(release) ? release : ".", pid, kind) } catch {
    // The process-list fallback will defer cleanup for this untracked child.
  }
}

export function releaseUsage(launcher: InstalledLauncher): void {
  try { rmSync(launcher.usage, { force: true }) } catch {}
}

function liveUsage(root: string): Usage[] | null {
  const directory = join(root, USAGE)
  if (!existsSync(directory)) return []
  try {
    if (!lstatSync(directory).isDirectory()) return null
    const live: Usage[] = []
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue
      const path = join(directory, entry)
      if (!regularFile(path)) return null
      const usage = JSON.parse(readFileSync(path, "utf8")) as Usage
      if (!Number.isInteger(usage.pid) || usage.pid <= 0 || (usage.release !== "." && !RELEASE_NAME.test(usage.release)) || !["launcher", "backend"].includes(usage.kind)) return null
      if (processMayBeAlive(usage.pid)) live.push(usage)
      else rmSync(path)
    }
    return live
  } catch { return null }
}

function prune(root: string, state: Selection): void {
  const usage = liveUsage(root)
  if (!usage) return
  // This also covers pre-migration launchers and Nuitka's worker process,
  // neither of which necessarily has a usage record of its own. An incomplete
  // process listing must defer deletion, never guess that a release is unused.
  if (hasUntrackedProcess(root, new Set([process.pid, ...usage.map((entry) => entry.pid)]))) return
  const keep = new Set([state.current, state.pending, ...usage.map((entry) => entry.release)])
  // An exit handler still runs inside its executable. Windows may refuse only
  // that file after a recursive deletion has already removed its manifest.
  // Leave our own physical release intact for a later process to collect.
  try {
    const actual = realpathSync(process.execPath)
    if (dirname(dirname(actual)) === join(root, "versions")) keep.add(basename(dirname(actual)))
  } catch { return }
  if (state.layout === "file-link" || state.layout === "directory-link") {
    const linked = linkedEntryRelease(root, state)
    if (!linked) return
    keep.add(linked)
  }
  // A previous selection remains a recovery route until the new launcher has
  // actually started and acknowledged the current release.
  const backup = parseSelection(join(root, `${STATE}.bak`))
  if (backup?.current) keep.add(backup.current)
  const versions = join(root, "versions")
  if (!existsSync(versions) || !lstatSync(versions).isDirectory()) return
  for (const name of readdirSync(versions)) {
    if (/^\.staging-[A-Za-z0-9]+$/.test(name)) {
      // Staging happens entirely under this same lock. No other installer can
      // own a staging directory while this cleanup pass holds it.
      const directory = join(versions, name)
      try {
        if (ownedStaging(directory)) rmSync(directory, { recursive: true, force: true })
      } catch {}
      continue
    }
    if (keep.has(name) || !payloadManifest(root, name)) continue
    // Never touch arbitrary directories or directory links under versions.
    try { rmSync(join(versions, name), { recursive: true, force: true }) } catch {}
  }
  if (state.current && state.confirmed === state.current && !usage.some((entry) => entry.release === ".")) {
    const legacyBackend = join(root, releaseFiles[1])
    if (regularFile(legacyBackend)) {
      try { rmSync(legacyBackend) } catch {}
    }
    for (const name of state.legacy ?? []) {
      const directory = join(versions, name)
      try {
        if (lstatSync(directory).isDirectory()) rmSync(directory, { recursive: true, force: true })
      } catch {}
    }
    if (state.layout === "directory-link" && state.entry && existsSync(join(root, ".meshtalk-migration.json"))) {
      if (canCleanupWindowsMigration(root, state)) {
        try { cleanupWindowsMigration(root, state.entry) } catch { /* Retry after the next successful start. */ }
      }
    }
  }
}

function ownedStaging(directory: string): boolean {
  try {
    const marker = join(directory, ".meshtalk-staging.json")
    return lstatSync(directory).isDirectory() && regularFile(marker) && JSON.parse(readFileSync(marker, "utf8")).schema === 1
  } catch { return false }
}

export function uninstallReleaseInstallation(installDir: string): void {
  const root = managedInstallRoot(installDir)
  withInstallLock(root, () => {
    const state = readSelection(root)
    const usage = liveUsage(root)
    if (!usage || usage.some((entry) => entry.pid !== process.pid) || hasUntrackedProcess(root, new Set([process.pid]))) {
      throw new Error("Close all MeshTalk windows and stop its backend before uninstalling.")
    }
    // The scripts invoke a temporary copy, so Windows can remove the installed
    // executables while this transaction still holds. Never follow entry links.
    if (state.layout === "directory-link") {
      if (existsSync(join(root, ".meshtalk-migration.json"))) {
        if (!canCleanupWindowsMigration(root, state)) throw new Error("Close all MeshTalk windows and stop its backend before uninstalling.")
        cleanupWindowsMigration(root, state.entry!)
      }
      removeWindowsEntry(root, state.entry!)
      rmSync(join(root, "current"), { force: true })
    }
    for (const file of releaseFiles) rmSync(join(root, file), { force: true })
    if (state.layout === "file-link") {
      const current = join(root, ".meshtalk-current")
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(current)
    }
    const versions = join(root, "versions")
    if (existsSync(versions) && lstatSync(versions).isDirectory()) {
      for (const name of readdirSync(versions)) {
        const directory = join(versions, name)
        if (payloadManifest(root, name) || (/^\.staging-[A-Za-z0-9]+$/.test(name) && ownedStaging(directory))) {
          rmSync(directory, { recursive: true, force: true })
        }
      }
      try { rmdirSync(versions) } catch {}
    }
    for (const name of [STATE, `${STATE}.bak`, ".meshtalk-current.json", ".meshtalk-current.json.bak", ".meshtalk-pending.json", ".meshtalk-flat-helper.json"]) {
      rmSync(join(root, name), { force: true })
    }
    const records = join(root, USAGE)
    if (existsSync(records) && lstatSync(records).isDirectory()) {
      for (const name of readdirSync(records)) {
        const path = join(records, name)
        if (regularFile(path) && name.endsWith(".json")) rmSync(path)
      }
      try { rmdirSync(records) } catch {}
    }
    // Keep the tiny lock database. Unlinking it could let a waiting installer
    // and a fresh installer acquire different inodes for the same lock path.
  })
}

function hasUntrackedProcess(root: string, known: Set<number>): boolean {
  try {
    root = realpathSync(root)
    const windows = process.platform === "win32"
    const result = Bun.spawnSync(windows ? ["tasklist", "/fo", "csv", "/nh"] : ["ps", "-A", "-o", "pid=,comm="], { stdout: "pipe", stderr: "ignore" })
    if (result.exitCode !== 0) return true
    const output = new TextDecoder().decode(result.stdout).trim()
    if (!output) return true
    for (const line of output.split("\n")) {
      const match = windows ? line.match(/^"([^"]+)","\s*(\d+)\s*"/) : line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) return true
      const pid = Number(match[windows ? 2 : 1])
      const name = basename(match[windows ? 1 : 2]).toLowerCase()
      if (name.startsWith("meshtalk") && !known.has(pid)) {
        let executable: string
        try {
          if (process.platform === "linux") executable = readlinkSync(`/proc/${pid}/exe`)
          else if (!windows) executable = realpathSync(match[2])
          else {
            const path = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ExecutablePath`], { stdout: "pipe", stderr: "ignore" })
            if (path.exitCode !== 0) return true
            executable = new TextDecoder().decode(path.stdout).trim()
            if (!executable) throw new Error("Process path unavailable")
            executable = realpathSync(executable)
          }
        } catch {
          if (processMayBeAlive(pid)) return true
          continue
        }
        const normalize = (path: string) => windows ? path.toLowerCase() : path
        if (normalize(executable).startsWith(normalize(root + sep))) return true
      }
    }
    return false
  } catch { return true }
}

export function cleanupReleases(root: string): void {
  try { withInstallLock(root, () => prune(root, readSelection(root)), 0) } catch {}
}

export function hasManagedBootstrap(installDir: string): boolean {
  try {
    const root = managedInstallRoot(installDir)
    const state = readSelection(root)
    if (state.layout === "directory-link") return windowsLinkStore(state.entry!) === root
    if (state.layout === "file-link") return Boolean(state.current && realpathSync(join(root, releaseFiles[0])) === join(root, "versions", state.current, releaseFiles[0]))
    return Boolean(state.bootstrap && regularFile(join(root, releaseFiles[0])) && digest(join(root, releaseFiles[0])) === state.bootstrap)
  } catch { return false }
}

export function stageReleaseDirectory(source: string, installDir: string, version: string): void {
  const root = managedInstallRoot(installDir)
  withInstallLock(root, () => {
    const state = readSelection(root)
    const entry = state.layout === "directory-link" ? join(state.entry!, releaseFiles[0]) : join(root, releaseFiles[0])
    if (!existsSync(entry)) throw new Error("The MeshTalk entry point is missing. Run the installer to repair it.")
    const pending = stageDirectory(root, source, version)
    writeSelection(root, { ...state, pending })
    prune(root, { ...state, pending })
  })
}

function activate(root: string, state: Selection): Selection {
  if (!state.pending) return state
  if (!payload(root, state.pending, true)) throw new Error("The downloaded MeshTalk update is incomplete or damaged. The installed release was left unchanged; download the update again.")
  const next: Selection = { ...state, current: state.pending, pending: undefined }
  const hadSelection = existsSync(join(root, STATE))
  writeSelection(root, next)
  try { publishEntry(root, next) } catch (error) {
    if (hadSelection) writeJson(join(root, STATE), state)
    else rmSync(join(root, STATE), { force: true })
    throw error
  }
  return next
}

export function activateRelease(installDir: string): string {
  const root = managedInstallRoot(installDir)
  return withInstallLock(root, () => {
    const state = activate(root, readSelection(root))
    if (!state.current || !payload(root, state.current, true)) throw new Error("The selected MeshTalk release is missing or damaged. Run the installer to repair it.")
    return join(root, "versions", state.current, releaseFiles[0])
  })
}

export function prepareUpdateRestart(installDir: string): InstalledLauncher {
  const root = managedInstallRoot(installDir)
  return withInstallLock(root, () => {
    const state = activate(root, readSelection(root))
    if (!state.current || !payload(root, state.current, true)) throw new Error("The selected MeshTalk release is missing or damaged. Run the installer to repair it.")
    return {
      root,
      executable: join(root, "versions", state.current, releaseFiles[0]),
      usage: retain(root, state.current, process.pid, "launcher"),
    }
  })
}

export function installationRoot(executable: string): string | null {
  try {
    const directory = dirname(realpathSync(executable))
    if (basename(dirname(directory)) === "versions") return realpathSync(dirname(dirname(directory)))
    if (basename(executable) === releaseFiles[0]) return realpathSync(directory)
  } catch {}
  return null
}

// A running payload stays pinned to its physical release. Only an explicitly
// permitted restart/first window activates a pending selection and dispatches.
export function prepareInstalledLauncher(executable: string, activatePending = false, version = "legacy-flat"): InstalledLauncher | null {
  const root = installationRoot(executable)
  if (!root) return null
  const actual = realpathSync(executable)
  try { return withInstallLock(root, () => {
    migrateVersionManifest(root)
    let state = readSelection(root)
    const recovered = existsSync(join(root, STATE)) && !parseSelection(join(root, STATE))
    if (recovered) {
      writeSelection(root, state)
      publishEntry(root, state)
    }
    if (state.current && !state.layout) {
      state = { ...state, layout: process.platform === "win32" ? "flat" : "file-link" }
      writeSelection(root, state)
      publishEntry(root, state)
    }
    const ownRelease = basename(dirname(actual))
    const isPayload = RELEASE_NAME.test(ownRelease) && dirname(dirname(actual)) === join(root, "versions")
    if (!state.current && !isPayload && releaseFiles.every((file) => regularFile(join(root, file)))) {
      // First launch after a shipped flat updater installs this binary. Copy
      // the complete pair before selecting it; the running files stay intact.
      state = { ...state, current: stageDirectory(root, root, version), bootstrap: digest(join(root, releaseFiles[0])), layout: process.platform === "win32" ? "flat" : "file-link" }
      writeSelection(root, state)
      publishEntry(root, state)
    }
    let warning: string | undefined
    let switched = false
    if (state.current && state.layout !== "flat" && payload(root, state.current, true)) {
      const linked = linkedEntryRelease(root, state)
      // Publication can be interrupted after the JSON rename but before its
      // link switch. Repair that mismatch on the next launch. An explicitly
      // invoked older payload remains pinned when it was not the stale entry.
      let commandLinked = true
      if (state.layout === "file-link") {
        try { commandLinked = readlinkSync(join(root, releaseFiles[0])) === join(".meshtalk-current", releaseFiles[0]) } catch { commandLinked = false }
      }
      if (linked !== state.current || !commandLinked) {
        publishEntry(root, state)
        switched = isPayload && ownRelease === linked
      }
    }
    if (activatePending) {
      const previous = state.current
      try { state = activate(root, state) } catch (error) {
        if (!state.current || !payload(root, state.current, true)) throw error
        warning = "The downloaded update is damaged. Continuing with the installed release; download the update again."
      }
      switched ||= state.current !== previous
    }
    if (!state.current && !existsSync(join(root, STATE))) writeSelection(root, state)
    if (!isPayload && !state.bootstrap) {
      state = { ...state, bootstrap: digest(actual) }
      writeSelection(root, state)
    }
    const selected = isPayload && !switched && !recovered ? ownRelease : state.current
    if (selected && !payload(root, selected, true)) {
      const backup = parseSelection(join(root, `${STATE}.bak`))
      if (!backup?.current || !payload(root, backup.current, true)) throw new Error("MeshTalk release components are missing or damaged. Run the installer to repair this installation.")
      state = { ...backup, pending: state.pending }
      writeSelection(root, state)
      publishEntry(root, state)
      return { root, executable: join(root, "versions", backup.current, releaseFiles[0]), usage: retain(root, backup.current, process.pid, "launcher") }
    }
    const target = selected ? join(root, "versions", selected, releaseFiles[0]) : actual
    const usage = retain(root, selected ?? ".", process.pid, "launcher")
    if (isPayload && state.current === ownRelease) {
      // New release has reached its own entry point. Recovery no longer needs
      // the previous binaries, so they can be deleted once their users exit.
      state = { ...state, confirmed: ownRelease }
      writeSelection(root, state)
      writeJson(join(root, `${STATE}.bak`), state)
    }
    prune(root, state)
    return { root, executable: target, usage, warning }
  }) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!["EACCES", "EPERM", "EROFS", "SQLITE_READONLY", "SQLITE_CANTOPEN"].includes(code ?? "")) throw error
    // Existing system-owned/manual installations must remain runnable even
    // when this user cannot migrate them or write usage records. Process
    // inspection makes cleanup conservative for these untracked instances.
    const state = readSelection(root)
    const ownRelease = basename(dirname(actual))
    const selected = RELEASE_NAME.test(ownRelease) ? ownRelease : state.current
    if (selected && payload(root, selected, true)) return { root, executable: join(root, "versions", selected, releaseFiles[0]), usage: "" }
    if (!selected && releaseFiles.every((file) => regularFile(join(root, file)))) return { root, executable: actual, usage: "" }
    throw error
  }
}

// Used by both shell installers. New releases keep the original two-file
// archive layout so already-shipped updaters can still install this version.
export function installFromDirectory(source: string, installDir: string, version: string, options: { keepFlat?: boolean; expectedRelease?: string } = {}): void {
  // Do not recreate a missing Windows entry directory before recovering its
  // migration journal: that would obstruct the installer restoring its link.
  if (process.platform === "win32" && !options.keepFlat) mkdirSync(dirname(resolve(installDir)), { recursive: true })
  else mkdirSync(installDir, { recursive: true })
  let root = process.platform === "win32" && !lstatSync(installDir, { throwIfNoEntry: false }) ? resolve(installDir) : managedInstallRoot(installDir)
  let entry: string | undefined
  let existing: Selection | undefined
  try { existing = readSelection(root) } catch { /* Explicit repair is allowed below. */ }
  if (process.platform === "win32" && !options.keepFlat && existing?.layout !== "directory-link" && canLinkWindowsDirectory(installDir)) {
    entry = installationEntryPath(installDir)
    root = windowsStorePath(entry)
    const marker = join(root, ".meshtalk-store.json")
    if (existsSync(root)) {
      if (!lstatSync(root).isDirectory() || !regularFile(marker)) throw new Error("The MeshTalk release-store path is already occupied. The existing installation was left unchanged.")
      const owner = JSON.parse(readFileSync(marker, "utf8"))
      if (owner.schema !== 1 || typeof owner.entry !== "string" || installationEntryPath(owner.entry).toLowerCase() !== entry.toLowerCase()) throw new Error("The MeshTalk release store belongs to a different installation.")
    } else {
      mkdirSync(root)
      writeJson(marker, { schema: 1, entry })
    }
  }
  withInstallLock(root, () => {
    // An explicit installer run may repair a damaged selector. Ordinary
    // launches never silently discard it or choose an arbitrary release.
    let state: Selection
    try { state = readSelection(root) } catch { state = { schema: 1 } }
    if (!state.layout && !entry && process.platform === "win32" && regularFile(join(root, ".meshtalk-store.json"))) {
      const marker = JSON.parse(readFileSync(join(root, ".meshtalk-store.json"), "utf8"))
      if (marker.schema === 1 && typeof marker.entry === "string" && windowsLinkStore(marker.entry, true) === root) state = { ...state, layout: "directory-link", entry: marker.entry }
      else throw new Error("MeshTalk's directory-link ownership could not be verified. The installation was left unchanged.")
    }
    if (options.expectedRelease && (state.pending ?? state.current) !== options.expectedRelease) return
    const pending = stageDirectory(root, source, version)
    let next: Selection
    if (process.platform !== "win32" || entry || state.layout === "directory-link") {
      if (entry && existsSync(entry) && hasUntrackedProcess(entry, new Set([process.pid]))) throw new Error("Close all MeshTalk windows and stop its backend before migrating this installation.")
      next = activate(root, { ...state, pending, layout: process.platform === "win32" ? "directory-link" : "file-link", entry: entry ?? state.entry, bootstrap: undefined })
    } else if (!regularFile(join(root, releaseFiles[0])) || digest(join(root, releaseFiles[0])) !== digest(join(source, releaseFiles[0]))) {
      if (regularFile(join(root, releaseFiles[0])) && hasUntrackedProcess(root, new Set([process.pid]))) throw new Error("Close all MeshTalk windows and stop its backend before migrating this installation.")
      const temporary = join(root, `.meshtalk-bootstrap-${randomUUID()}${SUFFIX}`)
      try {
        copyFileSync(join(source, releaseFiles[0]), temporary)
        chmodSync(temporary, 0o755)
        const fd = openSync(temporary, "r+")
        try { fsyncSync(fd) } finally { closeSync(fd) }
        const hadSelection = existsSync(join(root, STATE))
        // Publish the complete pair before upgrading the entry point. A crash
        // before rename leaves the old flat pair runnable; a crash after it
        // leaves the new bootstrap pointing to its complete release, never to
        // an old root backend. A sharing violation restores the old selection.
        next = activate(root, { ...state, pending, bootstrap: digest(temporary), layout: "flat" })
        try {
          renameSync(temporary, join(root, releaseFiles[0]))
        } catch (error) {
          if (hadSelection) writeJson(join(root, STATE), state)
          else rmSync(join(root, STATE), { force: true })
          throw error
        }
        flushDirectory(root)
      } finally { rmSync(temporary, { force: true }) }
    } else next = activate(root, { ...state, pending, layout: "flat", bootstrap: digest(join(root, releaseFiles[0])) })
    prune(root, next)
  })
}

function migrateVersionManifest(root: string): void {
  if (existsSync(join(root, STATE))) return
  const path = join(root, ".meshtalk-current.json")
  if (!existsSync(path)) return
  const manifest = JSON.parse(readFileSync(path, "utf8"))
  const name = manifest.current
  if (manifest.schema !== 1 || typeof name !== "string" || !/^\d+\.\d+\.\d+(?:-\d+)?-[a-f0-9]{12}$/.test(name)) throw new Error("The previous MeshTalk release selection is damaged. Run the installer to repair it.")
  const directory = join(root, "versions", name)
  if (!lstatSync(join(root, "versions")).isDirectory() || !lstatSync(directory).isDirectory()) throw new Error("The previous MeshTalk release directory is unsafe. Run the installer to repair it.")
  for (const file of releaseFiles) {
    if (!regularFile(join(directory, file)) || digest(join(directory, file)) !== manifest.files?.[file]?.sha256) throw new Error("The previous MeshTalk release is incomplete. Run the installer to repair it.")
  }
  const current = stageDirectory(root, directory, manifest.targetVersion)
  writeSelection(root, { schema: 1, current, legacy: [name] })
}
