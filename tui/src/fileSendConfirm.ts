import { copyFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { basename, join } from "path"

export type FileDropSource = "drop" | "paste" | "clipboard" | "picker"

const FILE_TYPE_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
}

const PREVIEWABLE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"])

export function fileConfirmDialogWidth(screenWidth: number): number {
  return Math.max(1, Math.min(72, Math.floor(screenWidth) - 8))
}

export function fileConfirmDialogHeight(screenHeight: number, hasImage: boolean): number {
  return Math.max(1, Math.min(hasImage ? 22 : 12, Math.floor(screenHeight) - (hasImage ? 2 : 6)))
}

export function fileConfirmImageBounds(screenWidth: number, screenHeight: number, popupWidth: number, popupHeight: number): { maxWidth: number; maxHeight: number } {
  const conversationWidth = Math.max(1, Math.floor(screenWidth) - 5)
  const conversationHeight = Math.min(16, Math.max(4, Math.floor(screenHeight) - 4))
  return {
    maxWidth: Math.max(1, Math.min(Math.floor(popupWidth) - 4, Math.floor(conversationWidth * Math.SQRT1_2))),
    maxHeight: Math.max(1, Math.min(Math.floor(popupHeight) - 11, Math.floor(conversationHeight * Math.SQRT1_2))),
  }
}

export function hasImageConfirmationPreview(paths: string[], hasInlineImage: boolean): boolean {
  if (hasInlineImage || paths.length !== 1) return hasInlineImage
  const filename = paths[0]?.split(/[\\/]/).pop() ?? ""
  const extension = filename.split(".").pop()?.toLowerCase() ?? ""
  return PREVIEWABLE_IMAGE_EXTENSIONS.has(extension)
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function fileTypeLabel(filename: string, mimeType?: string): string {
  if (mimeType?.trim()) return mimeType.trim().toLowerCase()
  const basename = filename.split(/[\\/]/).pop() ?? filename
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".") + 1).toLowerCase() : ""
  return FILE_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream"
}

/** Preserve drag-and-drop sources that may disappear before confirmation is shown. */
export async function stageFilesForConfirmation(paths: string[]): Promise<string[]> {
  const directory = join(tmpdir(), "meshtalk-drops", crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  return Promise.all(paths.map(async (source) => {
    const destination = join(directory, basename(source))
    await copyFile(source, destination)
    return destination
  }))
}

/** Strip one layer of surrounding single/double quotes and unescape. */
function stripQuotes(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1)
      if (first === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      return inner
    }
  }
  return trimmed
}

function stripFileUrl(token: string): string {
  let value = token.trim()
  if (/^file:\/\//i.test(value)) {
    try {
      // file:///home/u/f%20o.txt -> /home/u/f o.txt
      // file://host/share -> keep host part for UNC-ish values.
      const withoutScheme = value.replace(/^file:\/\//i, "")
      if (withoutScheme.startsWith("/")) return decodeURIComponent(withoutScheme)
      const slash = withoutScheme.indexOf("/")
      if (slash === -1) return decodeURIComponent(withoutScheme)
      const host = withoutScheme.slice(0, slash)
      const path = decodeURIComponent(withoutScheme.slice(slash))
      if (host && host !== "localhost") return `//${host}${path}`
      return path
    } catch {
      return value.replace(/^file:\/\//i, "")
    }
  }
  return value
}

/** Split text into tokens, respecting single/double quotes (terminal DnD quoting). */
function tokenizeRespectingQuotes(line: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quote) {
      current += char
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === " " || char === "\t") {
      if (current.trim()) tokens.push(current)
      current = ""
    } else {
      current += char
    }
  }
  if (current.trim()) tokens.push(current)
  return tokens
}

function looksLikePath(value: string): boolean {
  const v = value.trim()
  if (!v || /\n/.test(v)) return false
  if (/\s{2,}/.test(v) && !v.startsWith('"') && !v.startsWith("'")) {
    // Unquoted multi-space runs are likely chat text, not a single path.
    return false
  }
  if (/^file:\/\//i.test(v)) return true
  if (v.startsWith("~")) return true
  if (v.startsWith("/") || v.startsWith("./") || v.startsWith("../")) return true
  if (/^[A-Za-z]:[\\/]/.test(v)) return true
  if (v.startsWith("\\\\")) return true
  if (v.startsWith("\\\\?\\")) return true
  return false
}

/** Parse dropped/pasted text into candidate file paths. */
export function parsePotentialFilePaths(text: string): string[] {
  if (!text || text.length > 32_768) return []
  const candidates: string[] = []
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length > 32) return []
  for (const line of lines) {
    if (lines.length === 1) {
      // Single-line input: only treat as paths when EVERY token looks like a
      // path — a chat sentence mentioning one path must stay a message.
      const tokens = tokenizeRespectingQuotes(line)
      if (!tokens.length) return []
      const cleaned = tokens.map((token) => stripFileUrl(stripQuotes(token)))
      const allPaths = tokens.every(
        (token, index) => looksLikePath(token.trim()) || looksLikePath(cleaned[index]!),
      )
      if (!allPaths) return []
      for (const value of cleaned) {
        if (value && !candidates.includes(value)) candidates.push(value)
      }
      continue
    } else {
      const cleaned = stripFileUrl(stripQuotes(line))
      if (cleaned && (looksLikePath(line) || looksLikePath(cleaned))) {
        if (!candidates.includes(cleaned)) candidates.push(cleaned)
      }
    }
  }
  return candidates.slice(0, 32)
}
