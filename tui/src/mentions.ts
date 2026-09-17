export type MentionCandidate = {
  peerId: string
  displayName: string
  isSelf?: boolean
}

/**
 * A picked mention as stored against composer text: the `@Display Name`
 * range that must be converted back to `<@peer_id>` on send.
 */
export type MentionSpan = {
  peerId: string
  name: string
  start: number
  end: number
}

/**
 * Reconcile mention spans with a single contiguous buffer edit, derived by
 * diffing previous against next text. Spans fully before/after the edit are
 * kept (shifted as needed); spans overlapping the edit broke into plain text
 * and are dropped.
 */
export function updateSpansAfterEdit(
  spans: MentionSpan[],
  prevText: string,
  nextText: string,
): MentionSpan[] {
  if (prevText === nextText) return spans
  let start = 0
  while (start < prevText.length && start < nextText.length && prevText[start] === nextText[start]) start++
  let prevEnd = prevText.length
  let nextEnd = nextText.length
  while (prevEnd > start && nextEnd > start && prevText[prevEnd - 1] === nextText[nextEnd - 1]) {
    prevEnd--
    nextEnd--
  }
  const delta = nextEnd - start - (prevEnd - start)
  const next: MentionSpan[] = []
  for (const span of spans) {
    if (span.end <= start) {
      next.push(span)
    } else if (span.start >= prevEnd) {
      next.push({ ...span, start: span.start + delta, end: span.end + delta })
    }
  }
  return next
}

/**
 * Replace validated `@Display Name` spans with `<@peer_id>` tokens for
 * sending. Spans whose text no longer matches are left as typed.
 */
export function spansToTokens(text: string, spans: MentionSpan[]): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start)
  let result = text
  for (const span of ordered) {
    if (span.start < 0 || span.end > result.length || span.start >= span.end) continue
    if (result.slice(span.start, span.end) !== `@${span.name}`) continue
    result = result.slice(0, span.start) + `<@${span.peerId}>` + result.slice(span.end)
  }
  return result
}

const MENTION_TOKEN_RE = /<@([A-Za-z0-9_-]+)>/g
const MENTION_AT_RE = /^<@([A-Za-z0-9_-]+)>/

export const EVERYONE_PEER_ID = "everyone"

function isEscapedAt(content: string, index: number): boolean {
  let backslashes = 0
  let i = index - 1
  while (i >= 0 && content[i] === "\\") {
    backslashes++
    i--
  }
  return backslashes % 2 === 1
}

/** Extract unique mentioned peer IDs from message content, in order. */
export function parseMentions(content: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  MENTION_TOKEN_RE.lastIndex = 0
  for (const match of content.matchAll(MENTION_TOKEN_RE)) {
    const index = match.index ?? 0
    if (isEscapedAt(content, index)) continue
    const id = match[1]!
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/** Whether message content mentions a specific peer. */
export function mentionsPeer(content: string, peerId: string): boolean {
  if (!peerId) return false
  return parseMentions(content).includes(peerId)
}

/**
 * Mentioned peer IDs straight from the server payload — the only source the
 * client uses to decide "mentioned me". Message content is never parsed for
 * this; it is only used to render `@Display Name` text.
 */
export function payloadMentions(payload: unknown): string[] {
  if (!Array.isArray(payload)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of payload) {
    if (typeof id !== "string" || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Whether a mentions payload targets everyone. The payload carries the
 * sentinel `everyone` instead of enumerating every member's id.
 */
export function mentionsEveryone(payload: unknown): boolean {
  return payloadMentions(payload).includes(EVERYONE_PEER_ID)
}

/**
 * Shared mention scan: `\\` collapses to `\`, `\<@id>` is a literal, `<@id>`
 * is a mention, and a lone `\` before anything else stays untouched (so
 * paths like `C:\new` survive). Mirrors the backend escape rules.
 */
function scanMentionContent(
  content: string,
  onText: (text: string) => void,
  onMention: (peerId: string) => void,
  onCode: (text: string) => void = onText,
): void {
  let i = 0
  while (i < content.length) {
    // Markdown code spans and fenced blocks are literal. Keep each complete
    // code region together so mention replacement never runs inside it; the
    // inline renderer below can then apply the normal code styling.
    const lineStart = i === 0 || content[i - 1] === "\n"
    if (lineStart) {
      const lineEnd = content.indexOf("\n", i)
      const endOfLine = lineEnd < 0 ? content.length : lineEnd
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(content.slice(i, endOfLine))
      if (fence) {
        const marker = fence[1]![0]!
        const markerLength = fence[1]!.length
        let cursor = lineEnd < 0 ? content.length : lineEnd + 1
        let end = content.length
        while (cursor < content.length) {
          const nextLineEnd = content.indexOf("\n", cursor)
          const nextEndOfLine = nextLineEnd < 0 ? content.length : nextLineEnd
          const closing = new RegExp(`^ {0,3}${marker}{${markerLength},}\\s*$`).test(
            content.slice(cursor, nextEndOfLine),
          )
          if (closing) {
            end = nextLineEnd < 0 ? content.length : nextLineEnd + 1
            break
          }
          cursor = nextLineEnd < 0 ? content.length : nextLineEnd + 1
        }
        onCode(content.slice(i, end))
        i = end
        continue
      }
    }
    if (content[i] === "`" && !isEscapedAt(content, i)) {
      let markerLength = 1
      while (content[i + markerLength] === "`") markerLength++
      const marker = "`".repeat(markerLength)
      const closing = content.indexOf(marker, i + markerLength)
      if (closing >= 0) {
        onCode(content.slice(i, closing + markerLength))
        i = closing + markerLength
        continue
      }
    }
    const ch = content[i]!
    if (ch === "\\" && content[i + 1] === "\\") {
      onText("\\")
      i += 2
      continue
    }
    if (ch === "\\") {
      const escaped = MENTION_AT_RE.exec(content.slice(i + 1))
      if (escaped) {
        onText(escaped[0])
        i += 1 + escaped[0].length
        continue
      }
    }
    if (ch === "<") {
      const match = MENTION_AT_RE.exec(content.slice(i))
      if (match) {
        onMention(match[1]!)
        i += match[0].length
        continue
      }
    }
    onText(ch)
    i += 1
  }
}

/**
 * Render stored `<@user_id>` tokens as `@Display Name` for display.
 * Unknown IDs fall back to `@unknown` so raw tokens never leak into the UI.
 * Escaped tokens (`\<@id>`) render as literal `<@id>` and do not become pills;
 * `\\` renders as a single `\`.
 */
export function renderMentionedContent(
  content: string,
  resolveName: (peerId: string) => string | undefined,
): string {
  let result = ""
  scanMentionContent(
    content,
    (text) => {
      result += text
    },
    (peerId) => {
      result += `@${resolveName(peerId) ?? "unknown"}`
    },
    (text) => {
      result += text
    },
  )
  return result
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "mention"; peerId: string; name: string }

/** Split content into plain runs and mention tokens for pill rendering. */
export function segmentMentionedContent(
  content: string,
  resolveName: (peerId: string) => string | undefined,
): MentionSegment[] {
  const segments: MentionSegment[] = []
  let textBuffer = ""
  const flushText = () => {
    if (textBuffer) {
      segments.push({ type: "text", text: textBuffer })
      textBuffer = ""
    }
  }
  scanMentionContent(
    content,
    (text) => {
      textBuffer += text
    },
    (peerId) => {
      flushText()
      segments.push({ type: "mention", peerId, name: resolveName(peerId) ?? "unknown" })
    },
    (text) => {
      flushText()
      segments.push({ type: "code", text })
    },
  )
  flushText()
  return segments
}

export type MentionBodyBlock =
  | { kind: "plain"; text: string }
  | { kind: "rich"; segments: MentionSegment[] }

/**
 * Group segments into paragraphs at blank lines. Plain paragraphs render
 * through markdown untouched; rich paragraphs render as inline text with
 * mention pills. Single newlines stay inside their paragraph.
 */
export function splitMentionBody(segments: MentionSegment[]): MentionBodyBlock[] {
  const paragraphs: MentionSegment[][] = [[]]
  for (const segment of segments) {
    if (segment.type === "text") {
      const parts = segment.text.split(/\n{2,}/)
      parts.forEach((part, index) => {
        if (index > 0) paragraphs.push([])
        if (part) paragraphs[paragraphs.length - 1]!.push({ type: "text", text: part })
      })
    } else {
      paragraphs[paragraphs.length - 1]!.push(segment)
    }
  }
  const blocks: MentionBodyBlock[] = []
  for (const paragraph of paragraphs) {
    if (!paragraph.length) continue
    if (paragraph.some((segment) => segment.type === "mention")) {
      blocks.push({ kind: "rich", segments: paragraph })
    } else {
      const text = paragraph
        .filter((segment): segment is Extract<MentionSegment, { type: "text" | "code" }> => segment.type !== "mention")
        .map((segment) => segment.text)
        .join("")
      blocks.push({ kind: "plain", text })
    }
  }
  return blocks
}

export type InlineFragment =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; label: string; url: string }
  | { type: "strike"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; marker: string; text: string }
  | { type: "quote"; text: string }

/**
 * Lightweight Markdown parser for rich mention paragraphs.
 * Handles common block and inline constructs; everything else stays as plain
 * text. Code spans are excluded from inner parsing.
 */
export function parseInlineMarkdown(text: string): InlineFragment[] {
  // A fenced block is intentionally left completely literal. This also
  // prevents block markers inside it from being mistaken for list/heading
  // syntax by the lightweight renderer.
  if (/(^|\n) {0,3}(`{3,}|~{3,})/.test(text)) return [{ type: "text", text }]
  const fragments: InlineFragment[] = []
  let pos = 0
  const patterns: Array<{ re: RegExp; type: InlineFragment["type"] }> = [
    { re: /^ {0,3}(#{1,6})[ \t]+([^\n]+)$/gm, type: "heading" },
    { re: /^([ \t]*(?:[-+*]|\d+[.)]))[ \t]+([^\n]+)$/gm, type: "list" },
    { re: /^([ \t]*>[ \t]?)([^\n]+)$/gm, type: "quote" },
    { re: /`([^`]+)`/g, type: "code" },
    { re: /\[([^\]]+)\]\(([^)]+)\)/g, type: "link" },
    { re: /\*\*([^*]+?)\*\*/g, type: "strong" },
    { re: /__([^_]+?)__/g, type: "strong" },
    { re: /~~([^~]+?)~~/g, type: "strike" },
    { re: /\*([^*]+?)\*/g, type: "em" },
    { re: /_([^_]+?)_/g, type: "em" },
  ]
  while (pos < text.length) {
    let best: RegExpExecArray | null = null
    let bestType: InlineFragment["type"] | null = null
    let bestRe: RegExp | null = null
    for (const { re, type } of patterns) {
      re.lastIndex = pos
      const m = re.exec(text)
      if (m && (best === null || m.index < best.index || (m.index === best.index && m[0].length > best[0].length))) {
        best = m
        bestType = type
        bestRe = re
      }
    }
    if (!best || bestType === null || bestRe === null) {
      fragments.push({ type: "text", text: text.slice(pos) })
      break
    }
    if (best.index > pos) {
      fragments.push({ type: "text", text: text.slice(pos, best.index) })
    }
    const raw = best[0]
    if (bestType === "heading") {
      fragments.push({ type: "heading", level: best[1]!.length, text: best[2]! })
    } else if (bestType === "list") {
      fragments.push({ type: "list", marker: best[1]!, text: best[2]! })
    } else if (bestType === "quote") {
      fragments.push({ type: "quote", text: best[0]! })
    } else if (bestType === "code") {
      fragments.push({ type: "code", text: best[1]! })
    } else if (bestType === "link") {
      fragments.push({ type: "link", label: best[1]!, url: best[2]! })
    } else if (bestType === "strong") {
      fragments.push({ type: "strong", text: best[1]! })
    } else if (bestType === "em") {
      fragments.push({ type: "em", text: best[1]! })
    } else if (bestType === "strike") {
      fragments.push({ type: "strike", text: best[1]! })
    }
    pos = best.index + raw.length
  }
  return fragments
}

export type MentionQuery = { start: number; query: string }

/**
 * Find an `@query` mention token immediately before the cursor, if any.
 * Only matches `@` at the start of the text or after whitespace so emails
 * and `<@user_id>` tokens never trigger the popup.
 */
export function mentionQueryAt(text: string, cursor: number): MentionQuery | undefined {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
  const match = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(before)
  if (!match) return undefined
  return { start: before.length - match[0].length + (match[0].startsWith("@") ? 0 : 1), query: match[1]! }
}

/** Filter group members by mention query (case-insensitive substring). */
export function filterMentionCandidates(
  members: MentionCandidate[],
  query: string,
  limit = 6,
): MentionCandidate[] {
  const normalized = query.toLowerCase()
  const filtered = normalized
    ? members.filter((member) => member.displayName.toLowerCase().includes(normalized))
    : [...members]
  filtered.sort((a, b) => {
    if (a.peerId === EVERYONE_PEER_ID) return -1
    if (b.peerId === EVERYONE_PEER_ID) return 1
    if (!normalized) return a.displayName.localeCompare(b.displayName)
    const aIndex = a.displayName.toLowerCase().indexOf(normalized)
    const bIndex = b.displayName.toLowerCase().indexOf(normalized)
    return aIndex - bIndex || a.displayName.localeCompare(b.displayName)
  })
  return filtered.slice(0, limit)
}
