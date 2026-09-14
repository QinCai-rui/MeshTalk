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

/** Extract unique mentioned peer IDs from message content, in order. */
export function parseMentions(content: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  MENTION_TOKEN_RE.lastIndex = 0
  for (const match of content.matchAll(MENTION_TOKEN_RE)) {
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
 * Render stored `<@user_id>` tokens as `@Display Name` for display.
 * Unknown IDs fall back to `@unknown` so raw tokens never leak into the UI.
 */
export function renderMentionedContent(
  content: string,
  resolveName: (peerId: string) => string | undefined,
): string {
  MENTION_TOKEN_RE.lastIndex = 0
  return content.replace(MENTION_TOKEN_RE, (_, peerId: string) => `@${resolveName(peerId) ?? "unknown"}`)
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
    if (!normalized) return a.displayName.localeCompare(b.displayName)
    const aIndex = a.displayName.toLowerCase().indexOf(normalized)
    const bIndex = b.displayName.toLowerCase().indexOf(normalized)
    return aIndex - bIndex || a.displayName.localeCompare(b.displayName)
  })
  return filtered.slice(0, limit)
}
