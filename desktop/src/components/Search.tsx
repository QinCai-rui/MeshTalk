import { useRef, useState } from "react"
import { request, target, type Conversation, type Row } from "../api"
import { Dialog } from "./Dialog"

export function Search({ conversations, selection, onClose, onJump }: { conversations: Conversation[]; selection?: Conversation; onClose: () => void; onJump: (c: Conversation, id: string) => void }) {
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState(selection ? `${selection.kind}:${selection.id}` : "")
  const [rows, setRows] = useState<Row[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [searched, setSearched] = useState(false)
  const generation = useRef(0)
  function reset() { generation.current++; setRows([]); setNext(null); setSearched(false); setBusy(false) }
  async function search(offset = 0) {
    const gen = ++generation.current
    setBusy(true); setError("")
    const conversation = conversations.find(c => `${c.kind}:${c.id}` === scope)
    try {
      const result = await request("search_messages", { query, offset, ...(conversation ? target(conversation) : {}) })
      if (gen !== generation.current) return
      setRows(current => offset ? [...current, ...result.results] : result.results); setNext(result.next_offset); setSearched(true)
    } catch (e) { if (gen === generation.current) setError(String(e)) } finally { if (gen === generation.current) setBusy(false) }
  }
  return <Dialog title="Search messages" onClose={onClose} wide>
    <form onSubmit={e => { e.preventDefault(); void search() }}><div className="search-fields"><input autoFocus aria-label="Search text" placeholder="Search local message history" required maxLength={256} value={query} onChange={e => { reset(); setQuery(e.target.value) }} /><select aria-label="Search conversation" value={scope} onChange={e => { reset(); setScope(e.target.value) }}><option value="">All conversations</option>{conversations.map(c => <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.name}</option>)}</select><button disabled={busy || !query.trim()} className="primary">{busy ? "Searching…" : "Search"}</button></div></form>
    <p className="muted">Search stays on this device. Older encrypted history is searched in batches.</p>
    {error && <p role="alert">{error}</p>}
    {rows.map(r => { const c = conversations.find(c => c.kind === r.kind && c.id === r.conversation_id) ?? { kind: r.kind, id: r.conversation_id, name: r.conversation_id }; return <button className="search-result" key={`${r.kind}:${r.message_id}`} onClick={() => { onJump(c, r.message_id); onClose() }}><strong>{c.name}</strong><small>{new Date(r.created_at * 1000).toLocaleString()}</small><p>{r.content}</p></button> })}
    {searched && !rows.length && <p>No matches in the history searched so far.</p>}
    {next !== null && <button disabled={busy} onClick={() => search(next)}>Search older history</button>}
  </Dialog>
}
