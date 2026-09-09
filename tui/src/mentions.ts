export type MentionCandidate = {
  peerId: string
  displayName: string
  isSelf?: boolean
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

export type MentionEditor = {
  deleteCharBackward: () => void
  insertText: (text: string) => void
}

/**
 * Replace the `@query` token before the cursor with a `<@peer_id>` token.
 * `queryLength` is the length of the query without the `@`.
 */
export function applyMentionCompletion(
  editor: MentionEditor,
  queryLength: number,
  peerId: string,
): void {
  for (let i = 0; i < queryLength + 1; i++) editor.deleteCharBackward()
  editor.insertText(`<@${peerId}> `)
}
