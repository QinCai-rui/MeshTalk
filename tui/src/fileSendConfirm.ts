export type FileDropSource = "drop" | "paste" | "clipboard" | "picker"

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

/**
 * Parse pasted/dropped text into candidate local file paths.
 * Terminals deliver drag-and-drop as bracketed-paste of quoted paths,
 * so "release to send" hover state is unavailable — callers validate
 * existence and route matches to a confirmation dialog instead.
 */
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
