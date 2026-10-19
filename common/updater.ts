import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs"
import { mkdir, open, rm } from "fs/promises"
import { tmpdir } from "os"
import { basename, dirname, join, resolve, sep } from "path"
import { hasManagedBootstrap, installationRoot, installFromDirectory, stageReleaseDirectory } from "./release-install"

const DEFAULT_GITHUB_USER = "QinCai-rui"
const DEFAULT_GITHUB_REPO = "MeshTalk"
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ""
function expandHomePath(value: string): string {
  const trimmed = value.trim()
  return HOME && (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
    ? HOME + trimmed.slice(1)
    : trimmed
}

const REINSTALL_HINT = "Try reinstalling MeshTalk using the quick install script: https://github.com/QinCai-rui/MeshTalk#quick-install"

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

export type UpdateChannel = "stable" | "unstable"

export function readUpdateChannel(settingsPath: string = SETTINGS_PATH): UpdateChannel {
  try {
    const value = JSON.parse(readFileSync(settingsPath, "utf-8")) as { update_channel?: unknown }
    return value.update_channel === "unstable" ? "unstable" : "stable"
  } catch {
    return "stable"
  }
}

export function saveUpdateChannel(channel: UpdateChannel, settingsPath: string = SETTINGS_PATH, dataDir: string = DATA_DIR): void {
  mkdirSync(dataDir, { recursive: true })
  let settings: Record<string, unknown> = { version: 1 }
  try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")) } catch {}
  settings.update_channel = channel
  const temporary = `${settingsPath}.tmp`
  writeFileSync(temporary, JSON.stringify(settings, null, 2))
  chmodSync(temporary, 0o600)
  renameSync(temporary, settingsPath)
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

type Version = { parts: number[]; revision: number; snapshotRun: number | null }

function parseVersion(value: string): Version | null {
  const match = value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  const parts = match.slice(1, 4).map(Number)
  const pre = match[4]
  const build = match[5]
  // Legacy numeric revision (e.g. 0.7.1-1): ranks above the bare base release.
  if (pre !== undefined && /^\d+$/.test(pre)) return { parts, revision: Number(pre), snapshotRun: null }
  // Anything else with a pre-release segment (e.g. -SNAPSHOT) is a prerelease
  // that ranks below the same-base stable build. Snapshot runs order by the
  // leading number of the build metadata (+250-abcdef...).
  if (pre !== undefined) {
    let snapshotRun = 0
    if (build) {
      const run = build.match(/^(\d+)/)
      if (run) snapshotRun = Number(run[1])
    }
    return { parts, revision: 0, snapshotRun }
  }
  return { parts, revision: 0, snapshotRun: null }
}

export function isStableVersion(value: string): boolean {
  const version = parseVersion(value)
  return version !== null && version.snapshotRun === null
}

export function isNewerVersion(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  const installed = parseVersion(current)
  if (!next || !installed) return false
  for (let index = 0; index < next.parts.length; index++) {
    if (next.parts[index] !== installed.parts[index]) return next.parts[index] > installed.parts[index]
  }
  // Same base: numeric revisions outrank stable, stable outranks snapshots.
  const rank = (version: Version): number => version.snapshotRun !== null ? 0 : version.revision > 0 ? 2 : 1
  if (rank(next) !== rank(installed)) return rank(next) > rank(installed)
  if (next.snapshotRun !== null && installed.snapshotRun !== null) return next.snapshotRun > installed.snapshotRun
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

// Newest-first release list for the unstable channel: /releases/latest never
// includes prereleases, so unstable must enumerate and pick the newest
// non-draft itself (prereleases included).
async function fetchReleases(token?: string): Promise<{ releases: ReleaseResponse[]; accessDenied: boolean }> {
  try {
    const response = await fetch(`https://api.github.com/repos/${githubRepository()}/releases?per_page=10`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return { releases: [], accessDenied: [401, 403, 404].includes(response.status) }
    const releases = await response.json()
    return { releases: Array.isArray(releases) ? releases as ReleaseResponse[] : [], accessDenied: false }
  } catch {
    return { releases: [], accessDenied: false }
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

function ghReleases(): ReleaseResponse[] {
  try {
    const result = Bun.spawnSync(["gh", "api", `repos/${githubRepository()}/releases`, "--paginate"])
    if (result.exitCode !== 0) return []
    const releases = JSON.parse(new TextDecoder().decode(result.stdout))
    return Array.isArray(releases) ? releases as ReleaseResponse[] : []
  } catch {
    return []
  }
}

function asRelease(value: ReleaseResponse | null, allowPrerelease = false): Release | null {
  const assetName = platformAssetName()
  if (!value || value.draft || (!allowPrerelease && value.prerelease) || typeof value.tag_name !== "string" || !assetName) return null
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

function newestUsable(releases: ReleaseResponse[], allowPrerelease: boolean): Release | null {
  for (const candidate of releases) {
    const release = asRelease(candidate, allowPrerelease)
    if (release) return release
  }
  return null
}

export async function checkForUpdate(currentVersion: string, channel: UpdateChannel = readUpdateChannel()): Promise<Release | null> {
  const allowPrerelease = channel === "unstable"
  let release: Release | null = null
  let accessDenied = false
  if (allowPrerelease) {
    const listed = await fetchReleases()
    release = newestUsable(listed.releases, true)
    accessDenied = listed.accessDenied
    if (!release) release = newestUsable(ghReleases(), true)
  } else {
    const publicRelease = await fetchRelease()
    release = asRelease(publicRelease.release)
    accessDenied = publicRelease.accessDenied
    if (!release) release = asRelease(ghRelease())
  }
  const token = githubToken()
  if (!release && token) {
    if (allowPrerelease) {
      const authenticated = await fetchReleases(token)
      release = newestUsable(authenticated.releases, true)
      accessDenied = accessDenied || authenticated.accessDenied
    } else {
      const authenticatedRelease = await fetchRelease(token)
      release = asRelease(authenticatedRelease.release)
      accessDenied = accessDenied || authenticatedRelease.accessDenied
    }
  }
  if (!release && accessDenied) throw new GitHubAuthenticationError()
  return release && isNewerVersion(release.version, currentVersion) ? release : null
}

function expectedFiles(): string[] {
  const suffix = process.platform === "win32" ? ".exe" : ""
  return ["meshtalk", "meshtalk-backend"].map((name) => `${name}${suffix}`)
}

function archiveEntryIsSafe(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false
  return !normalized.split("/").some((part) => part === "..")
}

type PendingUpdate = {
  staging: string
  installDir: string
  files: string[]
}

export function parsePendingUpdate(value: unknown): PendingUpdate | null {
  if (!value || typeof value !== "object") return null
  const { staging, installDir, files } = value as Record<string, unknown>
  if (typeof staging !== "string" || !staging || typeof installDir !== "string" || !installDir) return null
  if (!Array.isArray(files) || files.length === 0 || files.some((name) => typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name.includes("..") || name.includes(":"))) return null
  return { staging, installDir, files: [...files as string[]] }
}

// A corrupt or tampered pending-update.json must never turn cleanup into a
// recursive delete of an arbitrary path. Staging directories are always
// created inside the install dir (mkdtempSync(join(installDir, ...))), so
// require that containment before removing anything derived from the marker.
export function isStagingWithinInstallDir(installDir: string, staging: string): boolean {
  try {
    const parent = resolve(installDir)
    const child = resolve(staging)
    return child !== parent && child.startsWith(parent + sep)
  } catch {
    return false
  }
}

function readPendingUpdate(): PendingUpdate | null {
  try {
    return parsePendingUpdate(JSON.parse(readFileSync(PENDING_UPDATE_PATH, "utf-8")))
  } catch {
    return null
  }
}

export function importLegacyWindowsUpdate(installDir: string): boolean {
  const pending = readPendingUpdate()
  if (!pending) return false
  // Import updates downloaded by an older Windows release. Never move files
  // over the running pair: the former "rollback" could delete the backend.
  try {
    const root = realpathSync(installDir)
    if (!lstatSync(installDir).isDirectory() || !lstatSync(pending.installDir).isDirectory()) return false
    if (realpathSync(pending.installDir) !== root || !isStagingWithinInstallDir(root, pending.staging)) return false
    if (!lstatSync(pending.staging).isDirectory() || dirname(resolve(pending.staging)) !== root || dirname(realpathSync(pending.staging)) !== root || !basename(pending.staging).startsWith(".meshtalk-update-")) return false
    const files = expectedFiles()
    if (pending.files.length !== files.length || files.some((name) => pending.files.filter((file) => file === name).length !== 1)) return false
    const entries = readdirSync(pending.staging)
    if (entries.length !== files.length || files.some((name) => !entries.includes(name) || !lstatSync(join(pending.staging, name)).isFile())) return false
    stageReleaseDirectory(pending.staging, root, "legacy-pending")
    // Cleanup is best effort after the release selector has been published.
    // A failed import above never removes the marker or its source files.
    try { rmSync(PENDING_UPDATE_PATH, { force: true }) } catch {}
    try { rmSync(pending.staging, { recursive: true, force: true }) } catch {}
    return true
  } catch {
    return false
  }
}

// Best-effort timestamped append to the update helper log. Never throws:
// logging must not break an update or restart.
export function logUpdateHelper(message: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const stamp = new Date().toISOString()
    writeFileSync(join(DATA_DIR, "update-helper.log"), `${stamp} ${message}\n`, { flag: "a" })
  } catch {}
}

export async function installRelease(release: Release, installDir: string, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "meshtalk-update-"))
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
      throw new Error(`Download failed (${response.status}). ${REINSTALL_HINT}`)
    }
    const totalBytes = Number(response.headers.get("content-length")) || undefined
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`Download response did not include a body. ${REINSTALL_HINT}`)
    const archivePath = join(temporary, release.assetName)
    const archiveFile = await open(archivePath, "w")
    const hasher = new Bun.CryptoHasher("sha256")
    let receivedBytes = 0
    let lastProgressTime = 0
    const progressThrottleMs = 100
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await archiveFile.write(value)
        hasher.update(value)
        receivedBytes += value.length
        const now = Date.now()
        if (now - lastProgressTime >= progressThrottleMs) {
          lastProgressTime = now
          onProgress?.({ current: 1, total: 6, step: downloadStep, receivedBytes, totalBytes })
        }
      }
      onProgress?.({ current: 1, total: 6, step: downloadStep, receivedBytes, totalBytes })
    } finally {
      await archiveFile.close()
    }
    onProgress?.({ current: 2, total: 6, step: "Verifying SHA-256 digest" })
    await Bun.sleep(16)
    const expectedDigest = release.digest?.replace(/^sha256:/, "").toLowerCase()
    if (!expectedDigest) throw new Error(`GitHub did not provide a SHA-256 digest for this release. ${REINSTALL_HINT}`)
    if (hasher.digest("hex") !== expectedDigest) throw new Error(`SHA-256 verification failed. ${REINSTALL_HINT}`)
    onProgress?.({ current: 3, total: 6, step: "Inspecting release archive" })
    // Run tar with cwd + relative names: MSYS/Git-Bash tar treats `C:\...`
    // absolute paths as remote (`C: resolve failed`), while the inbox Windows
    // tar handles them fine. Relative names work for both.
    const listing = Bun.spawn(["tar", "-tzf", basename(archivePath)], { cwd: temporary, stdout: "pipe", stderr: "ignore" })
    const listingOutput = new Response(listing.stdout).text()
    if (await listing.exited !== 0) throw new Error(`Unable to inspect the release archive. ${REINSTALL_HINT}`)
    const entries = (await listingOutput).split("\n").filter(Boolean)
    if (entries.some((entry) => !archiveEntryIsSafe(entry))) throw new Error(`Release archive contains an unsafe path. ${REINSTALL_HINT}`)
    const extracted = join(temporary, "extracted")
    await mkdir(extracted)
    onProgress?.({ current: 4, total: 6, step: "Extracting release archive" })
    const extract = Bun.spawn(["tar", "-xzf", basename(archivePath), "-C", "extracted"], { cwd: temporary, stdout: "ignore", stderr: "ignore" })
    if (await extract.exited !== 0) throw new Error(`Unable to extract the release archive. ${REINSTALL_HINT}`)
    onProgress?.({ current: 5, total: 6, step: "Validating extracted binaries" })
    await Bun.sleep(16)
    for (const name of expectedFiles()) {
      const source = join(extracted, name)
      try {
        if (!lstatSync(source).isFile() || !realpathSync(source).startsWith(realpathSync(extracted) + sep)) throw new Error()
      } catch {
        throw new Error(`Release archive is missing ${name}. ${REINSTALL_HINT}`)
      }
    }
    onProgress?.({ current: 6, total: 6, step: "Staging verified release for restart" })
    await Bun.sleep(16)
    if (hasManagedBootstrap(installDir)) stageReleaseDirectory(extracted, installDir, release.version)
    else installFromDirectory(extracted, installDir, release.version)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function requestUpdateRestart(installDir: string): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const temporary = `${RESTART_PATH}.tmp`
  writeFileSync(temporary, join(resolve(installDir), `meshtalk${process.platform === "win32" ? ".exe" : ""}`))
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
    const root = installationRoot(executable)
    if (root && isReleaseInstallDir(root)) return root
  }
  return null
}

export function isReleaseInstallDir(directory: string): boolean {
  try {
    if (!lstatSync(directory).isDirectory()) return false
    if (existsSync(join(directory, ".meshtalk-install.json")) && lstatSync(join(directory, `meshtalk${process.platform === "win32" ? ".exe" : ""}`)).isFile()) return true
    return expectedFiles().every((name) => {
      const path = join(directory, name)
      return existsSync(path) && lstatSync(path).isFile()
    })
  } catch {
    return false
  }
}
