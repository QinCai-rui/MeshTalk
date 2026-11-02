import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { installationEntryPath, physicalPath } from "./install-paths"

const MARKER = ".meshtalk-store.json"

export function installationDataDirectory(): string {
  const configured = process.env.MESHTALK_DATA_DIR?.trim()
  const path = configured === "~" ? homedir() : configured?.startsWith("~/") || configured?.startsWith("~\\") ? join(homedir(), configured.slice(2)) : configured
  return resolve(path || join(homedir(), ".meshtalk"))
}

export function sameInstallationPath(a: string, b: string): boolean {
  const canonical = (path: string) => {
    const entry = installationEntryPath(path)
    return process.platform === "win32" ? entry.toLowerCase() : entry
  }
  return canonical(a) === canonical(b)
}

export function privateInstallationStore(installDir: string): string {
  const entry = installationEntryPath(installDir)
  return join(installationDataDirectory(), "packages", "standalone", installationId(entry))
}

function installationId(entry: string): string {
  const identity = process.platform === "win32" ? entry.toLowerCase() : entry
  return createHash("sha256").update(identity).digest("hex").slice(0, 32)
}

export function installationStoreEntry(root: string): string | null {
  try {
    if (!lstatSync(root).isDirectory()) return null
    const marker = join(root, MARKER)
    if (!lstatSync(marker).isFile()) return null
    const owner = JSON.parse(readFileSync(marker, "utf8"))
    if (owner.schema !== 1 || typeof owner.entry !== "string" || !isAbsolute(owner.entry) || basename(root) !== installationId(installationEntryPath(owner.entry)) || basename(dirname(root)) !== "standalone" || basename(dirname(dirname(root))) !== "packages") return null
    return installationEntryPath(owner.entry)
  } catch { return null }
}

export function ownedPrivateInstallationStore(installDir: string): string | null {
  if (process.platform === "win32") {
    try {
      const pointer = join(installDir, ".meshtalk-entry.json")
      if (lstatSync(pointer).isFile()) {
        const value = JSON.parse(readFileSync(pointer, "utf8"))
        const owner = typeof value.store === "string" ? installationStoreEntry(value.store) : null
        if (value.schema === 1 && owner && sameInstallationPath(owner, installDir)) return physicalPath(value.store)
      }
    } catch {}
  }
  const root = privateInstallationStore(installDir)
  const entry = installationStoreEntry(root)
  return entry && sameInstallationPath(entry, installDir) ? physicalPath(root) : null
}

export function createInstallationStore(installDir: string): string {
  const entry = installationEntryPath(installDir)
  const root = privateInstallationStore(entry)
  // Reject links in the store hierarchy rather than creating or writing through
  // a redirected packages directory. The data directory itself may be configured.
  const data = installationDataDirectory()
  mkdirSync(data, { recursive: true, mode: 0o700 })
  for (const path of [join(data, "packages"), join(data, "packages", "standalone"), root]) {
    try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (!lstatSync(path).isDirectory()) throw new Error("MeshTalk's private installation store contains an unexpected link or file.")
    }
  }
  const marker = join(root, MARKER)
  try { writeFileSync(marker, JSON.stringify({ schema: 1, entry }), { flag: "wx", mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  if (!installationStoreEntry(root) || !sameInstallationPath(installationStoreEntry(root)!, entry)) throw new Error("The MeshTalk release store belongs to a different installation.")
  return physicalPath(root)
}
