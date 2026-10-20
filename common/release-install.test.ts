import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { activateRelease, cleanupReleases, installFromDirectory, managedInstallRoot, pendingFlatInstallation, prepareInstalledLauncher, prepareUpdateRestart, releaseFiles, releaseUsage, retainChildRelease, stageReleaseDirectory, uninstallReleaseInstallation } from "./release-install"
import { physicalPath as realpathSync } from "./install-paths"

const stateFile = ".meshtalk-install.json"
const modulePath = new URL("./release-install.ts", import.meta.url).href
type Selection = { schema: 1; current?: string; pending?: string; bootstrap?: string; confirmed?: string }
let directory: string
let root: string
let children: ReturnType<typeof Bun.spawn>[]
const windowsTest = (name: string, action: () => void | Promise<void>) => test.skipIf(process.platform !== "win32")(name, action, 120000)

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "meshtalk-release-test-"))
  root = join(directory, "install")
  mkdirSync(root)
  root = realpathSync(root)
  // Exercise the shared-folder compatibility path here. Dedicated Windows
  // junction publication has its own native tests.
  if (process.platform === "win32") writeFileSync(join(root, "unrelated-command"), "keep")
  children = []
})

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
  rmSync(directory, { recursive: true, force: true })
})

function source(version: string): string {
  const path = join(directory, `source-${version}`)
  mkdirSync(path)
  for (const file of releaseFiles) writeFileSync(join(path, file), `${file} payload ${version}\n`)
  return path
}

function selection(): Selection {
  return JSON.parse(readFileSync(join(root, stateFile), "utf8"))
}

function payloadPath(id: string, file = releaseFiles[0]): string {
  return join(root, "versions", id, file)
}

function install(version = "1.0.0"): string {
  installFromDirectory(source(version), root, version)
  return selection().current!
}

function stage(version = "2.0.0"): string {
  stageReleaseDirectory(source(version), root, version)
  return selection().pending!
}

function assertPair(id: string, version: string): void {
  const manifest = JSON.parse(readFileSync(join(root, "versions", id, ".meshtalk-release.json"), "utf8"))
  expect(manifest.schema).toBe(1)
  expect(manifest.version).toBe(version)
  expect(Object.keys(manifest.files).sort()).toEqual([...releaseFiles].sort())
  for (const file of releaseFiles) {
    const bytes = readFileSync(payloadPath(id, file))
    expect(bytes.toString()).toBe(`${file} payload ${version}\n`)
    expect(manifest.files[file]).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
  }
}

function legacyVersion(): string {
  const name = "1.0.0-abcdef123456"
  const path = join(root, "versions", name)
  mkdirSync(path, { recursive: true })
  const original = source("1.0.0")
  const files: Record<string, { sha256: string }> = {}
  for (const file of releaseFiles) {
    copyFileSync(join(original, file), join(path, file))
    files[file] = { sha256: new Bun.CryptoHasher("sha256").update(readFileSync(join(path, file))).digest("hex") }
  }
  copyFileSync(join(original, releaseFiles[0]), join(root, releaseFiles[0]))
  writeFileSync(join(root, ".meshtalk-current.json"), JSON.stringify({ schema: 1, current: name, targetVersion: "1.0.0", files }))
  return path
}

function spawn(code: string) {
  const child = Bun.spawn([process.execPath, "--eval", code], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MESHTALK_DATA_DIR: join(directory, "data") },
  })
  children.push(child)
  return child
}

describe("release installation", () => {
  windowsTest("dedicated Windows installation switches the whole launcher without changing its command path", () => {
    const entry = join(directory, "dedicated")
    installFromDirectory(source("1.0.0"), entry, "1.0.0")
    const store = managedInstallRoot(entry)
    expect(store).not.toBe(entry)
    expect(lstatSync(entry).isSymbolicLink()).toBe(true)
    const first = realpathSync(join(entry, releaseFiles[0]))
    installFromDirectory(source("2.0.0"), entry, "2.0.0")
    expect(realpathSync(join(entry, releaseFiles[0]))).not.toBe(first)
    expect(readFileSync(join(entry, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 2.0.0\n`)
    const launcher = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
    releaseUsage(launcher)
    cleanupReleases(store)
    expect(existsSync(first)).toBe(false)
    expect(readdirSync(directory).some((name) => name.includes("meshtalk-retired-"))).toBe(false)
    uninstallReleaseInstallation(entry)
    expect(existsSync(entry)).toBe(false)
    expect(existsSync(join(store, stateFile))).toBe(false)
  })

  windowsTest("Windows link migration preserves the old pair until the new launcher confirms startup", () => {
    const entry = join(directory, "legacy dedicated")
    mkdirSync(entry)
    for (const file of releaseFiles) writeFileSync(join(entry, file), `old ${file}`)
    installFromDirectory(source("2.0.0"), entry, "2.0.0")
    const store = managedInstallRoot(entry)
    const journal = JSON.parse(readFileSync(join(store, ".meshtalk-migration.json"), "utf8"))
    expect(readFileSync(join(journal.retired, releaseFiles[0]), "utf8")).toBe(`old ${releaseFiles[0]}`)
    const launcher = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
    releaseUsage(launcher)
    cleanupReleases(store)
    expect(existsSync(journal.retired)).toBe(false)
  })

  windowsTest("a dedicated Windows installation can repair a missing selected backend", () => {
    const entry = join(directory, "repair dedicated")
    const original = source("1.0.0")
    installFromDirectory(original, entry, "1.0.0")
    const before = realpathSync(entry)
    rmSync(join(entry, releaseFiles[1]))
    installFromDirectory(original, entry, "1.0.0")
    expect(realpathSync(entry)).not.toBe(before)
    expect(readFileSync(join(entry, releaseFiles[1]), "utf8")).toBe(`${releaseFiles[1]} payload 1.0.0\n`)
  })

  windowsTest("a dedicated Windows installation can repair a missing release and two damaged selectors", () => {
    const entry = join(directory, "repair lost release")
    const original = source("1.0.0")
    installFromDirectory(original, entry, "1.0.0")
    const store = managedInstallRoot(entry)
    rmSync(realpathSync(entry), { recursive: true })
    writeFileSync(join(store, stateFile), "{bad main")
    writeFileSync(join(store, `${stateFile}.bak`), "{bad backup")
    installFromDirectory(original, entry, "1.0.0")
    expect(managedInstallRoot(entry)).toBe(store)
    expect(readFileSync(join(entry, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 1.0.0\n`)
    expect(JSON.parse(readFileSync(join(store, stateFile), "utf8")).layout).toBe("directory-link")
  })

  windowsTest("Windows uninstall followed by reinstall preserves the existing command path", () => {
    const entry = join(directory, "reinstall dedicated")
    installFromDirectory(source("1.0.0"), entry, "1.0.0")
    uninstallReleaseInstallation(entry)
    installFromDirectory(source("2.0.0"), entry, "2.0.0")
    expect(readFileSync(join(entry, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 2.0.0\n`)
  })

  windowsTest("the public Windows installer recovers a missing entry after a journaled migration crash", () => {
    const entry = join(directory, "interrupted migration")
    mkdirSync(entry)
    for (const file of releaseFiles) writeFileSync(join(entry, file), `old ${file}`)
    const original = source("1.0.0")
    installFromDirectory(original, entry, "1.0.0")
    const store = managedInstallRoot(entry)
    const journal = JSON.parse(readFileSync(join(store, ".meshtalk-migration.json"), "utf8"))
    expect(existsSync(journal.retired)).toBe(true)
    // This is the persisted filesystem state between moving the ordinary
    // directory aside and publishing its visible junction.
    rmSync(entry, { force: true })
    installFromDirectory(original, entry, "1.0.0")
    expect(managedInstallRoot(entry)).toBe(store)
    expect(readFileSync(join(entry, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 1.0.0\n`)
  })

  windowsTest("files added through a Windows command junction are never hidden by an update", () => {
    const entry = join(directory, "newly shared")
    installFromDirectory(source("1.0.0"), entry, "1.0.0")
    const before = realpathSync(entry)
    writeFileSync(join(entry, "user-file"), "keep")
    expect(() => installFromDirectory(source("2.0.0"), entry, "2.0.0")).toThrow()
    expect(realpathSync(entry)).toBe(before)
    expect(readFileSync(join(entry, "user-file"), "utf8")).toBe("keep")
    expect(readFileSync(join(entry, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 1.0.0\n`)
  })

  windowsTest("a shared Windows folder refreshes its forwarding executable rather than freezing it", () => {
    install()
    const pending = stage()
    const update = pendingFlatInstallation(root)!
    expect(update.release).toBe(pending)
    installFromDirectory(update.source, root, update.version, { keepFlat: true, expectedRelease: pending })
    expect(readFileSync(join(root, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 2.0.0\n`)
    expect(readFileSync(join(root, "unrelated-command"), "utf8")).toBe("keep")
    expect(pendingFlatInstallation(root)).toBeNull()
  })

  windowsTest("Windows startup reconciles a selector published before its junction switch", () => {
    const entry = join(directory, "interrupted selection")
    installFromDirectory(source("1.0.0"), entry, "1.0.0")
    const store = managedInstallRoot(entry)
    stageReleaseDirectory(source("2.0.0"), store, "2.0.0")
    const state = JSON.parse(readFileSync(join(store, stateFile), "utf8"))
    writeFileSync(join(store, stateFile), JSON.stringify({ ...state, current: state.pending, pending: undefined }))
    const launcher = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
    releaseUsage(launcher)
    expect(realpathSync(join(entry, releaseFiles[0]))).toBe(join(store, "versions", state.pending, releaseFiles[0]))
    expect(launcher.executable).toBe(realpathSync(join(entry, releaseFiles[0])))
  })

  windowsTest("retired Windows usage records protect live legacy processes outside the store", async () => {
    const entry = join(directory, "retired usage")
    mkdirSync(entry)
    for (const file of releaseFiles) writeFileSync(join(entry, file), `old ${file}`)
    installFromDirectory(source("1.0.0"), entry, "1.0.0")
    const store = managedInstallRoot(entry)
    const journal = JSON.parse(readFileSync(join(store, ".meshtalk-migration.json"), "utf8"))
    const child = spawn("setInterval(() => {}, 1000)")
    const records = join(journal.retired, ".meshtalk-usage")
    mkdirSync(records)
    writeFileSync(join(records, "11111111-1111-4111-8111-111111111111.json"), JSON.stringify({ pid: child.pid, release: ".", kind: "launcher" }))
    const launcher = prepareInstalledLauncher(join(entry, releaseFiles[0]))!
    releaseUsage(launcher)
    cleanupReleases(store)
    expect(existsSync(journal.retired)).toBe(true)
    child.kill()
    await child.exited
    cleanupReleases(store)
    expect(existsSync(journal.retired)).toBe(false)
  })

  test("a stale background helper cannot select an older download", () => {
    const current = install()
    const stale = stage()
    const next = stage("3.0.0")
    installFromDirectory(dirname(payloadPath(stale)), root, "2.0.0", { keepFlat: true, expectedRelease: stale })
    expect(selection()).toMatchObject({ current, pending: next })
    expect(readFileSync(join(root, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 1.0.0\n`)
  })

  test.skipIf(process.platform === "win32")("a valid selector interrupted before link publication is reconciled on the next launch", () => {
    const previous = install()
    const next = stage()
    const state = selection()
    writeFileSync(join(root, stateFile), JSON.stringify({ ...state, current: next, pending: undefined }))
    expect(realpathSync(join(root, releaseFiles[0]))).toBe(payloadPath(previous))
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    try {
      expect(launcher.executable).toBe(payloadPath(next))
      expect(realpathSync(join(root, releaseFiles[0]))).toBe(payloadPath(next))
    } finally { releaseUsage(launcher) }
  })

  test.skipIf(process.platform === "win32")("selectors from the executable-bootstrap implementation migrate to command links", () => {
    const original = source("1.0.0")
    for (const file of releaseFiles) copyFileSync(join(original, file), join(root, file))
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    releaseUsage(launcher)
    const state = selection()
    rmSync(join(root, releaseFiles[0]))
    copyFileSync(join(original, releaseFiles[0]), join(root, releaseFiles[0]))
    const inherited = { ...state } as Record<string, unknown>
    delete inherited.layout
    writeFileSync(join(root, stateFile), JSON.stringify(inherited))
    const migrated = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    releaseUsage(migrated)
    expect(lstatSync(join(root, releaseFiles[0])).isSymbolicLink()).toBe(true)
    const next = stage()
    activateRelease(root)
    expect(readFileSync(join(root, releaseFiles[0]))).toEqual(readFileSync(payloadPath(next)))
  })
  test("ancestor path aliases resolve to the same physical installation", () => {
    const current = install()
    const alias = join(directory, "parent-alias")
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir")
    const launcher = prepareInstalledLauncher(join(alias, "install", releaseFiles[0]))!
    try {
      expect(launcher.root).toBe(root)
      expect(launcher.executable).toBe(payloadPath(current))
    } finally { releaseUsage(launcher) }
  })

  test("executable path aliases do not change the physical installation root", async () => {
    const current = install()
    const alias = join(directory, "executable-parent-alias")
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir")
    const child = spawn(`
      import { mock } from "bun:test"
      import * as fs from "node:fs"
      const realpath = fs.realpathSync
      const native = realpath.native
      const aliasPath = (actual) => {
        if (actual === ${JSON.stringify(payloadPath(current))}) return ${JSON.stringify(join(alias, "versions", current, releaseFiles[0]))}
        return actual
      }
      const mocked = (path) => aliasPath(realpath(path))
      mocked.native = (path) => aliasPath(native(path))
      mock.module("node:fs", () => ({ ...fs, realpathSync: mocked }))
      const { installationRoot } = await import(${JSON.stringify(modulePath)})
      console.log(JSON.stringify(installationRoot(${JSON.stringify(payloadPath(current))})))
    `)
    expect(await child.exited).toBe(0)
    expect(JSON.parse(await new Response(child.stdout).text())).toBe(root)
  })

  test.each(["locked", "crash before bootstrap", "crash after bootstrap"])("legacy migration is recoverable: %s", async (failure) => {
    for (const file of releaseFiles) writeFileSync(join(root, file), `legacy ${file}`)
    const nextSource = source("2.0.0")
    const child = spawn(`
      import { mock } from "bun:test"
      import * as fs from "node:fs"
      const rename = fs.renameSync
      mock.module("node:fs", () => ({ ...fs, renameSync: (source, target) => {
        if (target === ${JSON.stringify(join(root, releaseFiles[0]))}) {
          if (${JSON.stringify(failure)} === "locked") throw Object.assign(new Error("locked"), { code: "EACCES" })
          if (${JSON.stringify(failure)} === "crash before bootstrap") process.exit(73)
          rename(source, target)
          process.exit(73)
        }
        rename(source, target)
      }}))
      const { installFromDirectory } = await import(${JSON.stringify(modulePath)})
      try { installFromDirectory(${JSON.stringify(nextSource)}, ${JSON.stringify(root)}, "2.0.0") }
      catch (error) { console.log(error.code); process.exit(72) }
    `)
    expect(await child.exited).toBe(failure === "locked" ? 72 : 73)
    expect(readFileSync(join(root, releaseFiles[1]), "utf8")).toBe(`legacy ${releaseFiles[1]}`)
    if (failure === "locked") {
      expect(existsSync(join(root, stateFile))).toBe(false)
      expect(readFileSync(join(root, releaseFiles[0]), "utf8")).toBe(`legacy ${releaseFiles[0]}`)
    } else {
      const selected = selection().current!
      assertPair(selected, "2.0.0")
      if (failure === "crash before bootstrap") expect(readFileSync(join(root, releaseFiles[0]), "utf8")).toBe(`legacy ${releaseFiles[0]}`)
      else {
        const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
        expect(launcher.executable).toBe(payloadPath(selected))
        releaseUsage(launcher)
      }
    }
  })

  test("cleanup and uninstall recognize owned releases even when a binary is missing", () => {
    const original = source("1.0.0")
    installFromDirectory(original, root, "1.0.0")
    const previous = selection().current!
    rmSync(payloadPath(previous, releaseFiles[1]))
    installFromDirectory(original, root, "1.0.0")
    const current = selection().current!
    expect(current).not.toBe(previous)
    const launcher = prepareInstalledLauncher(payloadPath(current))!
    releaseUsage(launcher)
    cleanupReleases(root)
    expect(existsSync(dirname(payloadPath(previous)))).toBe(false)
    rmSync(payloadPath(current, releaseFiles[1]))
    uninstallReleaseInstallation(root)
    expect(existsSync(dirname(payloadPath(current)))).toBe(false)
    expect(existsSync(join(root, releaseFiles[0]))).toBe(false)
  })

  test("managed uninstall removes only owned releases and both selectors", () => {
    const current = install()
    const unowned = join(root, "versions", "another-tool")
    mkdirSync(unowned)
    writeFileSync(join(unowned, "keep"), "unrelated")
    writeFileSync(join(root, "other-command"), "also unrelated")
    stage()
    uninstallReleaseInstallation(root)
    expect(existsSync(dirname(payloadPath(current)))).toBe(false)
    expect(readFileSync(join(unowned, "keep"), "utf8")).toBe("unrelated")
    expect(readFileSync(join(root, "other-command"), "utf8")).toBe("also unrelated")
    expect(existsSync(join(root, stateFile))).toBe(false)
    expect(existsSync(join(root, `${stateFile}.bak`))).toBe(false)
    expect(existsSync(join(root, ".meshtalk-install-lock.sqlite"))).toBe(true)
  })

  test("uninstall refuses a still-running backend before removing anything", async () => {
    const current = install()
    const launcher = prepareInstalledLauncher(payloadPath(current))!
    const child = spawn("setInterval(() => {}, 1000)")
    retainChildRelease(launcher, child.pid, "backend")
    releaseUsage(launcher)
    expect(() => uninstallReleaseInstallation(root)).toThrow(/Close all MeshTalk/)
    assertPair(current, "1.0.0")
    expect(selection().current).toBe(current)
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("read-only flat installations remain runnable without migration", () => {
    for (const file of releaseFiles) writeFileSync(join(root, file), `legacy ${file}`)
    chmodSync(root, 0o555)
    try {
      const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
      expect(launcher.executable).toBe(join(root, releaseFiles[0]))
      expect(launcher.usage).toBe("")
      expect(readdirSync(root).sort()).toEqual([...releaseFiles].sort())
    } finally { chmodSync(root, 0o755) }
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("read-only managed installations still select their verified release", () => {
    const current = install()
    chmodSync(root, 0o555)
    try {
      const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
      expect(launcher.executable).toBe(payloadPath(current))
      expect(launcher.usage).toBe("")
    } finally { chmodSync(root, 0o755) }
  })

  test("installs a flat archive with a stable command path and a verified version pair", () => {
    const id = install()
    expect(selection()).toMatchObject({ schema: 1, current: id })
    expect(selection().pending).toBeUndefined()
    expect(id).toMatch(/^release-[a-f0-9]{32}$/)
    expect(readFileSync(join(root, releaseFiles[0]), "utf8")).toBe(`${releaseFiles[0]} payload 1.0.0\n`)
    expect(existsSync(join(root, releaseFiles[1]))).toBe(false)
    expect(lstatSync(join(root, releaseFiles[0])).isSymbolicLink()).toBe(process.platform !== "win32")
    assertPair(id, "1.0.0")
    expect(activateRelease(root)).toBe(payloadPath(id))
  })

  test("a later install updates all launcher code at the existing command path", () => {
    install()
    const bootstrap = readFileSync(join(root, releaseFiles[0]))
    const next = install("2.0.0")
    expect(readFileSync(join(root, releaseFiles[0]))).not.toEqual(bootstrap)
    expect(readFileSync(join(root, releaseFiles[0]))).toEqual(readFileSync(payloadPath(next)))
    expect(selection()).toMatchObject({ schema: 1, current: next })
    expect(selection().pending).toBeUndefined()
    assertPair(next, "2.0.0")
  })

  test("first launch migrates a compiled flat pair without overwriting either root binary", () => {
    const flatSource = source("1.0.0")
    for (const file of releaseFiles) copyFileSync(join(flatSource, file), join(root, file))
    const before = releaseFiles.map((file) => readFileSync(join(root, file)))
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]), false, "1.0.0")!
    try {
      const current = selection().current!
      expect(launcher.executable).toBe(payloadPath(current))
      expect(releaseFiles.map((file) => readFileSync(join(root, file)))).toEqual(before)
      expect(selection().pending).toBeUndefined()
      expect(selection().confirmed).toBeUndefined()
      expect(selection().bootstrap).toBe(new Bun.CryptoHasher("sha256").update(before[0]).digest("hex"))
      assertPair(current, "1.0.0")
      // A later flat updater cannot mutate the already selected copy.
      writeFileSync(join(root, releaseFiles[1]), "another flat backend")
      assertPair(current, "1.0.0")
    } finally {
      releaseUsage(launcher)
    }
  })

  test("old current-manifest migration verifies and pins a separate pair", () => {
    const legacy = legacyVersion()
    const bootstrap = readFileSync(join(root, releaseFiles[0]))
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    try {
      const current = selection().current!
      expect(current).toMatch(/^release-[a-f0-9]{32}$/)
      expect(launcher.executable).toBe(payloadPath(current))
      expect(dirname(launcher.executable)).not.toBe(legacy)
      expect(readFileSync(join(root, releaseFiles[0]))).toEqual(bootstrap)
      assertPair(current, "1.0.0")
      writeFileSync(join(legacy, releaseFiles[1]), "changed legacy backend")
      assertPair(current, "1.0.0")
      const next = stage()
      activateRelease(root)
      const pinned = prepareInstalledLauncher(launcher.executable)!
      try {
        expect(pinned.executable).toBe(payloadPath(current))
        expect(selection().current).toBe(next)
        assertPair(current, "1.0.0")
      } finally {
        releaseUsage(pinned)
      }
    } finally {
      releaseUsage(launcher)
    }
  })

  for (const file of releaseFiles) {
    for (const damage of ["missing", "corrupt"] as const) {
      test(`old current-manifest migration rejects ${damage} ${file}`, () => {
        const legacy = legacyVersion()
        const bootstrap = readFileSync(join(root, releaseFiles[0]))
        if (damage === "missing") rmSync(join(legacy, file))
        else writeFileSync(join(legacy, file), "hash mismatch")
        expect(() => prepareInstalledLauncher(join(root, releaseFiles[0]))).toThrow(/previous MeshTalk release is incomplete/)
        expect(existsSync(join(root, stateFile))).toBe(false)
        expect(readFileSync(join(root, releaseFiles[0]))).toEqual(bootstrap)
        expect(readdirSync(join(root, "versions"))).toEqual(["1.0.0-abcdef123456"])
      })
    }
  }

  test("same-version reinstall repairs a damaged pair alongside its live old bytes", () => {
    const previous = install()
    const active = prepareInstalledLauncher(payloadPath(previous))!
    try {
      const bootstrap = readFileSync(join(root, releaseFiles[0]))
      const oldLauncher = readFileSync(payloadPath(previous))
      writeFileSync(payloadPath(previous, releaseFiles[1]), "damaged active backend")
      installFromDirectory(join(directory, "source-1.0.0"), root, "1.0.0")
      const repaired = selection().current!
      expect(repaired).not.toBe(previous)
      expect(selection().pending).toBeUndefined()
      assertPair(repaired, "1.0.0")
      expect(readFileSync(join(root, releaseFiles[0]))).toEqual(bootstrap)
      expect(readFileSync(payloadPath(previous))).toEqual(oldLauncher)
      expect(readFileSync(payloadPath(previous, releaseFiles[1]), "utf8")).toBe("damaged active backend")
      const acknowledged = prepareInstalledLauncher(payloadPath(repaired))!
      releaseUsage(acknowledged)
      cleanupReleases(root)
      expect(readFileSync(payloadPath(previous, releaseFiles[1]), "utf8")).toBe("damaged active backend")
    } finally {
      releaseUsage(active)
    }
  })

  test("the installer repairs a corrupt launcher at the existing command path", () => {
    install()
    writeFileSync(join(root, releaseFiles[0]), "corrupt bootstrap")
    const next = install("2.0.0")
    const bootstrap = readFileSync(join(root, releaseFiles[0]))
    expect(bootstrap.toString()).toBe(`${releaseFiles[0]} payload 2.0.0\n`)
    if (process.platform === "win32") expect(selection().bootstrap).toBe(new Bun.CryptoHasher("sha256").update(bootstrap).digest("hex"))
    else expect(lstatSync(join(root, releaseFiles[0])).isSymbolicLink()).toBe(true)
    expect(selection().pending).toBeUndefined()
    assertPair(next, "2.0.0")
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    try {
      expect(launcher.executable).toBe(payloadPath(next))
    } finally {
      releaseUsage(launcher)
    }
  })

  test("staging leaves the current selection and both legacy root binaries untouched", () => {
    for (const file of releaseFiles) writeFileSync(join(root, file), `legacy ${file}`)
    const current = install()
    const rootPair = releaseFiles.map((file) => readFileSync(join(root, file)))
    const pending = stage()
    expect(selection()).toMatchObject({ schema: 1, current, pending })
    expect(releaseFiles.map((file) => readFileSync(join(root, file)))).toEqual(rootPair)
    assertPair(current, "1.0.0")
    assertPair(pending, "2.0.0")
  })

  test("can stage the first release without selecting it", () => {
    writeFileSync(join(root, releaseFiles[0]), "bootstrap")
    const pending = stage("1.0.0")
    expect(selection()).toMatchObject({ schema: 1, pending })
    expect(selection().current).toBeUndefined()
    expect(readFileSync(join(root, releaseFiles[0]), "utf8")).toBe("bootstrap")
    expect(activateRelease(root)).toBe(payloadPath(pending))
    expect(selection().current).toBe(pending)
    expect(selection().pending).toBeUndefined()
    assertPair(pending, "1.0.0")
  })

  test("activation selects the complete verified pair and clears pending", () => {
    const previous = install()
    const next = stage()
    expect(activateRelease(root)).toBe(payloadPath(next))
    expect(selection()).toMatchObject({ schema: 1, current: next })
    expect(selection().pending).toBeUndefined()
    assertPair(next, "2.0.0")
    expect(existsSync(dirname(payloadPath(previous)))).toBe(true)
  })

  for (const file of releaseFiles) {
    for (const damage of ["missing", "corrupt"] as const) {
      test(`${damage} pending ${file} preserves the old selection`, () => {
        const current = install()
        const pending = stage()
        const before = readFileSync(join(root, stateFile))
        if (damage === "missing") rmSync(payloadPath(pending, file))
        else writeFileSync(payloadPath(pending, file), "damaged")
        expect(() => activateRelease(root)).toThrow(/incomplete or damaged/)
        expect(readFileSync(join(root, stateFile))).toEqual(before)
        expect(selection().current).toBe(current)
        assertPair(current, "1.0.0")
      })

      test(`${damage} pending ${file} warns but does not block ordinary startup`, () => {
        const current = install()
        const acknowledged = prepareInstalledLauncher(payloadPath(current))!
        releaseUsage(acknowledged)
        const pending = stage()
        if (damage === "missing") rmSync(payloadPath(pending, file))
        else writeFileSync(payloadPath(pending, file), "damaged")
        const before = readFileSync(join(root, stateFile))
        const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]), true)!
        try {
          expect(launcher.executable).toBe(payloadPath(current))
          expect(launcher.warning).toMatch(/update.*damaged/i)
          expect(launcher.warning).toMatch(/download.*again/i)
          expect(selection()).toMatchObject({ schema: 1, current, pending })
          expect(readFileSync(join(root, stateFile))).toEqual(before)
          assertPair(current, "1.0.0")
        } finally {
          releaseUsage(launcher)
        }
      })
    }
  }

  test("an incomplete source leaves the current pair and selection unchanged", () => {
    const current = install()
    const incomplete = source("2.0.0")
    rmSync(join(incomplete, releaseFiles[1]))
    const before = readFileSync(join(root, stateFile))
    expect(() => installFromDirectory(incomplete, root, "2.0.0")).toThrow(/missing/)
    expect(readFileSync(join(root, stateFile))).toEqual(before)
    expect(readdirSync(join(root, "versions"))).toEqual([current])
    assertPair(current, "1.0.0")
  })

  test("a running payload stays pinned to its own release after another activation", () => {
    const previous = install()
    const original = prepareInstalledLauncher(payloadPath(previous))!
    const next = stage()
    activateRelease(root)
    const pinned = prepareInstalledLauncher(original.executable)!
    const bootstrap = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    try {
      expect(pinned.executable).toBe(payloadPath(previous))
      expect(bootstrap.executable).toBe(payloadPath(next))
      expect(selection().current).toBe(next)
    } finally {
      releaseUsage(original)
      releaseUsage(pinned)
      releaseUsage(bootstrap)
    }
  })

  test("update restart activates and leases the new pair", () => {
    install()
    const next = stage()
    const launcher = prepareUpdateRestart(root)
    try {
      expect(launcher.executable).toBe(payloadPath(next))
      expect(selection()).toMatchObject({ schema: 1, current: next })
      expect(selection().pending).toBeUndefined()
      expect(JSON.parse(readFileSync(launcher.usage, "utf8"))).toEqual({ pid: process.pid, release: next, kind: "launcher" })
    } finally {
      releaseUsage(launcher)
    }
  })

  for (const kind of ["launcher", "backend"] as const) {
    test(`a live ${kind} child retains the old pair until exit and acknowledgement`, async () => {
      const previous = install()
      const launcher = prepareInstalledLauncher(payloadPath(previous))!
      const child = spawn("setInterval(() => {}, 1000)")
      retainChildRelease(launcher, child.pid, kind)
      releaseUsage(launcher)
      const next = stage()
      activateRelease(root)
      cleanupReleases(root)
      expect(existsSync(dirname(payloadPath(previous)))).toBe(true)
      const acknowledged = prepareInstalledLauncher(payloadPath(next))!
      releaseUsage(acknowledged)
      cleanupReleases(root)
      expect(existsSync(dirname(payloadPath(previous)))).toBe(true)
      child.kill()
      await child.exited
      cleanupReleases(root)
      expect(existsSync(dirname(payloadPath(previous)))).toBe(false)
      assertPair(next, "2.0.0")
      expect(readdirSync(join(root, ".meshtalk-usage"))).toEqual([])
    })
  }

  test("an exited child alone does not discard the previous recovery pair", async () => {
    const previous = install()
    const launcher = prepareInstalledLauncher(payloadPath(previous))!
    const child = spawn("setInterval(() => {}, 1000)")
    retainChildRelease(launcher, child.pid, "backend")
    releaseUsage(launcher)
    const next = stage()
    activateRelease(root)
    child.kill()
    await child.exited
    cleanupReleases(root)
    expect(existsSync(dirname(payloadPath(previous)))).toBe(true)
    const acknowledged = prepareInstalledLauncher(payloadPath(next))!
    releaseUsage(acknowledged)
    cleanupReleases(root)
    expect(existsSync(dirname(payloadPath(previous)))).toBe(false)
  })

  test("exit cleanup leaves its own physical executable and manifest for a later process", () => {
    const previous = install()
    const next = stage()
    activateRelease(root)
    const executable = process.execPath
    try {
      process.execPath = payloadPath(previous)
      const acknowledged = prepareInstalledLauncher(payloadPath(next))!
      releaseUsage(acknowledged)
      cleanupReleases(root)
      expect(existsSync(payloadPath(previous))).toBe(true)
      expect(existsSync(join(dirname(payloadPath(previous)), ".meshtalk-release.json"))).toBe(true)
    } finally { process.execPath = executable }
    cleanupReleases(root)
    expect(existsSync(dirname(payloadPath(previous)))).toBe(false)
  })

  test("cleanup preserves unknown directories and release-shaped directory symlinks", () => {
    const previous = install()
    const unknown = join(root, "versions", "user-files")
    const unowned = join(root, "versions", `release-${"a".repeat(32)}`)
    const linked = join(root, "versions", `release-${"b".repeat(32)}`)
    mkdirSync(unknown)
    mkdirSync(unowned)
    writeFileSync(join(unknown, "keep"), "unknown")
    writeFileSync(join(unowned, "keep"), "unowned")
    symlinkSync(dirname(payloadPath(previous)), linked, process.platform === "win32" ? "junction" : "dir")
    const next = stage()
    activateRelease(root)
    const acknowledged = prepareInstalledLauncher(payloadPath(next))!
    releaseUsage(acknowledged)
    cleanupReleases(root)
    expect(readFileSync(join(unknown, "keep"), "utf8")).toBe("unknown")
    expect(readFileSync(join(unowned, "keep"), "utf8")).toBe("unowned")
    // The target can be pruned, but the unowned link itself must remain.
    expect(readdirSync(join(root, "versions"))).toContain(`release-${"b".repeat(32)}`)
    expect(existsSync(dirname(payloadPath(previous)))).toBe(false)
  })

  test("a damaged selector recovers the last valid backup", () => {
    const previous = install()
    stage()
    activateRelease(root)
    const backup = JSON.parse(readFileSync(join(root, `${stateFile}.bak`), "utf8"))
    expect(backup.current).toBe(previous)
    writeFileSync(join(root, stateFile), "{broken")
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    try {
      expect(launcher.executable).toBe(payloadPath(previous))
      assertPair(previous, "1.0.0")
    } finally {
      releaseUsage(launcher)
    }
  })

  test("explicit reinstall repairs a corrupt selector without a usable backup", () => {
    const previous = install()
    writeFileSync(join(root, stateFile), "{broken main")
    writeFileSync(join(root, `${stateFile}.bak`), "{broken backup")
    expect(() => prepareInstalledLauncher(join(root, releaseFiles[0]))).toThrow(/selection is damaged/)
    const next = install("2.0.0")
    expect(next).not.toBe(previous)
    expect(selection()).toMatchObject({ schema: 1, current: next })
    expect(selection().pending).toBeUndefined()
    assertPair(next, "2.0.0")
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    try {
      expect(launcher.executable).toBe(payloadPath(next))
    } finally {
      releaseUsage(launcher)
    }
  })

  test("cleanup removes abandoned staging but preserves unknown directories and staging links", () => {
    const current = install()
    const versions = join(root, "versions")
    const abandoned = join(versions, ".staging-Ab12Cd")
    const unknown = join(versions, ".staging-user-files")
    const unmarked = join(versions, ".staging-Unmarked")
    const linked = join(versions, ".staging-Linked")
    const outside = source("outside")
    mkdirSync(abandoned)
    writeFileSync(join(abandoned, ".meshtalk-staging.json"), JSON.stringify({ schema: 1 }))
    writeFileSync(join(abandoned, releaseFiles[0]), "partial copy")
    mkdirSync(unknown)
    writeFileSync(join(unknown, "keep"), "unknown")
    mkdirSync(unmarked)
    writeFileSync(join(unmarked, "keep"), "unmarked")
    writeFileSync(join(outside, ".meshtalk-staging.json"), JSON.stringify({ schema: 1 }))
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir")
    cleanupReleases(root)
    expect(existsSync(abandoned)).toBe(false)
    expect(readFileSync(join(unknown, "keep"), "utf8")).toBe("unknown")
    expect(readFileSync(join(unmarked, "keep"), "utf8")).toBe("unmarked")
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    for (const file of releaseFiles) {
      expect(readFileSync(join(outside, file), "utf8")).toBe(`${file} payload outside\n`)
    }
    assertPair(current, "1.0.0")
  })

  test("a damaged selected payload falls back to the verified backup pair", () => {
    const previous = install()
    const next = stage()
    activateRelease(root)
    writeFileSync(payloadPath(next, releaseFiles[1]), "damaged")
    const launcher = prepareInstalledLauncher(join(root, releaseFiles[0]))!
    try {
      expect(launcher.executable).toBe(payloadPath(previous))
      expect(selection().current).toBe(previous)
      assertPair(previous, "1.0.0")
    } finally {
      releaseUsage(launcher)
    }
  })

  test("a subprocess installer waits for the installation lock before publishing", async () => {
    const previous = install()
    const nextSource = source("2.0.0")
    const unlock = join(directory, "unlock")
    const holder = spawn(`
      import { withInstallLock } from ${JSON.stringify(modulePath)}
      import { existsSync } from "node:fs"
      withInstallLock(${JSON.stringify(root)}, () => {
        console.log("locked")
        const deadline = Date.now() + 4000
        while (!existsSync(${JSON.stringify(unlock)})) {
          if (Date.now() > deadline) throw new Error("unlock timed out")
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }
      })
    `)
    const holderOutput = holder.stdout.getReader()
    expect(new TextDecoder().decode((await holderOutput.read()).value)).toContain("locked")
    const installer = spawn(`
      import { installFromDirectory } from ${JSON.stringify(modulePath)}
      console.log("installing")
      installFromDirectory(${JSON.stringify(nextSource)}, ${JSON.stringify(root)}, "2.0.0")
    `)
    const installerOutput = installer.stdout.getReader()
    expect(new TextDecoder().decode((await installerOutput.read()).value)).toContain("installing")
    await Bun.sleep(75)
    expect(installer.exitCode).toBeNull()
    expect(selection()).toMatchObject({ schema: 1, current: previous })
    expect(selection().pending).toBeUndefined()
    expect(readdirSync(join(root, "versions"))).toEqual([previous])
    writeFileSync(unlock, "release")
    expect(await holder.exited).toBe(0)
    expect(await installer.exited).toBe(0)
    holderOutput.releaseLock()
    installerOutput.releaseLock()
    expect(selection().current).not.toBe(previous)
    assertPair(selection().current!, "2.0.0")
  })
})
