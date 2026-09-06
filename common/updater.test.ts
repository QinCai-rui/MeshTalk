import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { activeVersionLauncher, activatePendingVersion, buildWindowsReplacementScript, hasPendingVersion, installRelease, isNewerVersion, isStagingWithinInstallDir, parsePendingUpdate, type UpdateProgress } from "./updater"

describe("isNewerVersion", () => {
  test("orders numeric release revisions after the base release", () => {
    expect(isNewerVersion("0.7.1-1", "0.7.1")).toBe(true)
    expect(isNewerVersion("0.7.1-2", "0.7.1-1")).toBe(true)
    expect(isNewerVersion("0.7.1", "0.7.1-1")).toBe(false)
  })

  test("orders normal semver parts before release revisions", () => {
    expect(isNewerVersion("0.7.2", "0.7.1-99")).toBe(true)
    expect(isNewerVersion("1.0.0", "0.99.99-99")).toBe(true)
  })

  test("rejects malformed versions", () => {
    expect(isNewerVersion("0.7.1-preview", "0.7.1")).toBe(false)
    expect(isNewerVersion("0.7.1", "0.7")).toBe(false)
  })
})

describe("parsePendingUpdate", () => {
  test("accepts a well-formed pending update", () => {
    expect(parsePendingUpdate({ staging: "s", installDir: "i", files: ["meshtalk.exe"] })).toEqual({ staging: "s", installDir: "i", files: ["meshtalk.exe"] })
  })

  test("rejects malformed or unsafe payloads", () => {
    expect(parsePendingUpdate(null)).toBeNull()
    expect(parsePendingUpdate({ staging: "s", installDir: "i", files: [] })).toBeNull()
    expect(parsePendingUpdate({ staging: "s", installDir: "i", files: ["../evil.exe"] })).toBeNull()
    expect(parsePendingUpdate({ staging: "s", installDir: "i", files: ["sub\\evil.exe"] })).toBeNull()
    expect(parsePendingUpdate({ staging: "s", installDir: "i", files: ["evil:stream"] })).toBeNull()
    expect(parsePendingUpdate({ staging: "s", installDir: "i", files: ["C:evil.exe"] })).toBeNull()
    expect(parsePendingUpdate({ staging: "", installDir: "i", files: ["a.exe"] })).toBeNull()
  })

  test("requires staged replacements to live inside the install dir", () => {
    expect(isStagingWithinInstallDir("/opt/meshtalk", "/opt/meshtalk/.meshtalk-update-abc")).toBe(true)
    expect(isStagingWithinInstallDir("/opt/meshtalk", "/opt/meshtalk")).toBe(false)
    expect(isStagingWithinInstallDir("/opt/meshtalk", "/tmp/evil")).toBe(false)
    expect(isStagingWithinInstallDir("/opt/meshtalk", "/opt/meshtalk-other/dir")).toBe(false)
  })
})

describe("buildWindowsReplacementScript", () => {
  const pending = { staging: "C:\\install\\.meshtalk-update-abc", installDir: "C:\\install", files: ["meshtalk.exe", "meshtalk-backend.exe"] }

  test("retries each file copy until locks clear, without PID polling", () => {
    const script = buildWindowsReplacementScript(pending, "C:\\install\\meshtalk.exe", "C:\\data\\update-helper.log")
    // Lock-retry per file: copy fails with a sharing violation while the old
    // instance still holds its executable, and succeeds once it exits.
    expect(script).toContain("copy_attempts_0")
    expect(script).toContain("copy_attempts_1")
    expect(script).toContain('copy /y "C:\\install\\.meshtalk-update-abc\\meshtalk.exe" "C:\\install\\meshtalk.exe"')
    expect(script.indexOf("meshtalk-backend.exe")).toBeLessThan(script.indexOf("meshtalk.exe"))
    // PID polling cannot work in the detached helper: pipes hang and tasklist
    // output capture yields empty files, so neither may be used. The legacy
    // `find /i "%PID%"` must never come back either (Unix find on MSYS
    // machines misparses it and flashes a console window).
    expect(script).not.toContain("tasklist")
    expect(script).not.toContain("findstr")
    expect(script).not.toContain("|")
    expect(script).not.toContain("WAIT_PID")
    expect(script).not.toMatch(/(^|[^a-zA-Z])find(\.exe)?(\s|\/)/i)
    // No delayed expansion: `!` in install paths would be eaten.
    expect(script).not.toContain("EnableDelayedExpansion")
    expect(script).not.toMatch(/setlocal.*!/i)
  })

  test("cleans up the staging dir plus pending marker and relaunches", () => {
    const script = buildWindowsReplacementScript(pending, "C:\\install\\meshtalk.exe", "C:\\data\\update-helper.log")
    expect(script).toContain('rmdir /s /q "C:\\install\\.meshtalk-update-abc"')
    expect(script).toContain('start "" /d "C:\\install" "C:\\install\\meshtalk.exe"')
    // Relaunch is retried (transient AV locks) and its outcome is logged.
    expect(script).toContain(":start_retry")
    expect(script).toContain(":start_failed")
    // A missing launcher must fail fast: `start` on a nonexistent target can
    // hang forever in a windowless session instead of returning an error.
    expect(script).toContain("if not exist")
    expect(script).toContain(":start_missing")
    // Self-deletes without leaving the script file behind.
    expect(script).toContain('del "%~f0"')
  })

  test("logs each phase for post-mortem debugging", () => {
    const script = buildWindowsReplacementScript(pending, "C:\\install\\meshtalk.exe", "C:\\data\\update-helper.log")
    expect(script).toContain("helper started")
    expect(script).toContain("replaced meshtalk.exe")
    expect(script).toContain("could not replace meshtalk.exe")
    expect(script).toContain("relaunched")
    expect(script).toContain("C:\\data\\update-helper.log")
  })
})

test("activeVersionLauncher falls back when the selected version is incomplete", () => {
  const temporary = mkdtempSync(join(tmpdir(), "meshtalk-version-fallback-"))
  const suffix = process.platform === "win32" ? ".exe" : ""
  const launcher = `meshtalk${suffix}`
  const backend = `meshtalk-backend${suffix}`
  const previous = "1.0.0-aaaaaaaaaaaa"
  try {
    mkdirSync(join(temporary, "versions", previous), { recursive: true })
    writeFileSync(join(temporary, "versions", previous, launcher), "launcher")
    writeFileSync(join(temporary, "versions", previous, backend), "backend")
    writeFileSync(join(temporary, ".meshtalk-current.json"), JSON.stringify({
      schema: 1,
      current: "1.1.0-bbbbbbbbbbbb",
      previous,
      targetVersion: "1.1.0",
      files: {
        [launcher]: { sha256: "b".repeat(64) },
        [backend]: { sha256: "b".repeat(64) },
      },
    }))
    expect(activeVersionLauncher(temporary)).toBe(join(realpathSync(join(temporary, "versions", previous)), launcher))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test("installRelease streams the archive and reports each install phase", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "meshtalk-updater-test-"))
  const source = join(temporary, "source")
  const installDir = join(temporary, "install")
  const archivePath = join(temporary, "release.tar.gz")
  const suffix = process.platform === "win32" ? ".exe" : ""
  const files = ["meshtalk", "meshtalk-backend"].map((name) => `${name}${suffix}`)
  mkdirSync(source)
  mkdirSync(installDir)
  for (const name of files) {
    writeFileSync(join(source, name), `new ${name}`)
    writeFileSync(join(installDir, name), `old ${name}`)
  }
  // Run tar with cwd + relative names: MSYS/Git-Bash tar treats `C:\...`
  // absolute paths as remote (`C: resolve failed`).
  const archive = Bun.spawnSync(["tar", "-czf", "release.tar.gz", "-C", "source", ...files], { cwd: temporary })
  expect(archive.exitCode).toBe(0)
  const archiveBytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer())
  const digest = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex")
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(archiveBytes, { headers: { "content-length": String(archiveBytes.length) } }),
  })
  const progress: UpdateProgress[] = []
  try {
    await installRelease({
      tag: "v1.0.0",
      version: "1.0.0",
      assetName: "release.tar.gz",
      downloadUrl: `http://127.0.0.1:${server.port}/release.tar.gz`,
      digest: `sha256:${digest}`,
    }, installDir, (event) => progress.push(event))
    // Installation is immutable and does not touch the running flat release.
    for (const name of files) expect(readFileSync(join(installDir, name), "utf-8")).toBe(`old ${name}`)
    expect(hasPendingVersion(installDir)).toBe(true)
    const launcher = activatePendingVersion(installDir)
    expect(launcher).toBe(activeVersionLauncher(installDir))
    expect(launcher).not.toBeNull()
    for (const name of files) expect(readFileSync(join(launcher!, "..", name), "utf-8")).toBe(`new ${name}`)
    expect(progress.map((event) => event.step)).toContain("Staging verified version for restart")
    expect(progress.some((event) => event.current === 1 && event.total === 6 && event.receivedBytes === archiveBytes.length && event.totalBytes === archiveBytes.length)).toBe(true)
    expect(progress.map((event) => event.step)).toContain("Verifying SHA-256 digest")
    expect(progress.map((event) => event.step)).toContain("Inspecting release archive")
    expect(progress.map((event) => event.step)).toContain("Extracting release archive")
    expect(progress.map((event) => event.step)).toContain("Validating extracted binaries")
  } finally {
    server.stop(true)
    rmSync(temporary, { recursive: true, force: true })
  }
})
