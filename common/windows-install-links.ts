import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

const STATE = ".meshtalk-install.json"
const JOURNAL = ".meshtalk-migration.json"
const RELEASE = /^release-[a-f0-9]{32}$/
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const binaries = ["meshtalk.exe", "meshtalk-backend.exe"]

function stat(path: string) {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function json(path: string): any {
  if (!stat(path)?.isFile()) throw new Error("MeshTalk metadata is not a regular file.")
  return JSON.parse(readFileSync(path, "utf8"))
}

function ordinary(path: string): boolean {
  return stat(path)?.isDirectory() === true && !stat(path)?.isSymbolicLink()
}

function same(a: string, b: string): boolean {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}

function ownedPayload(path: string, staging = false): boolean {
  if (!ordinary(path)) return false
  const manifest = staging ? json(join(path, ".meshtalk-staging.json")) : json(join(path, ".meshtalk-release.json"))
  if (manifest.schema !== 1) return false
  if (!staging && (typeof manifest.version !== "string" || !manifest.files || Object.keys(manifest.files).length !== binaries.length || binaries.some(name => !/^[a-f0-9]{64}$/.test(manifest.files[name] ?? "")))) return false
  const allowed = new Set([...binaries, ".meshtalk-release.json", ".meshtalk-staging.json"])
  return readdirSync(path).every(name => allowed.has(name) && stat(join(path, name))?.isFile())
}

/** Conservative: a shared folder or an unexpected link always uses flat replacement. */
export function canLinkWindowsDirectory(installDir: string): boolean {
  try {
    if (!stat(installDir)) return true
    if (!ordinary(installDir)) return false
    const files = new Set([...binaries, STATE, `${STATE}.bak`, ".meshtalk-install-lock.sqlite", ".meshtalk-install-lock.sqlite-journal", ".meshtalk-install-lock.sqlite-wal", ".meshtalk-install-lock.sqlite-shm", ".meshtalk-current.json", ".meshtalk-current.json.bak", ".meshtalk-pending.json"])
    return readdirSync(installDir).every(name => {
      const path = join(installDir, name)
      if (files.has(name)) return stat(path)?.isFile() === true
      if (name === "versions") return ordinary(path) && readdirSync(path).every(release => RELEASE.test(release) ? ownedPayload(join(path, release)) : /^\.staging-[A-Za-z0-9]+$/.test(release) && ownedPayload(join(path, release), true))
      if (name !== ".meshtalk-usage" || !ordinary(path)) return false
      return readdirSync(path).every(marker => {
        if (!new RegExp(`^${UUID}\\.json$`).test(marker)) return false
        const usage = json(join(path, marker))
        return Number.isSafeInteger(usage.pid) && usage.pid > 0 && (usage.release === "." || typeof usage.release === "string" && RELEASE.test(usage.release)) && ["launcher", "backend"].includes(usage.kind)
      })
    })
  } catch { return false }
}

export function windowsStorePath(installDir: string): string {
  const entry = resolve(installDir)
  if (entry === dirname(entry)) throw new Error("A filesystem root cannot be a MeshTalk entry.")
  return join(dirname(entry), `.${basename(entry)}.meshtalk-install`)
}

// Arguments never become PowerShell source. Both paths and source travel encoded.
const nativeSource = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class MeshTalkJunction {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetDriveTypeW(string root);
  public static void Local(string path) {
    uint type = GetDriveTypeW(System.IO.Path.GetPathRoot(path));
    if (type != 2 && type != 3 && type != 6) throw new Exception("MeshTalk requires a local drive");
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr x, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle h, uint c, byte[] i, int n, byte[] o, int z, out int r, IntPtr x);
  public static void Run(string path, string target, bool update) {
    using (var h = CreateFileW(path, update ? 0x40000000u : 0u, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] old = new byte[16384]; int count;
      if (!DeviceIoControl(h, 0x000900A8, null, 0, old, old.Length, out count, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (count < 16 || BitConverter.ToUInt32(old, 0) != 0xA0000003u) throw new Exception("Not a directory junction");
      if (!update) return;
      string previous = Encoding.Unicode.GetString(old, 16 + BitConverter.ToUInt16(old, 8), BitConverter.ToUInt16(old, 10));
      string expected = Environment.GetEnvironmentVariable("MESHTALK_JUNCTION_EXPECTED");
      if (!String.Equals(previous, "\\??\\" + expected, StringComparison.OrdinalIgnoreCase)) throw new Exception("Junction changed before retarget");
      byte[] name = Encoding.Unicode.GetBytes("\\??\\" + target);
      if (name.Length > 16360) throw new Exception("Junction target too long");
      byte[] data = new byte[name.Length + 20];
      Buffer.BlockCopy(BitConverter.GetBytes(0xA0000003u), 0, data, 0, 4);
      Buffer.BlockCopy(BitConverter.GetBytes((ushort)(name.Length + 12)), 0, data, 4, 2);
      Buffer.BlockCopy(BitConverter.GetBytes((ushort)name.Length), 0, data, 10, 2);
      Buffer.BlockCopy(BitConverter.GetBytes((ushort)(name.Length + 2)), 0, data, 12, 2);
      Buffer.BlockCopy(name, 0, data, 16, name.Length);
      if (!DeviceIoControl(h, 0x000900A4, data, data.Length, null, 0, out count, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}`

function native(link: string, target?: string, expected?: string, localOnly = false): void {
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MESHTALK_JUNCTION_SOURCE))); $a=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MESHTALK_JUNCTION_ARGS)) | ConvertFrom-Json); [MeshTalkJunction]::Local($a.link); if (-not $a.localOnly) { [MeshTalkJunction]::Run($a.link, $a.target, $a.update) }`
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, MESHTALK_JUNCTION_SOURCE: Buffer.from(nativeSource).toString("base64"), MESHTALK_JUNCTION_ARGS: Buffer.from(JSON.stringify({ link, target: target ?? "", update: target !== undefined, localOnly })).toString("base64"), MESHTALK_JUNCTION_EXPECTED: expected ?? "" },
    encoding: "utf8", windowsHide: true, timeout: 30000,
  })
  if (result.error || result.status !== 0) throw new Error(`Windows junction operation failed: ${result.error?.message ?? result.stderr.trim()}`)
}

function local(path: string): void {
  if (process.platform !== "win32" || !/^[a-z]:\\/i.test(path) || path.includes(":", 2)) throw new Error("MeshTalk junctions require a local Windows drive.")
  // Refuse redirected ancestors, including junctions into network shares.
  for (let parent = path; ; parent = dirname(parent)) {
    const info = stat(parent)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("MeshTalk installation has an unexpected linked ancestor.")
    if (parent === dirname(parent)) break
  }
}

function owner(storeRoot: string, installDir: string, recover = false): void {
  local(storeRoot)
  local(dirname(installDir))
  if (!same(storeRoot, windowsStorePath(installDir)) || !ordinary(storeRoot)) throw new Error("Unexpected MeshTalk store path.")
  const state = json(join(storeRoot, recover ? ".meshtalk-store.json" : STATE))
  if (state.entry !== resolve(installDir) || (recover ? state.schema !== 1 : state.layout !== "directory-link")) throw new Error("MeshTalk store does not own this entry.")
  native(storeRoot, undefined, undefined, true)
}

function junction(path: string, target: string): boolean {
  if (!stat(path)?.isSymbolicLink() || !same(linkTarget(path), target)) return false
  native(path)
  return true
}

function linkTarget(path: string): string {
  const target = readlinkSync(path)
  return target.startsWith("\\\\?\\") || target.startsWith("\\??\\") ? target.slice(4) : target
}

function releaseTarget(storeRoot: string, path: string, complete = false): void {
  if (!same(dirname(path), join(storeRoot, "versions")) || !RELEASE.test(basename(path)) || !ordinary(join(storeRoot, "versions"))) throw new Error("Unexpected MeshTalk release target.")
  // A missing old release is still a safe junction target to repair. New
  // targets must always contain their complete verified pair.
  if (!complete && !stat(path)) return
  if (!ownedPayload(path) || (complete && binaries.some(name => !stat(join(path, name))?.isFile()))) throw new Error("Unexpected MeshTalk release target.")
}

export function windowsLinkStore(installDir: string, recover = false): string | null {
  if (process.platform !== "win32") return null
  try {
    const entry = resolve(installDir)
    const store = windowsStorePath(entry)
    owner(store, entry, recover)
    const current = join(store, "current")
    if (!junction(entry, current)) return null
    if (!stat(current)) return store
    const target = linkTarget(current)
    releaseTarget(store, target)
    if (!junction(current, target) || (stat(target) && !same(realpathSync(entry), target))) return null
    return store
  } catch { return null }
}

type Migration = { schema: 1; entry: string; retired: string }

function journal(store: string, entry: string): Migration | null {
  const path = join(store, JOURNAL)
  if (!stat(path)) return null
  const value = json(path)
  const prefix = `.${basename(entry)}.meshtalk-retired-`
  if (value.schema !== 1 || value.entry !== entry || typeof value.retired !== "string" || !isAbsolute(value.retired) || value.retired !== join(dirname(entry), basename(value.retired)) || !new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${UUID}$`).test(basename(value.retired))) throw new Error("Unsafe MeshTalk migration journal.")
  return value
}

export function windowsRetiredDirectory(storeRoot: string, installDir: string): string | null {
  const store = resolve(storeRoot), entry = resolve(installDir)
  owner(store, entry)
  return journal(store, entry)?.retired ?? null
}

function record(store: string, value: Migration): void {
  const path = join(store, JOURNAL)
  const fd = openSync(path, "wx", 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
}

/** Caller holds the store lock and has stopped legacy processes before migration. */
export function publishWindowsEntry(storeRoot: string, installDir: string, releaseDir: string): void {
  const store = resolve(storeRoot), entry = resolve(installDir), release = resolve(releaseDir)
  owner(store, entry)
  releaseTarget(store, release, true)
  const current = join(store, "current")
  const existing = stat(current)
  let previous: string | undefined
  if (existing) {
    previous = linkTarget(current)
    releaseTarget(store, previous)
    if (!junction(current, previous)) throw new Error("Unexpected MeshTalk current link.")
  }
  let migration = journal(store, entry)
  if (migration && stat(migration.retired) && !canLinkWindowsDirectory(migration.retired)) throw new Error("MeshTalk retired directory contains unexpected files.")
  const visible = stat(entry)
  if (visible?.isSymbolicLink()) {
    if (!junction(entry, current)) throw new Error("Unexpected MeshTalk visible link.")
  } else if (visible && !canLinkWindowsDirectory(entry)) throw new Error("MeshTalk entry is a shared directory.")
  if (migration && stat(migration.retired) && visible && !visible.isSymbolicLink()) throw new Error("Both migration paths exist; refusing to overwrite either.")
  // Publish current before touching the old directory; native failures leave it intact.
  if (!existing) {
    try { symlinkSync(release, current, "junction") } catch (error) {
      // Some filesystems can leave the newly created, empty directory behind
      // when setting its reparse point fails. Never remove anything else.
      if (ordinary(current) && readdirSync(current).length === 0) rmdirSync(current)
      throw error
    }
  }
  else if (!same(previous!, release)) native(current, release, previous)
  let moved = false
  try {
    if (visible?.isSymbolicLink()) return
    if (visible) {
      if (!migration) {
        migration = { schema: 1, entry, retired: join(dirname(entry), `.${basename(entry)}.meshtalk-retired-${randomUUID()}`) }
        record(store, migration)
      }
      if (stat(migration.retired)) throw new Error("Retired MeshTalk path already exists.")
      renameSync(entry, migration.retired)
      moved = true
    }
    symlinkSync(current, entry, "junction")
  } catch (error) {
    // A failed visible-link creation must restore the exact original path.
    if (!visible || moved) {
      if (stat(entry)?.isSymbolicLink() && junction(entry, current)) unlinkSync(entry)
      else if (ordinary(entry) && readdirSync(entry).length === 0) rmdirSync(entry)
    }
    if (!stat(entry) && migration && stat(migration.retired)) renameSync(migration.retired, entry)
    if (previous && !same(previous, release)) native(current, previous, release)
    else if (!existing && junction(current, release)) unlinkSync(current)
    throw error
  }
}

/** Caller confirms the new launcher and absence of all old processes first. */
export function cleanupWindowsMigration(storeRoot: string, installDir: string): void {
  const store = resolve(storeRoot), entry = resolve(installDir)
  owner(store, entry)
  const value = journal(store, entry)
  if (!value) return
  if (windowsLinkStore(entry) !== store) throw new Error("MeshTalk migration entry is not published.")
  if (stat(value.retired)) {
    if (!canLinkWindowsDirectory(value.retired)) throw new Error("Refusing to remove unknown migration contents.")
    rmSync(value.retired, { recursive: true })
  }
  unlinkSync(join(store, JOURNAL))
}

export function removeWindowsEntry(storeRoot: string, installDir: string): void {
  const store = resolve(storeRoot), entry = resolve(installDir)
  owner(store, entry)
  if (windowsLinkStore(entry) !== store) throw new Error("Refusing to remove an unowned MeshTalk entry.")
  unlinkSync(entry)
}
