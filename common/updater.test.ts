import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { installRelease, isNewerVersion, type UpdateProgress } from "./updater"

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
  const progress: UpdateProgress[] = []
  try {
    await installRelease({
      tag: "v1.0.0",
      version: "1.0.0",
      assetName: "release.tar.gz",
      downloadUrl: `http://127.0.0.1:${server.port}/release.tar.gz`,
      digest: `sha256:${digest}`,
    }, installDir, (event) => progress.push(event))
    for (const name of files) expect(readFileSync(join(installDir, name), "utf-8")).toBe(`new ${name}`)
    expect(progress.some((event) => event.current === 1 && event.total === 6 && event.receivedBytes === archiveBytes.length && event.totalBytes === archiveBytes.length)).toBe(true)
    expect(progress.map((event) => event.step)).toContain("Verifying SHA-256 digest")
    expect(progress.map((event) => event.step)).toContain("Inspecting release archive")
    expect(progress.map((event) => event.step)).toContain("Extracting release archive")
    expect(progress.map((event) => event.step)).toContain("Validating extracted binaries")
    if (process.platform !== "win32") expect(progress.map((event) => event.step)).toContain("Replacing installed binaries")
  } finally {
    server.stop(true)
    rmSync(temporary, { recursive: true, force: true })
  }
})
