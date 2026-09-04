import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildWindowsReplacementScript, installRelease, isNewerVersion, parsePendingUpdate, type UpdateProgress } from "./updater"

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
    expect(parsePendingUpdate({ staging: "", installDir: "i", files: ["a.exe"] })).toBeNull()
  })
})

describe("buildWindowsReplacementScript", () => {
  const pending = { staging: "C:\\install\\.meshtalk-update-abc", installDir: "C:\\install", files: ["meshtalk.exe", "meshtalk-backend.exe"] }

  test("waits for every supplied pid with an exact pid match", () => {
    const script = buildWindowsReplacementScript(pending, [1234, 5678], "C:\\install\\meshtalk.exe", "C:\\data\\update-helper.log")
    expect(script).toContain("WAIT_PID_0=1234")
    expect(script).toContain("WAIT_PID_1=5678")
    // Surrounding spaces keep PID 123 from matching a 1234 row.
    expect(script).toContain('/C:" !WAIT_PID_0! "')
    expect(script).toContain('/C:" !WAIT_PID_1! "')
    expect(script).not.toContain('find /i "%PID%"')
  })

  test("retries each file copy and cleans up the staging dir plus pending marker", () => {
    const script = buildWindowsReplacementScript(pending, [1234], "C:\\install\\meshtalk.exe", "C:\\data\\update-helper.log")
    expect(script).toContain("copy_attempts_0")
    expect(script).toContain("copy_attempts_1")
    expect(script).toContain('rmdir /s /q "C:\\install\\.meshtalk-update-abc"')
    expect(script).toContain('start "" "C:\\install\\meshtalk.exe"')
  })
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
  const archive = Bun.spawnSync(["tar", "-czf", archivePath, "-C", source, ...files])
  expect(archive.exitCode).toBe(0)
  const archiveBytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer())
  const digest = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex")
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(archiveBytes, { headers: { "content-length": String(archiveBytes.length) } }),
  })
  // On Windows installRelease stages into a pending-update marker (in the
  // real data dir) instead of replacing locked binaries. Back it up so the
  // test never destroys or leaves behind real update state.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const dataDir = process.env.MESHTALK_DATA_DIR?.trim() ? process.env.MESHTALK_DATA_DIR.trim() : join(home, ".meshtalk")
  const pendingPath = join(dataDir, "pending-update.json")
  let pendingBackup: Uint8Array | null = null
  try { pendingBackup = new Uint8Array(await Bun.file(pendingPath).arrayBuffer()) } catch {}
  const progress: UpdateProgress[] = []
  try {
    await installRelease({
      tag: "v1.0.0",
      version: "1.0.0",
      assetName: "release.tar.gz",
      downloadUrl: `http://127.0.0.1:${server.port}/release.tar.gz`,
      digest: `sha256:${digest}`,
    }, installDir, (event) => progress.push(event))
    if (process.platform === "win32") {
      // Binaries stay locked: the update is staged for the restart helper.
      for (const name of files) expect(readFileSync(join(installDir, name), "utf-8")).toBe(`old ${name}`)
      const pending = parsePendingUpdate(JSON.parse(readFileSync(pendingPath, "utf-8")))
      expect(pending?.installDir).toBe(installDir)
      for (const name of files) expect(readFileSync(join(pending!.staging, name), "utf-8")).toBe(`new ${name}`)
      expect(progress.map((event) => event.step)).toContain("Staging files for replacement after restart")
    } else {
      for (const name of files) expect(readFileSync(join(installDir, name), "utf-8")).toBe(`new ${name}`)
      expect(progress.map((event) => event.step)).toContain("Replacing installed binaries")
    }
    expect(progress.some((event) => event.current === 1 && event.total === 6 && event.receivedBytes === archiveBytes.length && event.totalBytes === archiveBytes.length)).toBe(true)
    expect(progress.map((event) => event.step)).toContain("Verifying SHA-256 digest")
    expect(progress.map((event) => event.step)).toContain("Inspecting release archive")
    expect(progress.map((event) => event.step)).toContain("Extracting release archive")
    expect(progress.map((event) => event.step)).toContain("Validating extracted binaries")
  } finally {
    server.stop(true)
    if (process.platform === "win32") {
      try {
        const pending = parsePendingUpdate(JSON.parse(readFileSync(pendingPath, "utf-8")))
        if (pending?.installDir === installDir) {
          rmSync(pending.staging, { recursive: true, force: true })
          rmSync(pendingPath, { force: true })
        }
      } catch {}
      if (pendingBackup) writeFileSync(pendingPath, pendingBackup)
    }
    rmSync(temporary, { recursive: true, force: true })
  }
})
