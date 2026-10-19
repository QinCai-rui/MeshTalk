import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

// Bun's ordinary Windows realpath walks junctions but can preserve 8.3 names.
// Its compiled process.execPath is natively canonicalized instead. Use the
// same physical spelling for installation and process-derived paths.
export function physicalPath(path: string): string {
  return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path)
}

// Resolve ancestors without following the entry's own junction: the public
// command folder is a pathname we manage, not the release it currently selects.
// Missing descendants are allowed while planning a new installation.
export function installationEntryPath(path: string): string {
  const absolute = resolve(path)
  try {
    const info = lstatSync(absolute)
    if (info.isDirectory() && !info.isSymbolicLink()) return physicalPath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  let ancestor = dirname(absolute)
  const tail = [basename(absolute)]
  while (true) {
    try { return join(physicalPath(ancestor), ...tail) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === dirname(ancestor)) throw error
      // A dangling ancestor link is not an absent directory we may create.
      if (lstatSync(ancestor, { throwIfNoEntry: false })) throw error
      tail.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
}
