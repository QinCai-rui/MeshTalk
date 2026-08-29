import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { chmod, copyFile, mkdir, open, rename, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { basename, dirname, join } from "path"

const DEFAULT_GITHUB_USER = "QinCai-rui"
const DEFAULT_GITHUB_REPO = "MeshTalk"
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ""
function expandHomePath(value: string): string {
  const trimmed = value.trim()
  return HOME && (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
    ? HOME + trimmed.slice(1)
    : trimmed
}

const DATA_DIR = process.env.MESHTALK_DATA_DIR ? expandHomePath(process.env.MESHTALK_DATA_DIR) : join(HOME, ".meshtalk")
const SETTINGS_PATH = join(DATA_DIR, "settings.json")
const RESTART_PATH = join(DATA_DIR, "update-restart-path")
const PENDING_UPDATE_PATH = join(DATA_DIR, "pending-update.json")
export const UPDATE_RESTART_EXIT_CODE = 75

export type Release = {
  tag: string
  version: string
  assetName: string
  downloadUrl: string
  digest?: string
}

export type UpdateProgress = {
  current: number
  total: number
  step: string
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

type GitHubSettings = { github_token?: unknown; github_user?: unknown; github_repo?: unknown }

function githubSettings(): GitHubSettings {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as GitHubSettings
  } catch {
    return {}
  }
}

function saveGithubSettings(update: (settings: Record<string, unknown>) => void): void {
  mkdirSync(DATA_DIR, { recursive: true })
  let settings: Record<string, unknown> = { version: 1 }
  try { settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) } catch {}
  update(settings)
  const temporary = `${SETTINGS_PATH}.tmp`
  writeFileSync(temporary, JSON.stringify(settings, null, 2))
  chmodSync(temporary, 0o600)
  renameSync(temporary, SETTINGS_PATH)
}

export function githubRepository(): string {
  const settings = githubSettings()
  const user = process.env.MESHTALK_GITHUB_USER?.trim() || (typeof settings.github_user === "string" ? settings.github_user.trim() : "") || DEFAULT_GITHUB_USER
  const repo = process.env.MESHTALK_GITHUB_REPO?.trim() || (typeof settings.github_repo === "string" ? settings.github_repo.trim() : "") || DEFAULT_GITHUB_REPO
  if (!isGitHubName(user) || !isGitHubName(repo)) throw new Error("GitHub user and repository names may contain only letters, numbers, dots, underscores, and hyphens.")
  return `${user}/${repo}`
}

function isGitHubName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
}

function githubToken(): string | undefined {
  const token = githubSettings().github_token
  return typeof token === "string" && token.trim() ? token.trim() : undefined
}

export function saveGithubToken(token: string | null): void {
  saveGithubSettings((settings) => {
    if (token) settings.github_token = token
    else delete settings.github_token
  })
}

export function saveGithubRepository(user: string | null, repo: string | null): void {
  if (user && repo && (!isGitHubName(user) || !isGitHubName(repo))) throw new Error("GitHub user and repository names may contain only letters, numbers, dots, underscores, and hyphens.")
  saveGithubSettings((settings) => {
    if (user && repo) {
      settings.github_user = user
      settings.github_repo = repo
    } else {
      delete settings.github_user
      delete settings.github_repo
    }
  })
}

async function fetchRelease(token?: string): Promise<{ release: ReleaseResponse | null; accessDenied: boolean }> {
  try {
    const response = await fetch(`https://api.github.com/repos/${githubRepository()}/releases/latest`, {
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
    const result = Bun.spawnSync(["gh", "api", `repos/${githubRepository()}/releases/latest`])
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

function expectedFiles(): string[] {
  const suffix = process.platform === "win32" ? ".exe" : ""
  return ["meshtalk", "meshtalk-backend"].map((name) => `${name}${suffix}`)
}

type PendingUpdate = {
  staging: string
  installDir: string
  files: string[]
}

function writePendingUpdate(pending: PendingUpdate): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const temporary = `${PENDING_UPDATE_PATH}.tmp`
  writeFileSync(temporary, JSON.stringify(pending))
  chmodSync(temporary, 0o600)
  rmSync(PENDING_UPDATE_PATH, { force: true })
  renameSync(temporary, PENDING_UPDATE_PATH)
}

export function applyPendingWindowsReplacement(): boolean {
  let pending: PendingUpdate
  try {
    pending = JSON.parse(readFileSync(PENDING_UPDATE_PATH, "utf-8"))
  } catch {
    return true
  }
  const remaining = [...pending.files]
  for (const name of pending.files) {
    const source = join(pending.staging, name)
    const dest = join(pending.installDir, name)
    try {
      renameSync(source, dest)
    } catch {
      continue
    }
    remaining.splice(remaining.indexOf(name), 1)
    if (remaining.length > 0) writePendingUpdate({ ...pending, files: remaining })
  }
  if (remaining.length === 0) {
    try { rmSync(pending.staging, { recursive: true, force: true }) } catch {}
    try { rmSync(PENDING_UPDATE_PATH, { force: true }) } catch {}
    return true
  }
  return false
}

export function spawnWindowsReplacementHelper(): boolean {
  let pending: PendingUpdate
  try {
    pending = JSON.parse(readFileSync(PENDING_UPDATE_PATH, "utf-8"))
  } catch {
    return false
  }
  const launcherPath = join(pending.installDir, `meshtalk${process.platform === "win32" ? ".exe" : ""}`)
  const lines = [
    "@echo off",
    "setlocal EnableExtensions EnableDelayedExpansion",
    `set PID=${process.pid}`,
    "set /a attempts=0",
    ":wait",
    `tasklist /fi "PID eq %PID%" 2>nul | find /i "%PID%" >nul`,
    "if not errorlevel 1 (",
    "    set /a attempts+=1",
    "    if !attempts! GEQ 120 goto giveup",
    "    timeout /t 1 /nobreak >nul",
    "    goto wait",
    ")",
    ...pending.files.map((name) => `copy /y "${join(pending.staging, name)}" "${join(pending.installDir, name)}" >nul || goto failed`),
    `rmdir /s /q "${pending.staging}"`,
    `del "${PENDING_UPDATE_PATH}" >nul 2>&1`,
    `start "" "${launcherPath}"`,
    "exit /b 0",
    ":giveup",
    "echo MeshTalk update helper could not wait for the launcher to exit.",
    "exit /b 1",
    ":failed",
    "echo MeshTalk update helper could not replace all installed files.",
    "exit /b 1",
  ]
  const script = join(pending.staging, "replace.cmd")
  writeFileSync(script, lines.join("\r\n"))
  try {
    const helper = Bun.spawn(["cmd.exe", "/d", "/c", script], {
      detached: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: true,
    })
    if (!Number.isInteger(helper.pid) || helper.pid <= 0) throw new Error("Windows update helper process did not start")
    helper.unref()
    return true
  } catch {
    return false
  }
}

export async function installRelease(release: Release, installDir: string, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "meshtalk-update-"))
  let staging: string | undefined
  try {
    const token = githubToken()
    const downloadStep = token ? "Downloading GitHub release with Bun fetch (saved token)" : "Downloading GitHub release with Bun fetch"
    onProgress?.({ current: 1, total: 6, step: downloadStep, receivedBytes: 0 })
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
    const archivePath = join(temporary, release.assetName)
    const archiveFile = await open(archivePath, "w")
    const hasher = new Bun.CryptoHasher("sha256")
    let receivedBytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await archiveFile.write(value)
        hasher.update(value)
        receivedBytes += value.length
        onProgress?.({ current: 1, total: 6, step: downloadStep, receivedBytes, totalBytes })
      }
    } finally {
      await archiveFile.close()
    }
    onProgress?.({ current: 2, total: 6, step: "Verifying SHA-256 digest" })
    await Bun.sleep(16)
    const expectedDigest = release.digest?.replace(/^sha256:/, "").toLowerCase()
    if (!expectedDigest) throw new Error("GitHub did not provide a SHA-256 digest for this release")
    if (hasher.digest("hex") !== expectedDigest) throw new Error("SHA-256 verification failed")
    onProgress?.({ current: 3, total: 6, step: "Inspecting release archive" })
    const listing = Bun.spawn(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "ignore" })
    const listingOutput = new Response(listing.stdout).text()
    if (await listing.exited !== 0) throw new Error("Unable to inspect the release archive")
    const entries = (await listingOutput).split("\n").filter(Boolean)
    if (entries.some((entry) => entry.startsWith("/") || entry === ".." || entry.includes("../"))) throw new Error("Release archive contains an unsafe path")
    const extracted = join(temporary, "extracted")
    await mkdir(extracted)
    onProgress?.({ current: 4, total: 6, step: "Extracting release archive" })
    const extract = Bun.spawn(["tar", "-xzf", archivePath, "-C", extracted], { stdout: "ignore", stderr: "ignore" })
    if (await extract.exited !== 0) throw new Error("Unable to extract the release archive")
    onProgress?.({ current: 5, total: 6, step: "Validating extracted binaries" })
    await Bun.sleep(16)
    for (const name of expectedFiles()) {
      const source = join(extracted, name)
      try {
        if (!(await stat(source)).isFile()) throw new Error()
      } catch {
        throw new Error(`Release archive is missing ${name}`)
      }
    }
    if (process.platform === "win32") {
      onProgress?.({ current: 6, total: 6, step: "Staging files for replacement after restart" })
      await Bun.sleep(16)
      staging = mkdtempSync(join(installDir, ".meshtalk-update-"))
      const installStaging = staging
      await Promise.all(expectedFiles().map(async (name) => {
        await copyFile(join(extracted, name), join(installStaging, name))
      }))
      writePendingUpdate({ staging: installStaging, installDir, files: expectedFiles() })
      staging = undefined
      return
    }
    // A running executable cannot be copied over, but its pathname can be
    // atomically replaced. Stage on the installation filesystem so rename does
    // not fail when the system temporary directory is on another filesystem.
    onProgress?.({ current: 6, total: 6, step: "Replacing installed binaries" })
    await Bun.sleep(16)
    staging = mkdtempSync(join(installDir, ".meshtalk-update-"))
    const installStaging = staging
    await Promise.all(expectedFiles().map(async (name) => {
      const staged = join(installStaging, name)
      await copyFile(join(extracted, name), staged)
      if (process.platform !== "win32") await chmod(staged, 0o755)
    }))
    for (const name of expectedFiles()) {
      await rename(join(installStaging, name), join(installDir, name))
    }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
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
  const path = updateRestartPath()
  if (path) rmSync(RESTART_PATH, { force: true })
  return path
}

export function updateRestartPath(): string | null {
  try {
    const path = readFileSync(RESTART_PATH, "utf-8").trim()
    return path || null
  } catch {
    return null
  }
}

export function releaseInstallDir(): string | null {
  for (const executable of [process.argv[0], process.argv[1], process.execPath]) {
    if (!executable || !basename(executable).startsWith("meshtalk")) continue
    const directory = dirname(executable)
    if (isReleaseInstallDir(directory)) return directory
  }
  return null
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
