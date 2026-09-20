import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { conversationKey, invoke, mergeMessages, request, sendTarget, target, type Conversation, type Row } from "./api"
import { Settings } from "./Settings"

const clientId = crypto.randomUUID()
const PUBLIC_CONTROL = "wss://meshtalk-control.qincai.xyz/v1/rendezvous"

function hueOf(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360
  return hash
}
function hueStyle(id: string): CSSProperties { return { "--h": String(hueOf(id)) } as CSSProperties }
function initialOf(name: string) { return (name.trim().slice(0, 1) || "?").toUpperCase() }
function timeOf(createdAt: number) { return new Date(createdAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }
function discordTime(createdAt: number) {
  const date = new Date(createdAt * 1000)
  const now = new Date()
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000)
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  if (diff === 0) return `Today at ${time}`
  if (diff === 1) return `Yesterday at ${time}`
  return `${date.toLocaleDateString([], { month: "2-digit", day: "2-digit", year: "numeric" })}`
}

export function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [identity, setIdentity] = useState<Row>({})
  const [peers, setPeers] = useState<Row[]>([])
  const [groups, setGroups] = useState<Row[]>([])
  const [selection, setSelection] = useState<Conversation>()
  const selected = useRef(selection)
  selected.current = selection
  const [messages, setMessages] = useState<Row[]>([])
  const cache = useRef<Record<string, Row[]>>({})
  const [files, setFiles] = useState<Row[]>([])
  const [members, setMembers] = useState<Row[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [reply, setReply] = useState<Row>()
  const [search, setSearch] = useState("")
  const [view, setView] = useState<"dms" | "groups">("dms")
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("meshtalk-theme") ?? "dark" } catch { return "dark" } })
  const [expanded, setExpanded] = useState<string>()
  const [menu, setMenu] = useState<{ x: number; y: number; conversation: Conversation } | null>(null)
  const [settings, setSettings] = useState(false)
  const [join, setJoin] = useState<string | null>(null)
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [closeChoice, setCloseChoice] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [remote, setRemote] = useState(true)
  const [analytics, setAnalytics] = useState("off")
  const [typing, setTyping] = useState<Record<string, Row>>({})
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(document.hasFocus())
  const focusRef = useRef(focused)
  focusRef.current = focused
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastTyping = useRef(0)
  const historyEnd = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const identityRef = useRef(identity)
  identityRef.current = identity

  const run = async (operation: () => Promise<unknown>) => {
    try { await operation(); setError("") } catch (e) { setError(String(e)) }
  }
  const refresh = useCallback(async () => {
    const [p, g, i] = await Promise.all([request("peers"), request("groups"), request("identity")])
    setPeers(p.peers); setGroups(g.groups); setIdentity(i)
  }, [])

  const load = useCallback(async (conversation: Conversation) => {
    const key = conversationKey(conversation)
    const [history, attachments, roster] = await Promise.all([
      request(conversation.kind === "group" ? "group_messages" : "messages", target(conversation)),
      request("files", target(conversation)),
      conversation.kind === "group" ? request("group_members", target(conversation)) : Promise.resolve({ members: [] }),
    ])
    cache.current[key] = mergeMessages(history.messages, cache.current[key] ?? [])
    if (selected.current && conversationKey(selected.current) === key) {
      setMessages(cache.current[key]); setFiles(attachments.files); setMembers(roster.members)
    }
  }, [])

  const start = useCallback(async () => {
    setError("")
    try {
      await invoke("connect_backend")
      await refresh()
      const i = await request("identity")
      setDisplayName(i.display_name === "Anonymous" ? "" : i.display_name)
      setOnboarding(!i.setup_dismissed)
      await request("tui_presence", { client_id: clientId, active: document.hasFocus() })
      setReady(true)
      if (selected.current) await load(selected.current)
    } catch (e) { setError(String(e)); setReady(false) }
  }, [refresh, load])

  useEffect(() => {
    let cancelled = false
    const cleanups: (() => void)[] = []
    async function setup() {
      const subscriptions = await Promise.all([
        listen<Row>("backend-event", ({ payload }) => {
          if (payload.event === "typing") {
            const key = `${payload.group_id ? "group:" + payload.group_id : "peer:" + payload.sender_id}:${payload.sender_id}`
            setTyping(current => current[key]?.created_at >= payload.created_at ? current : { ...current, [key]: { ...payload, expires: Date.now() + 6000 } })
            return
          }
          void refresh().catch(e => setError(String(e)))
          if (selected.current && focusRef.current) void load(selected.current).catch(e => setError(String(e)))
          if (["message", "group_message", "friend_request", "file_offer", "file_completed"].includes(payload.event) && !focusRef.current) {
            void (async () => {
              const [prefs, mute, me] = await Promise.all([request("notifications"), request("muted_peers"), request("identity")])
              const category = payload.event.includes("message") ? "messages" : payload.event === "friend_request" ? "friend_requests" : payload.event === "file_offer" ? "file_offers" : "file_completed"
              const until = payload.group_id ? mute.muted_groups?.[payload.group_id] : mute.muted_peers?.[payload.sender_id]
              const muted = until !== undefined && (until === 0 || until > Date.now() / 1000)
              if (!me.dnd_enabled && !muted && prefs.delivery !== "disabled" && prefs.events?.[category]) {
                await invoke("notify", { title: category === "messages" ? "You have a new message" : category === "friend_requests" ? "New friend request" : "File transfer updated" })
              }
            })().catch(() => {})
          }
        }),
        listen("backend-disconnected", () => { setReady(false); setError("Backend disconnected. Reconnect to continue.") }),
        listen<string[]>("invite-links", ({ payload }) => { const invite = payload.find(url => /^(meshtalk|meshtalk-group):/.test(url)); if (invite) setJoin(invite) }),
        listen("choose-close-mode", () => setCloseChoice(true)),
      ])
      if (cancelled) { subscriptions.forEach(unlisten => unlisten()); return }
      cleanups.push(...subscriptions)
      await start()
    }
    void setup().catch(e => setError(String(e)))
    return () => { cancelled = true; cleanups.forEach(unlisten => unlisten()) }
  }, [start, refresh, load])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem("meshtalk-theme", theme) } catch {}
  }, [theme])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [menu])

  useEffect(() => {
    const focus = () => { setFocused(true); if (ready) void run(async () => { await request("tui_presence", { client_id: clientId, active: true }); if (selected.current) await load(selected.current); await refresh() }) }
    const blur = () => { setFocused(false); if (ready) void request("tui_presence", { client_id: clientId, active: false }).catch(() => {}) }
    window.addEventListener("focus", focus); window.addEventListener("blur", blur)
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("blur", blur) }
  }, [ready, load, refresh])

  useEffect(() => {
    if (!ready) return
    const timer = setInterval(() => { void refresh().catch(() => {}); setTyping(current => Object.fromEntries(Object.entries(current).filter(([, row]) => row.expires > Date.now()))) }, 5000)
    return () => clearInterval(timer)
  }, [ready, refresh])

  useEffect(() => {
    setReply(undefined); setFiles([]); setMembers([])
    if (selection) { setMessages(cache.current[conversationKey(selection)] ?? []); void run(() => load(selection)) }
    else setMessages([])
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current)
      if (selection && ready) void request("typing", { ...sendTarget(selection), client_id: clientId, is_typing: false }).catch(() => {})
    }
  }, [selection?.id, selection?.kind, ready, load])

  useEffect(() => {
    try {
      historyEnd.current?.scrollIntoView({ behavior: "auto" })
    } catch {
      historyEnd.current?.scrollIntoView()
    }
  }, [messages.length, files.length])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettings(true) }
      if (event.key === "Escape") { setSettings(false); setJoin(null); setNewGroup(null); setReply(undefined); setCloseChoice(false); setMenu(null) }
    }
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  function edit(text: string) {
    if (!selection) return
    setDrafts(current => ({ ...current, [conversationKey(selection)]: text }))
    if (typingTimer.current) clearTimeout(typingTimer.current)
    if (Date.now() - lastTyping.current > 2500) {
      lastTyping.current = Date.now()
      void request("typing", { ...sendTarget(selection), client_id: clientId, is_typing: !!text }).catch(() => {})
    }
    const conversation = selection
    typingTimer.current = setTimeout(() => { void request("typing", { ...sendTarget(conversation), client_id: clientId, is_typing: false }).catch(() => {}) }, 3000)
  }

  async function send() {
    if (!selection || busy) return
    const conversation = selection
    const key = conversationKey(conversation)
    const content = (drafts[key] ?? "").trim()
    if (!content) return
    const row: Row = { message_id: crypto.randomUUID(), sender_id: identity.peer_id, content, created_at: Date.now() / 1000, pending: true, reply_to_message_id: reply?.message_id }
    cache.current[key] = [...(cache.current[key] ?? []), row]
    setMessages(cache.current[key]); setDrafts(current => ({ ...current, [key]: "" })); setReply(undefined); setBusy(true)
    try {
      const result = await request(conversation.kind === "group" ? "group_send" : "send", { ...sendTarget(conversation), content, reply_to_message_id: row.reply_to_message_id })
      cache.current[key] = cache.current[key].map(m => m.message_id === row.message_id ? { ...row, ...result, pending: false } : m)
      await load(conversation); await refresh()
    } catch (e) {
      cache.current[key] = cache.current[key].map(m => m.message_id === row.message_id ? { ...m, pending: false, failed: true } : m)
      if (selected.current && conversationKey(selected.current) === key) setMessages(cache.current[key])
      setError(String(e))
    } finally { setBusy(false); composer.current?.focus() }
  }

  const key = selection ? conversationKey(selection) : ""
  const peer = peers.find(p => p.peer_id === selection?.id)
  const dmUnread = peers.filter(p => p.unread_count > 0).length
  const groupUnread = groups.filter(g => g.unread_count > 0).length
  const rows: Row[] = [...messages.map((message): Row => ({ ...message, type: "message" })), ...files.map((file): Row => ({ ...file, type: "file" }))].sort((a, b) => a.created_at - b.created_at)
  const name = (id: string) => id === identity.peer_id ? "You" : peers.find(p => p.peer_id === id)?.display_name ?? members.find(m => m.peer_id === id)?.display_name ?? id.slice(0, 10)
  const typingNames = Object.entries(typing).filter(([id, value]) => id.startsWith(`${key}:`) && value.is_typing && value.expires > Date.now()).map(([, value]) => name(value.sender_id))

  return <div className="app">
    <nav className="rail" aria-label="Views">
      <button className={`rail-btn ${view === "dms" ? "selected" : ""}`} title="Direct Messages" aria-label="Direct Messages" onClick={() => setView("dms")}>💬{dmUnread > 0 && <span className="rail-dot" />}</button>
      <button className={`rail-btn ${view === "groups" ? "selected" : ""}`} title="Groups" aria-label="Groups" onClick={() => setView("groups")}>#{groupUnread > 0 && <span className="rail-dot" />}</button>
      <div className="rail-sep" />
      <button className="rail-btn action" title="Create group" aria-label="Create group" onClick={() => setNewGroup("")}>+</button>
      <button className="rail-btn action" title="Join with invite" aria-label="Join with invite" onClick={() => setJoin("")}>↗</button>
    </nav>
    <aside className="sidebar">
      <div className="list-head"><h2>{view === "dms" ? "Direct Messages" : "Groups"}</h2></div>
      <div className="search"><input aria-label="Search conversations" placeholder={view === "dms" ? "Find a conversation" : "Find a group"} value={search} onChange={e => setSearch(e.target.value)} /></div>
      <nav aria-label="Conversations">
        {view === "groups"
          ? groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase())).map(g => <button className={`conversation ${selection?.id === g.group_id ? "selected" : ""} ${g.unread_count > 0 ? "unread" : ""}`} key={g.group_id} onClick={() => setSelection({ kind: "group", id: g.group_id, name: g.name })} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, conversation: { kind: "group", id: g.group_id, name: g.name } }) }}>{g.unread_count > 0 && <span className="unread-pill" />}<span className="avatar" style={hueStyle(g.group_id)}>#</span><span className="conversation-body"><span className="conversation-name">{g.name}</span><span className="conversation-sub">{g.member_count} members</span></span></button>)
          : peers.filter(p => !p.is_blocked && p.peer_id !== identity.peer_id && p.display_name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.last_interaction - a.last_interaction).map(p => <button key={p.peer_id} className={`conversation ${selection?.id === p.peer_id ? "selected" : ""} ${p.unread_count > 0 ? "unread" : ""}`} onClick={() => setSelection({ kind: "peer", id: p.peer_id, name: p.display_name })} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, conversation: { kind: "peer", id: p.peer_id, name: p.display_name } }) }}>{p.unread_count > 0 && <span className="unread-pill" />}<span className="avatar" style={hueStyle(p.peer_id)}>{initialOf(p.display_name)}{p.is_online ? <span className="online-dot" /> : null}</span><span className="conversation-body"><span className="conversation-name">{p.display_name}</span><span className="conversation-sub">{p.is_online ? p.presence : "Offline"}{!p.is_friend && " · Not a friend"}</span></span></button>)}
      </nav>
      <footer className="user-panel"><span className="avatar sm" style={hueStyle(identity.peer_id ?? "?")}>{initialOf(identity.display_name ?? "")}{ready && !identity.dnd_enabled && <span className="online-dot" />}</span><span className="conversation-body"><span className="conversation-name">{identity.display_name ?? "Connecting…"}</span><span className="conversation-sub">{ready ? identity.dnd_enabled ? "Do not disturb" : "Connected" : "Disconnected"}</span></span><button className="icon-button" title={identity.dnd_enabled ? "Turn off Do not disturb" : "Turn on Do not disturb"} aria-label="Toggle do not disturb" onClick={() => run(async () => { await request("dnd", { enabled: !identity.dnd_enabled }); await refresh() })}>{identity.dnd_enabled ? "🔕" : "🔔"}</button><button className="icon-button" title="Settings" aria-label="Settings" onClick={() => setSettings(true)}>⚙</button></footer>
    </aside>
    <main>
      {error && <div role="alert" className="error">{error}<button onClick={() => setError("")}>Dismiss</button>{!ready && <button onClick={start}>Reconnect</button>}</div>}
      {!selection ? <div className="empty"><div className="brand-mark">◈</div><h1>{view === "dms" ? "No conversation selected" : "No group selected"}</h1><p>{view === "dms" ? "Pick someone from the list to start chatting, or invite a friend to a private room to connect remotely." : "Create a group or join one with an invite to get started."}</p><div className="actions">{view === "dms" ? <button onClick={() => setJoin("")}>Join with an invite</button> : <><button onClick={() => setJoin("")}>Join with an invite</button><button className="primary" onClick={() => setNewGroup("")}>Create a group</button></>}</div></div> : <>
        <header className="chat-header"><span className="channel-icon">{selection.kind === "group" ? "#" : "@"}</span><div className="conversation-body"><h1>{selection.name}</h1><span className="conversation-sub">{selection.kind === "group" ? `${members.length} members` : peer?.is_online ? `${peer.presence} · ${peer.active_transport ?? "connected"}` : "Offline · messages will be queued"}</span></div></header>
        {peer && peer.delivery_warnings?.length > 0 && <div className="notice">{peer.delivery_warnings.join(" · ").replaceAll("_", " ")}</div>}
        <section className="history" aria-label="Message history">
          {rows.map((row, index) => {
            const prev = rows[index - 1]
            const compact = !!prev && prev.type === "message" && row.type === "message" && prev.sender_id === row.sender_id && row.created_at - prev.created_at < 300
            const isOwn = row.sender_id === identity.peer_id
            const deliveries = (row.deliveries ?? []) as Row[]
            const deliveredCount = deliveries.filter(d => d.status === "delivered").length
            const quote = row.reply_to_message_id ? messages.find(m => m.message_id === row.reply_to_message_id) : undefined
            return <article key={`${row.type}:${row.message_id ?? row.file_id}`} className={`msg ${compact ? "compact" : ""} ${isOwn ? "own" : ""}`}>
              {!compact && <div className="msg-head"><span className="msg-author" style={hueStyle(row.sender_id ?? "?")}>{name(row.sender_id)}</span><span className="msg-time">{discordTime(row.created_at)}</span></div>}
              {compact && <span className="msg-hovtime" title={new Date(row.created_at * 1000).toLocaleString()}>{timeOf(row.created_at)}</span>}
              <div className="msg-body">
                {row.reply_to_message_id && <div className="msg-reply">↩ <strong>{quote ? name(quote.sender_id) : "Someone"}</strong> {quote?.content.slice(0, 120) ?? "an earlier message"}</div>}
                {row.type === "file"
                  ? <><div className="attachment-card"><span className="attachment-icon">📎</span><span className="conversation-body"><strong>{row.filename}</strong><span className="conversation-sub">{(row.file_size / 1024).toFixed(1)} KB · {row.status}</span></span><button onClick={() => run(() => invoke("save_file", { fileId: row.file_id }))}>Save</button>{["failed", "blocked", "queued"].includes(row.status) && <button onClick={() => run(() => request("file_retry", { file_id: row.file_id }))}>Retry</button>}</div>{row.caption && <p className="msg-text">{row.caption}</p>}</>
                  : <p className="msg-text">{row.content.replace(/<@([a-f0-9]+|everyone)>/g, (_: string, id: string) => `@${id === "everyone" ? "everyone" : name(id)}`)}</p>}
                {row.failed && <span className="msg-failed">Failed to send. <button onClick={() => edit(row.content)}>Restore to draft</button></span>}
                {row.pending && <span className="msg-state">Sending…</span>}
                {row.queued && !row.pending && <span className="msg-state">Queued — will send on reconnect</span>}
                {isOwn && deliveries.length > 0 && <button className="receipts" onClick={() => setExpanded(expanded === row.message_id ? undefined : row.message_id)}>✓✓ {deliveredCount}/{deliveries.length}{expanded === row.message_id ? " ▲" : ""}</button>}
                {expanded === row.message_id && <div className="receipt-list">{deliveries.map((d: Row) => <div key={d.recipient_id}>{d.display_name ?? name(d.recipient_id)} · {d.status}</div>)}</div>}
              </div>
              <div className="msg-hover"><button onClick={() => { if (row.type === "message") { setReply(row); composer.current?.focus() } }}>Reply</button></div>
            </article>
          })}
          <div ref={historyEnd} />
        </section>
        <div className="composer-area"><div className="typing-indicator" role="status">{typingNames.length > 0 ? `${typingNames.join(", ")} typing…` : ""}</div>{reply && <div className="reply-banner">Replying to {name(reply.sender_id)}: {reply.content.slice(0, 80)} <button onClick={() => setReply(undefined)}>×</button></div>}
          <div className="composer"><button className="composer-attach" aria-label="Attach files" disabled={!ready} onClick={() => run(async () => { await invoke("pick_files", { target: selection.id, group: selection.kind === "group", caption: "" }); await load(selection) })}>＋</button><textarea ref={composer} aria-label="Message" placeholder={selection.kind === "group" ? `Message #${selection.name}` : `Message @${selection.name}`} value={drafts[key] ?? ""} onChange={e => edit(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} /></div>
          {selection.kind === "group" && <select className="mention-select" aria-label="Mention member" value="" onChange={e => { edit(`${drafts[key] ?? ""}<@${e.target.value}> `); composer.current?.focus() }}><option value="">Mention someone…</option><option value="everyone">Everyone</option>{members.map(m => <option key={m.peer_id} value={m.peer_id}>{m.display_name}</option>)}</select>}
        </div>
      </>}
    </main>
    {menu && (() => {
      const conv = menu.conversation
      const isGroup = conv.kind === "group"
      const peerRow = !isGroup ? peers.find(p => p.peer_id === conv.id) : undefined
      const item = (label: string, action: () => Promise<unknown>, danger = false) => (
        <button key={label} className={`ctx-item ${danger ? "danger" : ""}`} onClick={() => { setMenu(null); void run(action) }}>{label}</button>
      )
      const muteSub = (
        <div className="ctx-sub" key="mute">
          <button className="ctx-item">Mute Conversation <span className="ctx-arrow">›</span></button>
          <div className="ctx-submenu">
            <button className="ctx-item" onClick={() => { setMenu(null); void run(() => request("unmute", target(conv))) }}>Unmute</button>
            <div className="ctx-sep" />
            {[["15 minutes", 900], ["1 hour", 3600], ["4 hours", 14400], ["8 hours", 28800], ["Permanent", 0]].map(([label, timeout]) => (
              <button key={label as string} className="ctx-item" onClick={() => { setMenu(null); void run(() => request("mute", { ...target(conv), timeout: timeout as number })) }}>{label}</button>
            ))}
          </div>
        </div>
      )
      const markRead = item("Mark As Read", async () => {
        if (!selected.current || conversationKey(selected.current) !== conversationKey(conv)) setSelection(conv)
        else await load(conv)
        await refresh()
      })
      return <div className="ctx-menu" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 232)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 320)) }} onClick={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
        {isGroup ? <>
          {markRead}
          <button className="ctx-item" onClick={() => { setMenu(null); void run(async () => { const result = await request("room_invite", { room_id: conv.id }); setJoin(result.invite) }) }}>Invites</button>
          {muteSub}
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { setMenu(null); void run(async () => { if (!await window.confirm(`Leave ${conv.name}? Your local history is kept.`)) return; await request("group_leave", { group_id: conv.id }); if (selected.current?.id === conv.id) setSelection(undefined); await refresh() }) }}>Leave Group</button>
        </> : <>
          {markRead}
          {peerRow && !peerRow.is_friend && !peerRow.is_blocked && item("Add Friend", async () => { await request("friend_send", { peer_id: conv.id }); await refresh() })}
          {peerRow?.is_friend && <button className="ctx-item danger" onClick={() => { setMenu(null); void run(async () => { if (!await window.confirm(`Remove ${conv.name} as a friend?`)) return; await request("unfriend", { peer_id: conv.id }); await refresh() }) }}>Remove Friend</button>}
          {muteSub}
          <div className="ctx-sep" />
          {peerRow?.is_blocked
            ? item("Unblock", async () => { await request("unblock_peer", { peer_id: conv.id }); await refresh() })
            : <button className="ctx-item danger" onClick={() => { setMenu(null); void run(async () => { if (!await window.confirm(`Block ${conv.name}? Their messages and requests will be dropped.`)) return; await request("block_peer", { peer_id: conv.id }); if (selected.current?.id === conv.id) setSelection(undefined); await refresh() }) }}>Block</button>}
        </>}
      </div>
    })()}
    {settings && <Settings selection={selection} onClose={() => setSettings(false)} onRefresh={refresh} theme={theme} onTheme={setTheme} />}
    {join !== null && <div className="overlay"><form className="dialog" onSubmit={e => { e.preventDefault(); void run(async () => { await request("room_join", { invite: join.trim() }); setJoin(null); await refresh() }) }}><h2>Room invite</h2><p>Paste an invite to join, or copy this invite to share your room.</p><textarea aria-label="Room invite" value={join} onChange={e => setJoin(e.target.value)} /><div className="actions"><button type="button" onClick={() => setJoin(null)}>Cancel</button><button className="primary">Join room</button></div></form></div>}
    {newGroup !== null && <div className="overlay"><form className="dialog" onSubmit={e => { e.preventDefault(); void run(async () => { const result = await request("room_create", { name: newGroup }); setNewGroup(null); setJoin(result.invite); await refresh() }) }}><h2>Create a group</h2><input aria-label="Group name" placeholder="Group name" required maxLength={80} value={newGroup} onChange={e => setNewGroup(e.target.value)} /><div className="actions"><button type="button" onClick={() => setNewGroup(null)}>Cancel</button><button className="primary">Create</button></div></form></div>}
    {closeChoice && <div className="overlay"><div className="dialog"><h2>Keep MeshTalk running?</h2><p>Stay in the tray to keep receiving messages, or quit completely. You can change this in Settings.</p><div className="actions"><button onClick={() => run(async () => { await invoke("preferences", { closeMode: "quit" }); await invoke("quit") })}>Quit on close</button><button className="primary" onClick={() => run(async () => { await invoke("preferences", { closeMode: "tray" }); setCloseChoice(false); await getCurrentWindow().hide() })}>Stay in tray</button></div></div></div>}
    {onboarding && <div className="overlay"><form className="dialog" onSubmit={e => { e.preventDefault(); void run(async () => { await request("set_display_name", { display_name: displayName }); await request("control", { url: remote ? PUBLIC_CONTROL : "", dismiss_setup: true }); await request("analytics", { level: analytics }); await request("notifications", { delivery: "native", setup_dismissed: true }); setOnboarding(false); await refresh() }) }}><div className="brand-mark">◈</div><h1>Welcome to MeshTalk</h1><p>Your identity lives on this device. Choose how people see you.</p><label>Display name<input required maxLength={48} value={displayName} onChange={e => setDisplayName(e.target.value)} /></label><label><input type="checkbox" checked={remote} onChange={e => setRemote(e.target.checked)} /> Enable remote discovery using the public control service</label><label>Optional analytics<select value={analytics} onChange={e => setAnalytics(e.target.value)}><option value="off">Off</option><option value="basic">Basic</option><option value="extended">Extended</option></select></label><p className="muted">LAN messaging works offline. The control service helps peers connect and relays encrypted traffic when needed.</p><button className="primary">Get started</button></form></div>}
  </div>
}
