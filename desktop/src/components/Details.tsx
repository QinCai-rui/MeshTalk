import { useState } from "react"
import { request, type Conversation, type Row } from "../api"
import { Dialog } from "./Dialog"

export function Details({ conversation, members, peers, identity, onClose, onSelect, onRefresh }: { conversation: Conversation; members: Row[]; peers: Row[]; identity: Row; onClose: () => void; onSelect: (c: Conversation) => void; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState("")
  const [error, setError] = useState("")
  const [invite, setInvite] = useState("")
  const [copied, setCopied] = useState(false)
  const p = peers.find(p => p.peer_id === conversation.id)
  async function act(action: string, params: Row) { try { await request(action, params); await onRefresh(); setError("") } catch (e) { setError(String(e)) } }
  return <Dialog title={conversation.name} onClose={onClose}>
    {error && <p role="alert">{error}</p>}
    <p className="muted">{conversation.kind === "group" ? "Group" : "Peer"} ID: <code>{conversation.id}</code></p>
    <button onClick={() => { void navigator.clipboard.writeText(conversation.id).then(() => setCopied(true)).catch(e => setError(String(e))) }}>{copied ? "Copied" : "Copy ID"}</button>
    {conversation.kind === "group" ? <>
      <button onClick={() => { void request("room_invite", { room_id: conversation.id }).then(r => setInvite(r.invite)).catch(e => setError(String(e))) }}>Share invite</button>
      {invite && <><textarea aria-label="Group invite" readOnly value={invite} /><button onClick={() => { void navigator.clipboard.writeText(invite).then(() => setCopied(true)).catch(e => setError(String(e))) }}>Copy invite</button></>}
      <h3>{members.length} members</h3><input aria-label="Search members" placeholder="Search members" value={filter} onChange={e => setFilter(e.target.value)} />
      {members.filter(m => m.display_name.toLowerCase().includes(filter.toLowerCase())).map(m => { const id = m.peer_id ?? m.member_id; const peer = peers.find(p => p.peer_id === id); return <section className="card" key={id}><strong>{m.display_name}{id === identity.peer_id ? " (you)" : ""}</strong><p>{peer?.dnd ? "Do not disturb" : peer?.presence ?? (m.is_online ? "Online" : "Offline")}{peer?.is_friend ? " · Friend" : ""}{m.is_limited ? " · Limited client capabilities" : ""}</p>{id !== identity.peer_id && <button onClick={() => { onSelect({ kind: "peer", id, name: m.display_name }); onClose() }}>Message</button>}</section> })}
    </> : <>
      <p>{p?.is_online ? p.dnd ? "Do not disturb" : p.presence : "Offline"} · {p?.is_friend ? "Friend" : p?.friend_request ? `${p.friend_request} friend request` : "Not a friend"}</p>
      {p?.friend_request === "incoming" && <p>Open People to accept or decline their request.</p>}
      {!p?.is_friend && !p?.friend_request && <button onClick={() => act("friend_send", { peer_id: conversation.id })}>Add friend</button>}
      {p?.capability_gap && <p className="notice">Some features are unavailable with this peer's client. Missing capabilities: {(p.peer_missing_capabilities ?? []).join(", ") || "Unknown"}.</p>}
      <h3>Connection</h3><p>{p?.active_transport ?? "Not connected"}</p>{p?.endpoints?.map((e: Row) => <p key={`${e.transport}:${e.endpoint}`}><code>{e.endpoint}</code> · {e.transport}{e.active ? " · Active" : ""}</p>)}
    </>}
  </Dialog>
}
