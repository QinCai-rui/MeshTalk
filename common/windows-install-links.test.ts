import { afterEach, describe, expect, test, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as childProcess from "node:child_process"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { canLinkWindowsDirectory, cleanupWindowsMigration, publishWindowsEntry, removeWindowsEntry, windowsLinkStore, windowsStorePath } from "./windows-install-links"

const directories: string[] = []
const windows = process.platform === "win32"
const nativeTest = windows ? test : test.skip
const id = "11111111-1111-4111-8111-111111111111"

function temporary(): string {
  const path = fs.mkdtempSync(join(tmpdir(), "meshtalk-links-"))
  directories.push(path)
  return path
}

function put(path: string, value: unknown): void {
  fs.writeFileSync(path, JSON.stringify(value))
}

function payload(versions: string, digit = "a"): string {
  fs.mkdirSync(versions, { recursive: true })
  const path = join(versions, `release-${digit.repeat(32)}`)
  fs.mkdirSync(path)
  fs.writeFileSync(join(path, "meshtalk.exe"), digit)
  fs.writeFileSync(join(path, "meshtalk-backend.exe"), digit)
  put(join(path, ".meshtalk-release.json"), { schema: 1, version: "1.0.0", files: { "meshtalk.exe": "a".repeat(64), "meshtalk-backend.exe": "b".repeat(64) } })
  return path
}

function installation() {
  const entry = join(temporary(), "bin ' $ [entry]")
  const store = windowsStorePath(entry)
  fs.mkdirSync(store)
  put(join(store, ".meshtalk-install.json"), { schema: 1, layout: "directory-link", entry })
  return { entry, store, release: payload(join(store, "versions")) }
}

afterEach(() => {
  for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true })
})

describe("Windows installation ownership", () => {
  test("store is an absolute hidden sibling, not inside the entry", () => {
    const entry = resolve("somewhere", "bin")
    expect(windowsStorePath(entry)).toBe(join(dirname(entry), ".bin.meshtalk-install"))
    expect(windowsStorePath(dirname(dirname(entry)))).not.toBe(entry)
  })

  test("missing, empty, and known flat installations are eligible", () => {
    const root = temporary()
    expect(canLinkWindowsDirectory(join(root, "absent"))).toBe(true)
    expect(canLinkWindowsDirectory(root)).toBe(true)
    for (const name of ["meshtalk.exe", "meshtalk-backend.exe", ".meshtalk-install.json", ".meshtalk-install.json.bak", ".meshtalk-install-lock.sqlite", ".meshtalk-install-lock.sqlite-shm", ".meshtalk-install-lock.sqlite-wal", ".meshtalk-pending.json", ".meshtalk-current.json"]) fs.writeFileSync(join(root, name), "old")
    payload(join(root, "versions"))
    expect(canLinkWindowsDirectory(root)).toBe(true)
  })

  test("unknown root or release files and unknown version directories are preserved", () => {
    const root = temporary()
    const release = payload(join(root, "versions"))
    fs.writeFileSync(join(root, "notes.txt"), "keep")
    expect(canLinkWindowsDirectory(root)).toBe(false)
    fs.unlinkSync(join(root, "notes.txt"))
    fs.writeFileSync(join(release, "notes.txt"), "keep")
    expect(canLinkWindowsDirectory(root)).toBe(false)
    fs.unlinkSync(join(release, "notes.txt"))
    fs.mkdirSync(join(root, "versions", "unrelated"))
    expect(canLinkWindowsDirectory(root)).toBe(false)
    expect(fs.readFileSync(join(release, "meshtalk.exe"), "utf8")).toBe("a")
  })

  test("release manifests and owned staging must be valid", () => {
    const root = temporary()
    const release = payload(join(root, "versions"))
    const staging = join(root, "versions", ".staging-abc123")
    fs.mkdirSync(staging)
    expect(canLinkWindowsDirectory(root)).toBe(false)
    put(join(staging, ".meshtalk-staging.json"), { schema: 1 })
    expect(canLinkWindowsDirectory(root)).toBe(true)
    put(join(release, ".meshtalk-release.json"), { schema: 1, version: "bad", files: {} })
    expect(canLinkWindowsDirectory(root)).toBe(false)
  })

  test("usage markers require valid names, PIDs, release names, and kinds", () => {
    const root = temporary()
    const usage = join(root, ".meshtalk-usage")
    fs.mkdirSync(usage)
    const path = join(usage, `${id}.json`)
    put(path, { pid: 1, release: ".", kind: "launcher" })
    expect(canLinkWindowsDirectory(root)).toBe(true)
    for (const value of [{ pid: 0, release: ".", kind: "launcher" }, { pid: 1, release: "../other", kind: "backend" }, { pid: 1, release: ".", kind: "unknown" }]) {
      put(path, value)
      expect(canLinkWindowsDirectory(root)).toBe(false)
    }
    fs.unlinkSync(path)
    put(join(usage, "notes.json"), { pid: 1, release: ".", kind: "launcher" })
    expect(canLinkWindowsDirectory(root)).toBe(false)
  })

  test.skipIf(windows)("directory and file symlinks are never eligible", () => {
    const root = temporary()
    const outside = temporary()
    fs.symlinkSync(outside, join(root, "versions"), "dir")
    expect(canLinkWindowsDirectory(root)).toBe(false)
    fs.unlinkSync(join(root, "versions"))
    fs.writeFileSync(join(outside, "file"), "keep")
    fs.symlinkSync(join(outside, "file"), join(root, "meshtalk.exe"))
    expect(canLinkWindowsDirectory(root)).toBe(false)
    expect(canLinkWindowsDirectory(join(root, "meshtalk.exe"))).toBe(false)
  })

  test.skipIf(windows)("Windows mutations fail closed on other platforms", () => {
    const { entry, store, release } = installation()
    expect(windowsLinkStore(entry)).toBeNull()
    expect(() => publishWindowsEntry(store, entry, release)).toThrow("local Windows drive")
    expect(() => cleanupWindowsMigration(store, entry)).toThrow()
    expect(() => removeWindowsEntry(store, entry)).toThrow()
    expect(fs.existsSync(entry)).toBe(false)
    expect(fs.existsSync(release)).toBe(true)
  })
})

describe("native Windows junctions", () => {
  nativeTest("publishes and retargets without replacing current, and removes only the visible link", () => {
    const { entry, store, release } = installation()
    publishWindowsEntry(store, entry, release)
    expect(windowsLinkStore(entry)).toBe(store)
    const before = fs.lstatSync(join(store, "current")).ino
    const next = payload(join(store, "versions"), "b")
    publishWindowsEntry(store, entry, next)
    expect(fs.lstatSync(join(store, "current")).ino).toBe(before)
    expect(fs.readFileSync(join(entry, "meshtalk.exe"), "utf8")).toBe("b")
    removeWindowsEntry(store, entry)
    expect(fs.existsSync(entry)).toBe(false)
    expect(fs.existsSync(release)).toBe(true)
    expect(fs.existsSync(next)).toBe(true)
  }, 60000)

  nativeTest("migration journals retain old binaries until explicit cleanup", () => {
    const { entry, store, release } = installation()
    fs.mkdirSync(entry)
    fs.writeFileSync(join(entry, "meshtalk.exe"), "old")
    publishWindowsEntry(store, entry, release)
    const migration = JSON.parse(fs.readFileSync(join(store, ".meshtalk-migration.json"), "utf8"))
    expect(fs.readFileSync(join(migration.retired, "meshtalk.exe"), "utf8")).toBe("old")
    fs.writeFileSync(join(migration.retired, "unrelated"), "keep")
    expect(() => cleanupWindowsMigration(store, entry)).toThrow()
    expect(fs.existsSync(join(store, ".meshtalk-migration.json"))).toBe(true)
    fs.unlinkSync(join(migration.retired, "unrelated"))
    cleanupWindowsMigration(store, entry)
    expect(fs.existsSync(migration.retired)).toBe(false)
    expect(fs.existsSync(join(store, ".meshtalk-migration.json"))).toBe(false)
  }, 60000)

  nativeTest("recovers a crash after the old directory was moved", () => {
    const { entry, store, release } = installation()
    const retired = join(dirname(entry), `.${basename(entry)}.meshtalk-retired-${id}`)
    fs.mkdirSync(retired)
    fs.writeFileSync(join(retired, "meshtalk.exe"), "old")
    put(join(store, ".meshtalk-migration.json"), { schema: 1, entry, retired })
    publishWindowsEntry(store, entry, release)
    expect(windowsLinkStore(entry)).toBe(store)
    expect(fs.existsSync(retired)).toBe(true)
    cleanupWindowsMigration(store, entry)
    expect(fs.existsSync(retired)).toBe(false)
  }, 60000)

  nativeTest("failed entry creation rolls back both initial publish and directory migration", () => {
    const original = fs.symlinkSync
    for (const legacy of [false, true]) {
      const { entry, store, release } = installation()
      if (legacy) {
        fs.mkdirSync(entry)
        fs.writeFileSync(join(entry, "meshtalk.exe"), "old")
      }
      const spy = spyOn(fs, "symlinkSync").mockImplementation((target, path, type) => {
        if (String(path) === entry) throw new Error("Injected entry publication failure")
        return original(target, path, type)
      })
      try { expect(() => publishWindowsEntry(store, entry, release)).toThrow("Injected") } finally { spy.mockRestore() }
      expect(fs.existsSync(join(store, "current"))).toBe(false)
      expect(fs.existsSync(entry)).toBe(legacy)
      if (legacy) expect(fs.readFileSync(join(entry, "meshtalk.exe"), "utf8")).toBe("old")
      publishWindowsEntry(store, entry, release)
      expect(windowsLinkStore(entry)).toBe(store)
    }
  }, 60000)

  nativeTest("a native helper spawn failure preserves the previous target", () => {
    const { entry, store, release } = installation()
    publishWindowsEntry(store, entry, release)
    const next = payload(join(store, "versions"), "b")
    const original = childProcess.spawnSync
    const spy = spyOn(childProcess, "spawnSync").mockImplementation(((command: any, args: any, options: any) => {
      const request = JSON.parse(Buffer.from(options.env.MESHTALK_JUNCTION_ARGS, "base64").toString())
      if (request.update) return { error: new Error("Injected spawn failure"), status: null, stderr: "", stdout: "", signal: null, output: [], pid: 0 }
      return original(command, args, options)
    }) as typeof childProcess.spawnSync)
    try { expect(() => publishWindowsEntry(store, entry, next)).toThrow("Injected spawn failure") } finally { spy.mockRestore() }
    expect(fs.realpathSync(entry)).toBe(fs.realpathSync(release))
    expect(windowsLinkStore(entry)).toBe(store)
  }, 60000)

  nativeTest("unowned junctions are never recognized, followed, or removed", () => {
    const { entry, store, release } = installation()
    const outside = temporary()
    fs.symlinkSync(outside, entry, "junction")
    expect(windowsLinkStore(entry)).toBeNull()
    expect(canLinkWindowsDirectory(entry)).toBe(false)
    expect(() => publishWindowsEntry(store, entry, release)).toThrow("Unexpected")
    expect(() => removeWindowsEntry(store, entry)).toThrow("unowned")
    expect(fs.realpathSync(entry)).toBe(fs.realpathSync(outside))
  }, 60000)

  nativeTest("rejects forged journals, shared directories, and stores with the wrong owner", () => {
    const { entry, store, release } = installation()
    const outside = temporary()
    put(join(store, ".meshtalk-migration.json"), { schema: 1, entry, retired: outside })
    expect(() => publishWindowsEntry(store, entry, release)).toThrow("Unsafe")
    expect(() => cleanupWindowsMigration(store, entry)).toThrow("Unsafe")
    fs.unlinkSync(join(store, ".meshtalk-migration.json"))
    fs.mkdirSync(entry)
    fs.writeFileSync(join(entry, "notes.txt"), "keep")
    expect(() => publishWindowsEntry(store, entry, release)).toThrow("shared")
    put(join(store, ".meshtalk-install.json"), { layout: "directory-link", entry: outside })
    expect(() => publishWindowsEntry(store, entry, release)).toThrow("own")
    expect(fs.readFileSync(join(entry, "notes.txt"), "utf8")).toBe("keep")
  }, 60000)

  nativeTest("current can move while an old executable is still running", async () => {
    const { entry, store, release } = installation()
    fs.copyFileSync(join(process.env.SystemRoot!, "System32", "cmd.exe"), join(release, "meshtalk.exe"))
    publishWindowsEntry(store, entry, release)
    const child = Bun.spawn([join(entry, "meshtalk.exe"), "/d", "/c", "ping -n 60 127.0.0.1 > nul"], { stdout: "ignore", stderr: "ignore" })
    try {
      const next = payload(join(store, "versions"), "b")
      publishWindowsEntry(store, entry, next)
      expect(child.exitCode).toBeNull()
      expect(fs.readFileSync(join(entry, "meshtalk.exe"), "utf8")).toBe("b")
      expect(fs.existsSync(join(release, "meshtalk.exe"))).toBe(true)
    } finally { child.kill(); await child.exited }
  }, 60000)
})
