import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, dirname, join } from "path"

const REPOSITORY = "QinCai-rui/MeshTalk"
const API_URL = `https://api.github.com/repos/${REPOSITORY}`
const DATA_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".meshtalk")
const SETTINGS_PATH = join(DATA_DIR, "settings.json")
const RESTART_PATH = join(DATA_DIR, "update-restart-path")
export const UPDATE_RESTART_EXIT_CODE = 75

export type Release = {
  tag: string
  version: string
  assetName: string
  downloadUrl: string
  digest?: string
}

export type UpdateProgress = {
  step: string
  method?: string
  receivedBytes?: number
  totalBytes?: number
}

export class GitHubAuthenticationError extends Error {
  constructor() {
    super("GitHub denied access to this release. Add a GitHub token to continue.")
  }
}

type ReleaseResponse = {
  tag_name?: unknown
  prerelease?: unknown
  draft?: unknown
  assets?: { name?: unknown; browser_download_url?: unknown; digest?: unknown }[]
}

function platformAssetName(): string | null {
  const platform = process.platform === "darwin" ? "macos" : process.platform
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null
  if (!arch || !["linux", "macos", "win32"].includes(platform)) return null
  const releasePlatform = platform === "win32" ? "windows" : platform
  const assetArch = platform === "win32" && arch === "arm64" ? "x64" : arch
  const suffix = platform === "win32" ? ".exe" : ""
  return `meshtalk-${releasePlatform}-${assetArch}${suffix}.tar.gz`
}

type Version = { parts: number[]; revision: number }

function parseVersion(value: string): Version | null {
  const match = value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/)
  return match ? { parts: match.slice(1, 4).map(Number), revision: Number(match[4] ?? 0) } : null
}

export function isNewerVersion(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  const installed = parseVersion(current)
  if (!next || !installed) return false
  for (let index = 0; index < next.parts.length; index++) {
    if (next.parts[index] !== installed.parts[index]) return next.parts[index] > installed.parts[index]
  }
  return next.revision > installed.revision
}

function githubToken(): string | undefined {
  try {
    const token = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")).github_token
    return typeof token === "string" && token.trim() ? token.trim() : undefined
  } catch {
    return undefined
  }
}

export function saveGithubToken(token: string | null): void {
  mkdirSync(DATA_DIR, { recursive: true })
  let settings: Record<string, unknown> = { version: 1 }
  try { settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) } catch {}
  if (token) settings.github_token = token
  else delete settings.github_token
  const temporary = `${SETTINGS_PATH}.tmp`
  writeFileSync(temporary, JSON.stringify(settings, null, 2))
  chmodSync(temporary, 0o600)
  renameSync(temporary, SETTINGS_PATH)
}

async function fetchRelease(token?: string): Promise<{ release: ReleaseResponse | null; accessDenied: boolean }> {
  try {
    const response = await fetch(`${API_URL}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return { release: null, accessDenied: [401, 403, 404].includes(response.status) }
    return { release: await response.json() as ReleaseResponse, accessDenied: false }
  } catch {
    return { release: null, accessDenied: false }
  }
}

function ghRelease(): ReleaseResponse | null {
  try {
    const result = Bun.spawnSync(["gh", "api", `repos/${REPOSITORY}/releases/latest`])
    if (result.exitCode !== 0) return null
    return JSON.parse(new TextDecoder().decode(result.stdout)) as ReleaseResponse
  } catch {
    return null
  }
}

function asRelease(value: ReleaseResponse | null): Release | null {
  const assetName = platformAssetName()
  if (!value || value.prerelease || value.draft || typeof value.tag_name !== "string" || !assetName) return null
  const version = value.tag_name.replace(/^v/, "")
  if (!parseVersion(version)) return null
  const asset = value.assets?.find((candidate) => candidate.name === assetName)
  if (!asset || typeof asset.browser_download_url !== "string") return null
  return {
    tag: value.tag_name,
    version,
    assetName,
    downloadUrl: asset.browser_download_url,
    digest: typeof asset.digest === "string" ? asset.digest : undefined,
  }
}

export async function checkForUpdate(currentVersion: string): Promise<Release | null> {
  const publicRelease = await fetchRelease()
  let release = asRelease(publicRelease.release)
  if (!release) release = asRelease(ghRelease())
  const token = githubToken()
  const authenticatedRelease = release || !token ? null : await fetchRelease(token)
  if (!release && authenticatedRelease) release = asRelease(authenticatedRelease.release)
  if (!release && (publicRelease.accessDenied || authenticatedRelease?.accessDenied)) throw new GitHubAuthenticationError()
  return release && isNewerVersion(release.version, currentVersion) ? release : null
}

function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex")
}

function expectedFiles(): string[] {
  const suffix = process.platform === "win32" ? ".exe" : ""
  return ["meshtalk", "meshtalk-backend", "meshtalk-cli", "meshtalk-tui"].map((name) => `${name}${suffix}`)
}

function scheduleWindowsReplacement(extracted: string, installDir: string): void {
  const staging = mkdtempSync(join(tmpdir(), "meshtalk-update-ready-"))
  for (const name of expectedFiles()) copyFileSync(join(extracted, name), join(staging, name))
  const lines = ["@echo off", "setlocal", "set /a attempts=0", ":retry", "timeout /t 1 /nobreak >nul"]
  for (const name of expectedFiles()) lines.push(`copy /y "${join(staging, name)}" "${join(installDir, name)}" >nul || goto failed`)
  lines.push(`rmdir /s /q "${staging}"`, `if not exist "${RESTART_PATH}" exit /b 0`, `set /p restartPath=<"${RESTART_PATH}"`, `del "${RESTART_PATH}"`, "start \"\" /b \"%restartPath%\"", "exit /b 0", ":failed", "set /a attempts+=1", "if %attempts% LSS 60 goto retry", "echo MeshTalk update could not replace running files.", "exit /b 1")
  const script = join(staging, "replace.cmd")
  writeFileSync(script, lines.join("\r\n"))
  Bun.spawn(["cmd.exe", "/d", "/c", "start", "", "/b", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
}

export async function installRelease(release: Release, installDir: string, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "meshtalk-update-"))
  let staging: string | undefined
  try {
    const token = githubToken()
    const method = token ? "GitHub release via Bun fetch with saved token" : "GitHub release via Bun fetch"
    onProgress?.({ step: "Downloading release", method, receivedBytes: 0 })
    const response = await fetch(release.downloadUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) throw new GitHubAuthenticationError()
      throw new Error(`Download failed (${response.status})`)
    }
    const totalBytes = Number(response.headers.get("content-length")) || undefined
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Download response did not include a body")
    const chunks: Uint8Array[] = []
    let receivedBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      receivedBytes += value.length
      onProgress?.({ step: "Downloading release", method, receivedBytes, totalBytes })
    }
    const archive = new Uint8Array(receivedBytes)
    let offset = 0
    for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.length }
    onProgress?.({ step: "Verifying SHA-256 digest", method })
    const expectedDigest = release.digest?.replace(/^sha256:/, "").toLowerCase()
    if (!expectedDigest) throw new Error("GitHub did not provide a SHA-256 digest for this release")
    if (sha256(archive) !== expectedDigest) throw new Error("SHA-256 verification failed")
    const archivePath = join(temporary, release.assetName)
    writeFileSync(archivePath, archive)
    onProgress?.({ step: "Inspecting release archive", method })
    const listing = Bun.spawnSync(["tar", "-tzf", archivePath])
    if (listing.exitCode !== 0) throw new Error("Unable to inspect the release archive")
    const entries = new TextDecoder().decode(listing.stdout).split("\n").filter(Boolean)
    if (entries.some((entry) => entry.startsWith("/") || entry === ".." || entry.includes("../"))) throw new Error("Release archive contains an unsafe path")
    const extracted = join(temporary, "extracted")
    mkdirSync(extracted)
    onProgress?.({ step: "Extracting release archive", method })
    const extract = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", extracted])
    if (extract.exitCode !== 0) throw new Error("Unable to extract the release archive")
    for (const name of expectedFiles()) {
      const source = join(extracted, name)
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Release archive is missing ${name}`)
    }
    if (process.platform === "win32") {
      onProgress?.({ step: "Staging files for replacement after restart", method })
      scheduleWindowsReplacement(extracted, installDir)
      return
    }
    // A running Unix executable cannot be copied over, but its pathname can be
    // atomically replaced. Stage on the installation filesystem so rename does
    // not fail when the system temporary directory is on another filesystem.
    onProgress?.({ step: "Replacing installed binaries", method })
    staging = mkdtempSync(join(installDir, ".meshtalk-update-"))
    for (const name of expectedFiles()) {
      const staged = join(staging, name)
      copyFileSync(join(extracted, name), staged)
      chmodSync(staged, 0o755)
    }
    for (const name of expectedFiles()) {
      renameSync(join(staging, name), join(installDir, name))
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function requestUpdateRestart(installDir: string): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const temporary = `${RESTART_PATH}.tmp`
  writeFileSync(temporary, join(installDir, `meshtalk${process.platform === "win32" ? ".exe" : ""}`))
  chmodSync(temporary, 0o600)
  renameSync(temporary, RESTART_PATH)
}

export function takeUpdateRestartPath(): string | null {
  try {
    const path = readFileSync(RESTART_PATH, "utf-8").trim()
    rmSync(RESTART_PATH, { force: true })
    return path || null
  } catch {
    return null
  }
}

export function releaseInstallDir(): string | null {
  const executable = process.execPath
  const directory = dirname(executable)
  return basename(executable).startsWith("meshtalk") && isReleaseInstallDir(directory) ? directory : null
}

export function isReleaseInstallDir(directory: string): boolean {
  try {
    return statSync(directory).isDirectory() && expectedFiles().every((name) => {
      const path = join(directory, name)
      return existsSync(path) && statSync(path).isFile()
    })
  } catch {
    return false
  }
}
