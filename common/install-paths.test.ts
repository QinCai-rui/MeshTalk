import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installationEntryPath, physicalPath } from "./install-paths"

const directories: string[] = []
function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), "meshtalk-install-paths-"))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("physical paths resolve directory links to their actual release", () => {
  const root = temporary()
  const release = join(root, "release")
  mkdirSync(release)
  const entry = join(root, "command")
  symlinkSync(release, entry, process.platform === "win32" ? "junction" : "dir")
  expect(physicalPath(entry)).toBe(join(physicalPath(root), "release"))
})

test("entry paths preserve the public junction instead of resolving it into a release", () => {
  const root = temporary()
  const release = join(root, "release")
  mkdirSync(release)
  const entry = join(root, "command")
  symlinkSync(release, entry, process.platform === "win32" ? "junction" : "dir")
  expect(installationEntryPath(entry)).toBe(join(physicalPath(root), "command"))
  expect(installationEntryPath(entry)).not.toBe(physicalPath(entry))
})

test("entry planning resolves existing ancestors but allows missing descendants", () => {
  const root = temporary()
  const alias = join(root, "alias")
  const parent = join(root, "actual")
  mkdirSync(parent)
  symlinkSync(parent, alias, process.platform === "win32" ? "junction" : "dir")
  expect(installationEntryPath(join(alias, "new", "command"))).toBe(join(physicalPath(parent), "new", "command"))
})

test("a dangling ancestor is not treated as a missing directory we can create", () => {
  const root = temporary()
  const alias = join(root, "dangling")
  symlinkSync(join(root, "missing"), alias, process.platform === "win32" ? "junction" : "dir")
  expect(() => installationEntryPath(join(alias, "command"))).toThrow()
})
