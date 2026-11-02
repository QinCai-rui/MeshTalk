import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupReleases, installationProcessRoots, installFromDirectory, installationRoot, managedInstallRoot, prepareInstalledLauncher, releaseFiles, releaseUsage, stageReleaseDirectory, uninstallReleaseInstallation } from "./release-install"
import { privateInstallationStore } from "./installation-store"
import { physicalPath } from "./install-paths"

let directory: string
let entry: string
let previousData: string | undefined
const unix = test.skipIf(process.platform === "win32")
const windows = test.skipIf(process.platform !== "win32")
// Native junction checks start several cold PowerShell processes per scenario.
if (process.platform === "win32") setDefaultTimeout(120000)

beforeEach(() => {
  directory = physicalPath(mkdtempSync(join(tmpdir(), "meshtalk-private-install-")))
  entry = join(directory, "bin")
  mkdirSync(entry)
  previousData = process.env.MESHTALK_DATA_DIR
  process.env.MESHTALK_DATA_DIR = join(directory, "data")
})

afterEach(() => {
  if (previousData === undefined) delete process.env.MESHTALK_DATA_DIR
  else process.env.MESHTALK_DATA_DIR = previousData
  rmSync(directory, { recursive: true, force: true })
})

function source(version: string): string {
  const path = join(directory, `source-${version}`)
  mkdirSync(path)
  for (const file of releaseFiles) writeFileSync(join(path, file), `${version} ${file}`)
  return path
}

function state(root = managedInstallRoot(entry)): any {
  return JSON.parse(readFileSync(join(root, ".meshtalk-install.json"), "utf8"))
}

test("default installs put complete releases in the configured private store", () => {
  installFromDirectory(source("1"), entry, "1")
  const root = managedInstallRoot(entry)
  expect(root).toBe(privateInstallationStore(entry))
  expect(state(root).entry).toBe(entry)
  expect(installationRoot(join(entry, releaseFiles[0]))).toBe(root)
  for (const file of releaseFiles) expect(readFileSync(join(root, "versions", state().current, file), "utf8")).toBe(`1 ${file}`)
  if (process.platform !== "win32") {
    expect(readdirSync(entry)).toEqual([releaseFiles[0]])
    expect(lstatSync(join(entry, releaseFiles[0])).isSymbolicLink()).toBe(true)
  }
})

test("public commands resolve their original private store after the data directory changes", () => {
  if (process.platform === "win32") writeFileSync(join(entry, "other-command.exe"), "keep")
  installFromDirectory(source("1"), entry, "1")
  const original = managedInstallRoot(entry)
  process.env.MESHTALK_DATA_DIR = join(directory, "another-data-directory")
  expect(managedInstallRoot(entry)).toBe(original)
  const launcher = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
  expect(launcher.root).toBe(original)
  releaseUsage(launcher)
})

unix("first launch copies an old managed store and dispatches into the private pair", () => {
  installFromDirectory(source("1"), entry, "1", { privateStore: false })
  const oldState = state(entry)
  const oldPayload = physicalPath(join(entry, releaseFiles[0]))
  writeFileSync(join(entry, "versions", "unrelated"), "keep")
  const launcher = prepareInstalledLauncher(oldPayload)!
  const root = managedInstallRoot(entry)
  expect(root).toBe(privateInstallationStore(entry))
  expect(launcher.executable).toBe(join(root, "versions", state(root).current, releaseFiles[0]))
  expect(launcher.root).toBe(root)
  expect(physicalPath(join(entry, releaseFiles[0]))).toBe(join(root, "versions", state(root).current, releaseFiles[0]))
  expect(existsSync(join(entry, "versions", oldState.current))).toBe(true)
  expect(readFileSync(join(entry, "versions", "unrelated"), "utf8")).toBe("keep")
  expect(installationProcessRoots(entry)).toContain(entry)
  releaseUsage(launcher)
  const confirmed = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
  releaseUsage(confirmed)
  cleanupReleases(root)
  expect(existsSync(join(entry, "versions", oldState.current))).toBe(false)
  expect(existsSync(join(entry, ".meshtalk-install.json"))).toBe(false)
  expect(existsSync(join(entry, ".meshtalk-install-lock.sqlite"))).toBe(false)
  expect(readFileSync(join(entry, "versions", "unrelated"), "utf8")).toBe("keep")
})

unix("flat first launch copies the pair without overwriting its old backend", () => {
  const path = source("flat")
  for (const file of releaseFiles) copyFileSync(join(path, file), join(entry, file))
  const launcher = prepareInstalledLauncher(join(entry, releaseFiles[0]), false, "flat")!
  expect(launcher.root).toBe(privateInstallationStore(entry))
  expect(readFileSync(join(entry, releaseFiles[1]), "utf8")).toBe(`flat ${releaseFiles[1]}`)
  expect(readFileSync(launcher.executable, "utf8")).toBe(`flat ${releaseFiles[0]}`)
  releaseUsage(launcher)
})

unix("a live legacy backend defers relocation until it exits", async () => {
  installFromDirectory(source("1"), entry, "1", { privateStore: false })
  const oldPayload = physicalPath(join(entry, releaseFiles[0]))
  const child = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
  try {
    mkdirSync(join(entry, ".meshtalk-usage"))
    writeFileSync(join(entry, ".meshtalk-usage", "legacy.json"), JSON.stringify({ pid: child.pid, release: state(entry).current, kind: "backend" }))
    const migrating = prepareInstalledLauncher(oldPayload)!
    releaseUsage(migrating)
    expect(managedInstallRoot(entry)).toBe(entry)
    expect(existsSync(oldPayload)).toBe(true)
    child.kill()
    await child.exited
    const migrated = prepareInstalledLauncher(oldPayload)!
    releaseUsage(migrated)
    const confirmed = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
    releaseUsage(confirmed)
    const root = managedInstallRoot(entry)
    cleanupReleases(root)
    expect(existsSync(oldPayload)).toBe(false)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
})

test("custom command directories have independent selections and uninstall ownership", () => {
  const other = join(directory, "other")
  mkdirSync(other)
  const first = source("1")
  installFromDirectory(first, entry, "1")
  installFromDirectory(first, other, "1")
  const root = managedInstallRoot(entry)
  const otherRoot = managedInstallRoot(other)
  expect(root).not.toBe(otherRoot)
  stageReleaseDirectory(source("2"), entry, "2")
  expect(state(root).pending).toBeDefined()
  expect(state(otherRoot).pending).toBeUndefined()
  uninstallReleaseInstallation(entry)
  expect(readFileSync(join(other, releaseFiles[0]), "utf8")).toBe(`1 ${releaseFiles[0]}`)
})

test("cleanup never removes added files inside an owned release", () => {
  installFromDirectory(source("1"), entry, "1")
  const root = managedInstallRoot(entry)
  const release = join(root, "versions", state(root).current)
  writeFileSync(join(release, "user-file"), "keep")
  // Shared Windows forwarding avoids the deliberate dedicated-folder refusal
  // when someone puts unrelated data through its junction.
  if (process.platform === "win32" && state(root).layout === "directory-link") {
    expect(() => installFromDirectory(source("2"), entry, "2")).toThrow()
  } else {
    installFromDirectory(source("2"), entry, "2")
    const confirmed = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
    releaseUsage(confirmed)
    cleanupReleases(root)
  }
  expect(readFileSync(join(release, "user-file"), "utf8")).toBe("keep")
})

unix("interrupted command publication is repaired from the private selection", () => {
  installFromDirectory(source("1"), entry, "1")
  const root = managedInstallRoot(entry)
  rmSync(join(entry, releaseFiles[0]))
  symlinkSync(join(directory, "missing"), join(entry, releaseFiles[0]))
  const payload = join(root, "versions", state(root).current, releaseFiles[0])
  const launcher = prepareInstalledLauncher(payload)!
  expect(physicalPath(join(entry, releaseFiles[0]))).toBe(payload)
  releaseUsage(launcher)
})

unix("a crash after relocation selection leaves the old command runnable and retries publication", () => {
  installFromDirectory(source("1"), entry, "1", { privateStore: false })
  const oldPayload = physicalPath(join(entry, releaseFiles[0]))
  const child = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test"
    import * as fs from "node:fs"
    const rename = fs.renameSync
    mock.module("node:fs", () => ({ ...fs, renameSync: (source, target) => {
      if (target === ${JSON.stringify(join(entry, releaseFiles[0]))}) process.exit(73)
      rename(source, target)
    }}))
    const { prepareInstalledLauncher } = await import(${JSON.stringify(new URL("./release-install.ts", import.meta.url).href)})
    prepareInstalledLauncher(${JSON.stringify(oldPayload)})
  `], { env: process.env, stdout: "pipe", stderr: "pipe" })
  expect(child.exitCode).toBe(73)
  expect(physicalPath(join(entry, releaseFiles[0]))).toBe(oldPayload)
  expect(readFileSync(oldPayload, "utf8")).toBe(`1 ${releaseFiles[0]}`)
  const retried = prepareInstalledLauncher(oldPayload)!
  expect(retried.root).toBe(privateInstallationStore(entry))
  expect(physicalPath(join(entry, releaseFiles[0]))).toBe(retried.executable)
  releaseUsage(retried)
})

windows("shared Windows forwarding executables use private releases", () => {
  writeFileSync(join(entry, "other-command.exe"), "keep")
  installFromDirectory(source("1"), entry, "1")
  expect(state().layout).toBe("flat")
  expect(managedInstallRoot(entry)).toBe(privateInstallationStore(entry))
  expect(readFileSync(join(entry, "other-command.exe"), "utf8")).toBe("keep")
  expect(existsSync(join(entry, "versions"))).toBe(false)
})

windows("an old shared Windows installation migrates on first launch", () => {
  writeFileSync(join(entry, "other-command.exe"), "keep")
  installFromDirectory(source("1"), entry, "1", { privateStore: false, keepFlat: true })
  const launcher = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
  expect(launcher.root).toBe(privateInstallationStore(entry))
  expect(existsSync(join(entry, "versions"))).toBe(true)
  expect(readFileSync(join(entry, "other-command.exe"), "utf8")).toBe("keep")
  releaseUsage(launcher)
  const confirmed = prepareInstalledLauncher(launcher.executable)!
  releaseUsage(confirmed)
  cleanupReleases(launcher.root)
  expect(existsSync(join(entry, "versions"))).toBe(false)
  expect(existsSync(join(entry, ".meshtalk-install-lock.sqlite"))).toBe(false)
  expect(readFileSync(join(entry, releaseFiles[0]), "utf8")).toBe(`1 ${releaseFiles[0]}`)
})

unix("uninstall collects an unconfirmed relocation instead of leaving the old store", () => {
  installFromDirectory(source("1"), entry, "1", { privateStore: false })
  const migrated = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
  releaseUsage(migrated)
  uninstallReleaseInstallation(entry)
  expect(readdirSync(entry)).toEqual([])
})

windows("an old Windows sibling store migrates without moving its executing payload", () => {
  installFromDirectory(source("1"), entry, "1", { privateStore: false })
  const previous = managedInstallRoot(entry)
  const oldPayload = physicalPath(join(entry, releaseFiles[0]))
  const launcher = prepareInstalledLauncher(oldPayload)!
  expect(launcher.executable).toBe(physicalPath(join(entry, releaseFiles[0])))
  expect(managedInstallRoot(entry)).toBe(privateInstallationStore(entry))
  expect(existsSync(oldPayload)).toBe(true)
  expect(installationProcessRoots(entry)).toContain(previous)
  releaseUsage(launcher)
  const confirmed = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
  releaseUsage(confirmed)
  cleanupReleases(confirmed.root)
  expect(existsSync(previous)).toBe(false)
})

windows("installer recovers an interrupted historical sibling migration before relocation", () => {
  const old = source("old")
  for (const file of releaseFiles) copyFileSync(join(old, file), join(entry, file))
  const next = source("new")
  installFromDirectory(next, entry, "new", { privateStore: false })
  const previous = managedInstallRoot(entry)
  const retired = JSON.parse(readFileSync(join(previous, ".meshtalk-migration.json"), "utf8")).retired
  rmSync(entry, { force: true })
  installFromDirectory(next, entry, "new")
  expect(managedInstallRoot(entry)).toBe(privateInstallationStore(entry))
  expect(readFileSync(join(entry, releaseFiles[0]), "utf8")).toBe(`new ${releaseFiles[0]}`)
  expect(previous).not.toBe(managedInstallRoot(entry))
  const confirmed = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
  releaseUsage(confirmed)
  cleanupReleases(confirmed.root)
  expect(existsSync(retired)).toBe(false)
  expect(existsSync(previous)).toBe(false)
})
