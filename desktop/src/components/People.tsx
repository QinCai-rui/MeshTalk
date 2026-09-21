import { useEffect, useState } from "react"
import { request, type Row, type Conversation } from "../api"
import { Dialog } from "./Dialog"

export function People({ onClose, onSelect, onRefresh }: { onClose: () => void; onSelect: (c: Conversation) => void; onRefresh: () => Promise<void> }) {
  const [tab, setTab] = useState("Requests")
  const [data, setData] = useState<Row>({ peers: [], requests: [], blocked: [] })
  const [error, setError] = useState("")
  const [note, setNote] = useState("")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(false)
  async function load() {
    const [peers, requests, blocked, identity] = await Promise.all([request("peers"), request("friend_requests"), request("blocked_peers"), request("identity")])
    setData({ peers: peers.peers.filter((p: Row) => p.peer_id !== identity.peer_id), requests: requests.requests, blocked: blocked.blocked })
  }
  useEffect(() => { void load().catch(e => setError(String(e))) }, [])
  async function act(action: string, params: Row) {
    setBusy(true)
    try { await request(action, params); await load(); await onRefresh(); setError("") } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <Dialog title="People" onClose={onClose} wide>
    <nav className="tabs">{["Requests", "Add friend", "Friends", "Blocked"].map(t => <button key={t} aria-pressed={tab === t} className={tab === t ? "selected" : ""} onClick={() => setTab(t)}>{t}{t === "Requests" ? ` (${data.requests.length})` : ""}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy}>
      {tab === "Requests" && <>{!data.requests.length && <p>No pending requests.</p>}{data.requests.map((r: Row) => <section className="card" key={r.request_id}><strong>{r.direction === "incoming" ? r.sender_name : r.recipient_name}</strong><p>{r.note || "No note"}</p><small>{r.direction === "incoming" ? "Incoming request" : "Request sent"}</small><div className="actions">{r.direction === "incoming" ? <><button className="primary" onClick={() => act("friend_respond", { request_id: r.request_id, accept: true })}>Accept</button><button onClick={() => act("friend_respond", { request_id: r.request_id, accept: false })}>Decline</button><button onClick={() => act("block_peer", { peer_id: r.sender_id })}>Block sender</button></> : <button onClick={() => act("friend_cancel", { request_id: r.request_id })}>Cancel request</button>}</div></section>)}</>}
      {tab === "Add friend" && <><p>Choose someone discovered nearby or through a shared room.</p><input aria-label="Find a person" placeholder="Find a person" value={search} onChange={e => setSearch(e.target.value)} /><label>Optional introduction<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></label>{data.peers.filter((p: Row) => !p.is_friend && !p.is_blocked && p.display_name.toLowerCase().includes(search.toLowerCase())).map((p: Row) => <div className="card" key={p.peer_id}>{p.display_name}<button disabled={p.friend_request === "outgoing" || p.friend_request === "both"} onClick={() => act("friend_send", { peer_id: p.peer_id, note })}>{p.friend_request === "outgoing" || p.friend_request === "both" ? "Request pending" : "Add friend"}</button></div>)}<p className="muted">Don't see them? Share a room invite to connect remotely.</p></>}
      {tab === "Friends" && <>{!data.peers.some((p: Row) => p.is_friend) && <p>No friends yet. Start with Add friend.</p>}{data.peers.filter((p: Row) => p.is_friend).map((p: Row) => <div className="card" key={p.peer_id}><strong>{p.display_name}</strong><p>{p.is_online ? p.dnd ? "Do not disturb" : p.presence : "Offline"}</p><button onClick={() => { onSelect({ kind: "peer", id: p.peer_id, name: p.display_name }); onClose() }}>Message</button><button onClick={() => act("unfriend", { peer_id: p.peer_id })}>Remove friend</button><button onClick={() => act("block_peer", { peer_id: p.peer_id })}>Block</button></div>)}</>}
      {tab === "Blocked" && <>{!data.blocked.length && <p>No blocked people.</p>}{data.blocked.map((p: Row) => <div className="card" key={p.peer_id}>{p.display_name}<button onClick={() => act("unblock_peer", { peer_id: p.peer_id })}>Unblock</button></div>)}</>}
    </fieldset>
  </Dialog>
}
