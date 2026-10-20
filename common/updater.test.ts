import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { installRelease, isNewerVersion, isStagingWithinInstallDir, isStableVersion, parsePendingUpdate, readUpdateChannel, saveUpdateChannel, type UpdateProgress } from "./updater"
import { prepareInstalledLauncher, releaseUsage } from "./release-install"

describe("isStableVersion", () => {
  test("recognizes stable and snapshot versions", () => {
    expect(isStableVersion("0.32.2")).toBe(true)
    expect(isStableVersion("0.32.2-1")).toBe(true)
    expect(isStableVersion("0.32.2-SNAPSHOT+307-13466ec")).toBe(false)
  })

  test("rejects invalid versions", () => {
    expect(isStableVersion("dev")).toBe(false)
    expect(isStableVersion("0.32.2-preview")).toBe(false)
  })
})

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

  test("orders snapshot prereleases below the same-base stable", () => {
    expect(isNewerVersion("0.24.13", "0.24.13-SNAPSHOT+250-4b1cbcd")).toBe(true)
    expect(isNewerVersion("0.24.13-SNAPSHOT+250-4b1cbcd", "0.24.13")).toBe(false)
    expect(isNewerVersion("0.24.13-SNAPSHOT", "0.24.13")).toBe(false)
  })

  test("orders snapshots by run number", () => {
    expect(isNewerVersion("0.24.13-SNAPSHOT+251-aaaaaaa", "0.24.13-SNAPSHOT+250-4b1cbcd")).toBe(true)
    expect(isNewerVersion("0.24.13-SNAPSHOT+250-4b1cbcd", "0.24.13-SNAPSHOT+251-aaaaaaa")).toBe(false)
    expect(isNewerVersion("0.24.13-SNAPSHOT+250-4b1cbcd", "0.24.13-SNAPSHOT+250-4b1cbcd")).toBe(false)
  })

  test("orders base versions across stability levels", () => {
    expect(isNewerVersion("0.24.14-SNAPSHOT+1-aaaaaaa", "0.24.13")).toBe(true)
    expect(isNewerVersion("0.24.13", "0.24.14-SNAPSHOT+99-aaaaaaa")).toBe(false)
  })

  test("rejects dev and malformed versions", () => {
    expect(isNewerVersion("0.24.14-SNAPSHOT+1-aaaaaaa", "dev")).toBe(false)
    expect(isNewerVersion("dev", "0.24.13")).toBe(false)
  })
})

describe("updateChannel", () => {
  test("defaults to stable and round-trips unstable", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshtalk-channel-"))
    const settingsPath = join(directory, "settings.json")
    const dataDir = directory
    expect(readUpdateChannel(settingsPath)).toBe("stable")
    saveUpdateChannel("unstable", settingsPath, dataDir)
    expect(readUpdateChannel(settingsPath)).toBe("unstable")
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).update_channel).toBe("unstable")
    saveUpdateChannel("stable", settingsPath, dataDir)
    expect(readUpdateChannel(settingsPath)).toBe("stable")
    rmSync(directory, { recursive: true, force: true })
  })

  test("treats unknown values as stable", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshtalk-channel-"))
    const settingsPath = join(directory, "settings.json")
    writeFileSync(settingsPath, JSON.stringify({ update_channel: "beta" }))
    expect(readUpdateChannel(settingsPath)).toBe("stable")
    rmSync(directory, { recursive: true, force: true })
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

describe("importLegacyWindowsUpdate", () => {
  const suffix = process.platform === "win32" ? ".exe" : ""
  const files = ["meshtalk", "meshtalk-backend"].map((name) => `${name}${suffix}`)

  for (const scenario of ["complete", "ancestor alias", "missing file", "wrong installation", "unexpected marker files", "extra staged file", "staging link", "install link", "file link", "publish failure", "malformed marker"] as const) {
    test(`${scenario}: imports only a complete matching update without changing installed files`, () => {
      const temporary = mkdtempSync(join(tmpdir(), "meshtalk-legacy-update-"))
      const installDir = join(temporary, "install")
      const staging = join(installDir, ".meshtalk-update-test")
      const dataDir = join(temporary, "data")
      const marker = join(dataDir, "pending-update.json")
      try {
        mkdirSync(staging, { recursive: true })
        mkdirSync(dataDir)
        for (const name of files) {
          writeFileSync(join(installDir, name), `old ${name}`)
          writeFileSync(join(staging, name), `new ${name}`)
        }
        let caller = installDir
        let source = staging
        if (scenario === "ancestor alias") {
          const alias = join(temporary, "alias")
          symlinkSync(installDir, alias, process.platform === "win32" ? "junction" : "dir")
          source = join(alias, ".meshtalk-update-test")
        }
        if (scenario === "missing file") rmSync(join(staging, files[1]))
        if (scenario === "wrong installation") {
          caller = join(temporary, "other")
          mkdirSync(caller)
        }
        if (scenario === "extra staged file") writeFileSync(join(staging, "unexpected"), "extra")
        if (scenario === "staging link") {
          source = join(installDir, ".meshtalk-update-link")
          symlinkSync(staging, source, process.platform === "win32" ? "junction" : "dir")
        }
        if (scenario === "install link") {
          caller = join(temporary, "install-link")
          symlinkSync(installDir, caller, process.platform === "win32" ? "junction" : "dir")
        }
        if (scenario === "file link") {
          rmSync(join(staging, files[1]))
          symlinkSync(join(installDir, files[1]), join(staging, files[1]), "file")
        }
        if (scenario === "publish failure") writeFileSync(join(installDir, ".meshtalk-install.json"), "broken")
        const markerContents = scenario === "malformed marker" ? "broken" : JSON.stringify({
          installDir, staging: source,
          files: scenario === "unexpected marker files" ? [files[0], files[0]] : files,
        })
        writeFileSync(marker, markerContents)
        const result = Bun.spawnSync([process.execPath, "--eval", `
          import { importLegacyWindowsUpdate } from ${JSON.stringify(join(import.meta.dir, "updater.ts"))}
          console.log(importLegacyWindowsUpdate(${JSON.stringify(caller)}))
        `], { env: { ...process.env, MESHTALK_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe" })
        expect(result.exitCode).toBe(0)
        const complete = scenario === "complete" || scenario === "ancestor alias"
        expect(new TextDecoder().decode(result.stdout).trim()).toBe(String(complete))
        for (const name of files) expect(readFileSync(join(installDir, name), "utf8")).toBe(`old ${name}`)
        if (complete) {
          const selection = JSON.parse(readFileSync(join(installDir, ".meshtalk-install.json"), "utf8"))
          for (const name of files) expect(readFileSync(join(installDir, "versions", selection.pending, name), "utf8")).toBe(`new ${name}`)
          expect(existsSync(marker)).toBe(false)
          expect(existsSync(staging)).toBe(false)
        } else {
          expect(readFileSync(marker, "utf8")).toBe(markerContents)
          expect(readFileSync(join(staging, files[0]), "utf8")).toBe(`new ${files[0]}`)
          if (scenario === "missing file") expect(existsSync(join(staging, files[1]))).toBe(false)
          if (scenario !== "publish failure") expect(existsSync(join(installDir, ".meshtalk-install.json"))).toBe(false)
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    })
  }
})

test.each([true, false])("installRelease streams the archive and reports each install phase (managed: %s)", async (managed) => {
  const temporary = mkdtempSync(join(tmpdir(), "meshtalk-updater-test-"))
  const source = join(temporary, "source")
  const installDir = join(temporary, "install")
  const archivePath = join(temporary, "release.tar.gz")
  const suffix = process.platform === "win32" ? ".exe" : ""
  const files = ["meshtalk", "meshtalk-backend"].map((name) => `${name}${suffix}`)
  mkdirSync(source)
  mkdirSync(installDir)
  if (process.platform === "win32") writeFileSync(join(installDir, "unrelated-command"), "keep")
  for (const name of files) {
    writeFileSync(join(source, name), `new ${name}`)
    writeFileSync(join(installDir, name), `old ${name}`)
  }
  let current: string | undefined
  if (managed) {
    const launcher = prepareInstalledLauncher(join(installDir, files[0]))!
    releaseUsage(launcher)
    current = JSON.parse(readFileSync(join(installDir, ".meshtalk-install.json"), "utf8")).current
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
    const selection = JSON.parse(readFileSync(join(installDir, ".meshtalk-install.json"), "utf8"))
    if (managed) expect(selection.current).toBe(current)
    else expect(selection.pending).toBeUndefined()
    const selected = managed ? selection.pending : selection.current
    expect(selected).toMatch(/^release-[a-f0-9]{32}$/)
    for (const name of files) {
      expect(readFileSync(join(installDir, name), "utf8")).toBe(`${!managed && name === files[0] ? "new" : "old"} ${name}`)
      expect(readFileSync(join(installDir, "versions", selected, name), "utf8")).toBe(`new ${name}`)
    }
    expect(progress.map((event) => event.step)).toContain("Staging verified release for restart")
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
