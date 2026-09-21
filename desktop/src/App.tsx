import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { conversationKey, invoke, mergeMessages, request, sendTarget, target, type Conversation, type Row } from "./api"
import { Settings } from "./Settings"
import { Dialog } from "./components/Dialog"
import { People } from "./components/People"
import { QuickSwitcher } from "./components/QuickSwitcher"
import { Help } from "./components/Help"
import { Details } from "./components/Details"
import { Search } from "./components/Search"
import { MessageBody } from "./components/MessageBody"
import { AttachmentComposer, Files, ImagePreview, formatSize, type AttachmentBatch, type StagedFile } from "./components/Attachments"
import { conversations, groupFiles, isMuted, mentionAt, MAX_MESSAGE_BYTES, persist, restore } from "./chatState"
import { Icon } from "./components/Icon"
import { MessageStatus } from "./components/MessageStatus"

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
function messageTime(createdAt: number) {
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
  const [selection, setSelection] = useState<Conversation | undefined>(() => restore("meshtalk-selection", undefined))
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
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("meshtalk-appearance") ?? "light" } catch { return "light" } })
  const [menu, setMenu] = useState<{ x: number; y: number; conversation: Conversation } | null>(null)
  const [settings, setSettings] = useState(false)
  const [join, setJoin] = useState<string | null>(null)
  const [shareInvite, setShareInvite] = useState<string>()
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [closeChoice, setCloseChoice] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [remote, setRemote] = useState(true)
  const [analytics, setAnalytics] = useState("off")
  const [typing, setTyping] = useState<Record<string, Row>>({})
  const [panel, setPanel] = useState<"people" | "files" | "quick" | "help" | "details" | "search">()
  const [batch, setBatch] = useState<AttachmentBatch>()
  const batchRef = useRef(batch)
  batchRef.current = batch
  const [image, setImage] = useState<Row>()
  const [deleting, setDeleting] = useState<Row>()
  const [confirming, setConfirming] = useState<{ title: string; detail: string; action: () => Promise<void> }>()
  const [friendCount, setFriendCount] = useState(0)
  const [muted, setMuted] = useState<Row>({})
  const [favorites, setFavorites] = useState<string[]>(() => restore("meshtalk-favorites", []))
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const [unreadBoundary, setUnreadBoundary] = useState<string>()
  const [archive, setArchive] = useState(false)
  const archiveRef = useRef(false)
  const [before, setBefore] = useState<number | null>(null)
  const jumpTarget = useRef<string | undefined>(undefined)
  const [mention, setMention] = useState<ReturnType<typeof mentionAt>>()
  const [mentionIndex, setMentionIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const draftsReady = useRef(false)
  const draftPersistence = useRef(false)
  const history = useRef<HTMLElement>(null)
  const atBottom = useRef(true)
  const scrollPositions = useRef<Record<string, number>>({})
  const sendQueues = useRef(new Map<string, Promise<unknown>>())
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
    const [p, g, i, f, m] = await Promise.all([request("peers"), request("groups"), request("identity"), request("friend_requests"), request("muted_peers")])
    setPeers(p.peers); setGroups(g.groups); setIdentity(i)
    setFriendCount(f.requests.filter((r: Row) => r.direction === "incoming").length); setMuted(m)
  }, [])

  const load = useCallback(async (conversation: Conversation) => {
    const key = conversationKey(conversation)
    const [history, attachments, roster] = await Promise.all([
      request(conversation.kind === "group" ? "group_messages" : "messages", target(conversation)),
      request("files", target(conversation)),
      conversation.kind === "group" ? request("group_members", target(conversation)) : Promise.resolve({ members: [] }),
    ])
    cache.current[key] = mergeMessages(history.messages, cache.current[key] ?? [])
    if (selected.current && conversationKey(selected.current) === key && !archiveRef.current) {
      setMessages(cache.current[key]); setFiles(attachments.files); setMembers(roster.members)
    }
  }, [])

  const start = useCallback(async () => {
    setError("")
    try {
      await invoke("connect_backend")
      await refresh()
      if (!draftsReady.current) {
        try {
          const stored = await request("desktop_drafts")
          setDrafts(current => ({ ...stored.drafts, ...current }))
          draftPersistence.current = true
        } catch {
          // Older shared backends can still send messages; draft persistence is optional.
          draftPersistence.current = false
        }
        draftsReady.current = true
      }
      const i = await request("identity")
      setDisplayName(i.display_name === "Anonymous" ? "" : i.display_name)
      setOnboarding(!i.setup_dismissed)
      await request("tui_presence", { client_id: clientId, active: document.hasFocus() })
      setReady(true)
      if (selected.current) void load(selected.current).catch(e => setError(String(e)))
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
           if (selected.current && focusRef.current && !archiveRef.current) void load(selected.current).catch(e => setError(String(e)))
          if (["message", "group_message", "friend_request", "file_offer", "file_completed"].includes(payload.event) && !focusRef.current) {
            void (async () => {
              const [prefs, mute, me] = await Promise.all([request("notifications"), request("muted_peers"), request("identity")])
              const category = payload.event.includes("message") ? "messages" : payload.event === "friend_request" ? "friend_requests" : payload.event === "file_offer" ? "file_offers" : "file_completed"
              const until = payload.group_id ? mute.muted_groups?.[payload.group_id] : mute.muted_peers?.[payload.sender_id]
              const muted = until !== undefined && (until === 0 || until > Date.now() / 1000)
               const mentioned = payload.group_id && (payload.mentions ?? []).some((id: string) => id === me.peer_id || id === "everyone")
               if (!me.dnd_enabled && (!muted || mentioned) && prefs.delivery !== "disabled" && prefs.events?.[category]) {
                await invoke("notify", { title: category === "messages" ? "You have a new message" : category === "friend_requests" ? "New friend request" : "File transfer updated" })
              }
            })().catch(() => {})
          }
        }),
        listen("backend-disconnected", () => { setReady(false); setError("Backend disconnected. Reconnect to continue.") }),
        listen<string[]>("invite-links", ({ payload }) => { const invite = payload.find(url => /^(meshtalk|meshtalk-group):/.test(url)); if (invite) setJoin(invite) }),
        listen("choose-close-mode", () => setCloseChoice(true)),
        listen<{ files: StagedFile[] }>("attachments-staged", ({ payload }) => {
          if (!selected.current || batchRef.current || !payload.files.length) { void invoke("discard_attachments", { tokens: payload.files.map(f => f.token) }); if (!selected.current) setError("Choose a conversation before dropping files."); return }
          setBatch({ conversation: selected.current, files: payload.files })
        }),
        listen<string>("attachment-error", ({ payload }) => setError(payload)),
        listen<string>("desktop-action", ({ payload }) => {
          if (payload === "settings") setSettings(true)
          else if (["quick", "search", "people", "files", "help"].includes(payload)) setPanel(payload as "quick")
          else if (payload === "new-group") setNewGroup("")
          else if (payload === "join") setJoin("")
        }),
      ])
      if (cancelled) { subscriptions.forEach(unlisten => unlisten()); return }
      cleanups.push(...subscriptions)
      await start()
    }
    void setup().catch(e => setError(String(e)))
    return () => { cancelled = true; cleanups.forEach(unlisten => unlisten()) }
  }, [start, refresh, load])

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? system.matches ? "dark" : "light" : theme }
    apply(); system.addEventListener("change", apply)
    try { localStorage.setItem("meshtalk-appearance", theme) } catch {}
    return () => system.removeEventListener("change", apply)
  }, [theme])

  useEffect(() => { persist("meshtalk-selection", selection) }, [selection])
  useEffect(() => { persist("meshtalk-favorites", favorites) }, [favorites])
  useEffect(() => {
    if (!ready || !draftPersistence.current) return
    const timer = setTimeout(() => { void request("desktop_drafts", { drafts }).catch(e => setError(`Could not save drafts: ${String(e)}`)) }, 400)
    return () => clearTimeout(timer)
  }, [drafts, ready])
  useEffect(() => { document.documentElement.dataset.motion = identity.flashing_enabled === false ? "reduced" : "full" }, [identity.flashing_enabled])

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
    setMention(undefined); setUnreadBoundary(undefined); setArchive(false); archiveRef.current = false; setBefore(null)
    atBottom.current = true; setNewBelow(false)
    if (selection) {
      const c = selection
      const unread = c.kind === "group" ? groups.find(g => g.group_id === c.id)?.unread_count : peers.find(p => p.peer_id === c.id)?.unread_count
      setMessages(cache.current[conversationKey(c)] ?? [])
      void run(async () => {
        await load(c)
        if (selected.current && conversationKey(selected.current) === conversationKey(c)) {
          if (unread > 0) setUnreadBoundary(cache.current[conversationKey(c)]?.filter(m => m.sender_id !== identityRef.current.peer_id).slice(-unread)[0]?.message_id)
          const scroll = scrollPositions.current[conversationKey(c)]
          if (scroll !== undefined) requestAnimationFrame(() => { if (history.current) { history.current.scrollTop = scroll; atBottom.current = history.current.scrollHeight - scroll - history.current.clientHeight < 80 } })
        }
      })
    }
    else setMessages([])
    return () => {
      if (selection && history.current) scrollPositions.current[conversationKey(selection)] = history.current.scrollTop
      if (typingTimer.current) clearTimeout(typingTimer.current)
      if (selection && ready) void request("typing", { ...sendTarget(selection), client_id: clientId, is_typing: false }).catch(() => {})
    }
  }, [selection?.id, selection?.kind, ready, load])

  useEffect(() => {
    if (archiveRef.current) return
    if (atBottom.current) {
      historyEnd.current?.scrollIntoView({ behavior: "auto" })
    } else setNewBelow(true)
  }, [messages.length, files.length])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]") || event.defaultPrevented) return
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettings(true) }
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); setPanel("quick") }
      if (mod && event.key.toLowerCase() === "f") { event.preventDefault(); setPanel(event.shiftKey ? "files" : "search") }
      if (mod && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); setPanel("people") }
      if (mod && event.key === "/") { event.preventDefault(); setPanel("help") }
      if (mod && event.key.toLowerCase() === "u") { event.preventDefault(); void chooseFiles() }
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault()
        const all = conversations(peers, groups, identity.peer_id)
        const index = all.findIndex(c => selected.current && conversationKey(c) === conversationKey(selected.current))
        if (all.length) chooseConversation(all[(index + (event.key === "ArrowDown" ? 1 : all.length - 1)) % all.length])
      }
      if (event.key === "Escape") { setSettings(false); setJoin(null); setNewGroup(null); setReply(undefined); setCloseChoice(false); setMenu(null) }
    }
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [peers, groups, identity.peer_id])

  function chooseConversation(c: Conversation) { setView(c.kind === "group" ? "groups" : "dms"); setSelection(c) }
  async function chooseFiles() {
    const c = selected.current
    if (!c || batchRef.current) return
    await run(async () => { const result = await invoke<{ files: StagedFile[] }>("choose_attachments"); if (result.files.length) setBatch({ conversation: c, files: result.files }) })
  }
  async function pasteFiles(items: File[]) {
    if (!selection || batchRef.current || !items.length) return
    const staged: StagedFile[] = []
    try {
      for (const file of items.slice(0, 32)) {
        if (file.size > 8 * 1024 * 1024) throw new Error("Paste supports files up to 8 MB. Use Attach for larger files.")
        const result = await invoke<{ files: StagedFile[] }>("paste_attachment", { name: file.name || "pasted-image.png", bytes: Array.from(new Uint8Array(await file.arrayBuffer())) })
        staged.push(...result.files)
      }
      setBatch({ conversation: selection, files: staged })
    } catch (e) { await invoke("discard_attachments", { tokens: staged.map(f => f.token) }); setError(String(e)) }
  }
  async function copy(text: string) { await run(async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }) }
  async function jump(c: Conversation, id: string) {
    jumpTarget.current = id; chooseConversation(c)
    // Applied after the selection's ordinary history load to avoid stale updates.
  }
  useEffect(() => {
    if (!selection || !jumpTarget.current) return
    const id = jumpTarget.current; jumpTarget.current = undefined
    const c = selection
    archiveRef.current = true; setArchive(true)
    void run(async () => {
      const result = await request("history_page", { ...target(c), around: id })
      if (!selected.current || conversationKey(c) !== conversationKey(selected.current)) return
      setMessages(result.messages); setBefore(result.next_before)
      requestAnimationFrame(() => document.getElementById(`message-${id}`)?.scrollIntoView({ block: "center" }))
    })
  }, [selection])
  async function older() {
    if (!selection) return
    const c = selection
    await run(async () => {
      const result = await request("history_page", { ...target(c), ...(before ? { before } : {}) })
      if (!selected.current || conversationKey(c) !== conversationKey(selected.current)) return
      archiveRef.current = true; setArchive(true); setBefore(result.next_before)
      setMessages(current => { const ids = new Set(current.map(m => m.message_id)); return [...result.messages.filter((m: Row) => !ids.has(m.message_id)), ...current].sort((a, b) => a.created_at - b.created_at) })
    })
  }

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
    if (!selection || !ready) return
    const conversation = selection
    const key = conversationKey(conversation)
    const content = (drafts[key] ?? "").trim()
    if (!content) return
    if (new TextEncoder().encode(content).length > MAX_MESSAGE_BYTES) { setError("Message is too long (30 KB maximum)."); return }
    const row: Row = { message_id: `local:${crypto.randomUUID()}`, sender_id: identity.peer_id, content, created_at: Date.now() / 1000, pending: true, reply_to_message_id: reply?.message_id }
    cache.current[key] = [...(cache.current[key] ?? []), row]
    setMessages(cache.current[key]); setDrafts(current => ({ ...current, [key]: "" })); setReply(undefined); setMention(undefined)
    const previous = sendQueues.current.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
    try {
      const result = await request(conversation.kind === "group" ? "group_send" : "send", { ...sendTarget(conversation), content, reply_to_message_id: row.reply_to_message_id })
      cache.current[key] = cache.current[key].map(m => m.message_id === row.message_id ? { ...row, ...result, pending: false } : m)
      await load(conversation); await refresh()
    } catch (e) {
      cache.current[key] = cache.current[key].map(m => m.message_id === row.message_id ? { ...m, pending: false, failed: true } : m)
      if (selected.current && conversationKey(selected.current) === key) setMessages(cache.current[key])
      setError(String(e))
    } finally { if (selected.current && conversationKey(selected.current) === key) composer.current?.focus() }
    })
    sendQueues.current.set(key, task)
    void task.finally(() => { if (sendQueues.current.get(key) === task) sendQueues.current.delete(key) })
  }

  const key = selection ? conversationKey(selection) : ""
  const peer = peers.find(p => p.peer_id === selection?.id)
  const deliveryWarnings = (peer?.delivery_warnings ?? []).filter((warning: string) => warning !== "limited")
  const dmUnread = peers.filter(p => p.unread_count > 0).length
  const groupUnread = groups.filter(g => g.unread_count > 0).length
  const rows: Row[] = [...messages.map((message): Row => ({ ...message, type: "message" })), ...groupFiles(files).map((file): Row => ({ ...file, type: "file" }))].sort((a, b) => a.created_at - b.created_at)
  const name = (id: string) => id === identity.peer_id ? "You" : peers.find(p => p.peer_id === id)?.display_name ?? members.find(m => m.peer_id === id)?.display_name ?? id.slice(0, 10)
  const typingNames = Object.entries(typing).filter(([id, value]) => id.startsWith(`${key}:`) && value.is_typing && value.expires > Date.now()).map(([, value]) => name(value.sender_id))
  const allConversations = conversations(peers, groups, identity.peer_id)
  const mentionChoices = mention && selection?.kind === "group" ? [{ peer_id: "everyone", display_name: "everyone" }, ...members].filter(m => m.display_name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 20) : []
  function insertMention(index: number) {
    if (!mention || !mentionChoices[index]) return
    const text = drafts[key] ?? ""
    const token = `<@${mentionChoices[index].peer_id ?? mentionChoices[index].member_id}> `
    edit(text.slice(0, mention.start) + token + text.slice(mention.end)); setMention(undefined)
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(mention.start + token.length, mention.start + token.length) })
  }
  function toggleFavorite(c: Conversation) { const k = conversationKey(c); setFavorites(current => current.includes(k) ? current.filter(id => id !== k) : [...current, k]) }
  useEffect(() => { void invoke("unread_badge", { count: dmUnread + groupUnread }).catch(() => {}) }, [dmUnread, groupUnread])

  return <div className="app messenger">
    <nav className="rail" aria-label="Views">
      <button className={`rail-btn ${view === "dms" ? "selected" : ""}`} title="Direct Messages" aria-label="Direct Messages" onClick={() => setView("dms")}><Icon name="messages" />{dmUnread > 0 && <span className="rail-dot" />}</button>
      <button className={`rail-btn ${view === "groups" ? "selected" : ""}`} title="Groups" aria-label="Groups" onClick={() => setView("groups")}><Icon name="group" />{groupUnread > 0 && <span className="rail-dot" />}</button>
    </nav>
    <aside className="sidebar">
      <div className="list-head"><h2>{view === "dms" ? "Messages" : "Groups"}</h2><div className="sidebar-tools"><button className="icon-button" title="Jump to…" aria-label="Quick switcher" onClick={() => setPanel("quick")}><Icon name="search" /></button><button className="icon-button" title="People" aria-label={`People, ${friendCount} friend requests`} onClick={() => setPanel("people")}><Icon name="people" />{friendCount > 0 && <span className="count-badge">{friendCount}</span>}</button></div></div>
      <div className="search"><input aria-label="Search conversations" placeholder={view === "dms" ? "Find a conversation" : "Find a group"} value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="list-filters"><button aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All</button><button aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Unread</button></div>
      <div className="sidebar-actions"><button onClick={() => setNewGroup("")}><Icon name="plus" size={15} /> New group</button><button onClick={() => setJoin("")}><Icon name="invite" size={15} /> Join</button><button title="Files & transfers" aria-label="Files and transfers" onClick={() => setPanel("files")}><Icon name="files" size={15} /></button><button title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => setPanel("help")}><Icon name="help" size={15} /></button></div>
      <nav aria-label="Conversations">
        {allConversations.filter(c => (c.kind === "group") === (view === "groups") && c.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(favorites.includes(conversationKey(b))) - Number(favorites.includes(conversationKey(a))) || (peers.find(p => p.peer_id === b.id)?.last_interaction ?? 0) - (peers.find(p => p.peer_id === a.id)?.last_interaction ?? 0)).map(c => {
          const k = conversationKey(c)
          const item = c.kind === "group" ? groups.find(g => g.group_id === c.id)! : peers.find(p => p.peer_id === c.id)!
          if (unreadOnly && !item.unread_count && !item.mention_unread_count) return null
          const mute = isMuted((c.kind === "group" ? muted.muted_groups : muted.muted_peers)?.[c.id])
          const unread = item.unread_count > 0 && (!mute || item.mention_unread_count > 0)
          const cached = cache.current[k]?.at(-1)
          const typingNow = Object.entries(typing).some(([id, value]) => id.startsWith(`${k}:`) && value.is_typing && value.expires > Date.now())
          return <button key={k} className={`conversation ${key === k ? "selected" : ""} ${unread ? "unread" : ""}`} onClick={() => { chooseConversation(c); setUnreadBoundary(undefined) }} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, conversation: c }) }}>
            <span className="avatar" style={hueStyle(c.id)}>{c.kind === "group" ? "#" : initialOf(c.name)}{item.is_online ? <span className={`online-dot ${item.dnd ? "dnd" : item.presence === "away" ? "away" : ""}`} /> : null}</span>
            <span className="conversation-body"><span className="conversation-name">{favorites.includes(k) && "★ "}{c.name}</span><span className="conversation-sub">{typingNow ? "Typing…" : drafts[k] ? `Draft: ${drafts[k]}` : cached ? `${cached.failed ? "Failed: " : cached.queued ? "Queued: " : ""}${cached.content}` : c.kind === "group" ? `${item.member_count} members` : item.is_online ? item.dnd ? "Do not disturb" : item.presence : "Offline"}</span><span className="conversation-sub">{mute && "Muted · "}{item.capability_gap && "Limited · "}{item.friend_request && `${item.friend_request} request`}{item.mention_unread_count > 0 && ` @${item.mention_unread_count}`}</span></span>
            <span className="conversation-meta">{cached && <small>{timeOf(cached.created_at)}</small>}{unread && <span className="count-badge">{item.unread_count}</span>}</span>
          </button>
        })}
      </nav>
       <footer className="user-panel"><span className="avatar sm" style={hueStyle(identity.peer_id ?? "?")}>{initialOf(identity.display_name ?? "")}{ready && !identity.dnd_enabled && <span className="online-dot" />}</span><span className="conversation-body"><span className="conversation-name">{identity.display_name ?? "Connecting…"}</span><span className="conversation-sub">{ready ? identity.dnd_enabled ? "Do not disturb" : "Connected" : "Disconnected"}</span></span><button className="icon-button" title={identity.dnd_enabled ? "Turn off Do not disturb" : "Turn on Do not disturb"} aria-label="Toggle do not disturb" onClick={() => run(async () => { await request("dnd", { enabled: !identity.dnd_enabled }); await refresh() })}><Icon name="bell" /></button><button className="icon-button" title="Settings" aria-label="Settings" onClick={() => setSettings(true)}><Icon name="settings" /></button></footer>
    </aside>
    <main>
      {error && <div role="alert" className="error">{error}<button onClick={() => setError("")}>Dismiss</button>{!ready && <button onClick={start}>Reconnect</button>}</div>}
      {!selection ? <div className="empty"><div className="brand-mark">◈</div><h1>{view === "dms" ? "No conversation selected" : "No group selected"}</h1><p>{view === "dms" ? "Pick someone from the list to start chatting, or invite a friend to a private room to connect remotely." : "Create a group or join one with an invite to get started."}</p><div className="actions">{view === "dms" ? <button onClick={() => setJoin("")}>Join with an invite</button> : <><button onClick={() => setJoin("")}>Join with an invite</button><button className="primary" onClick={() => setNewGroup("")}>Create a group</button></>}</div></div> : <>
        <header className="chat-header"><span className="channel-icon">{selection.kind === "group" ? "#" : "@"}</span><div className="conversation-body"><h1>{selection.name}</h1><span className="conversation-sub">{selection.kind === "group" ? `${members.length} members` : peer?.is_online ? `${peer.presence} · ${peer.active_transport ?? "connected"}` : "Offline · messages will be queued"}</span></div><div className="actions"><button className="icon-button" title="Search messages" aria-label="Search messages" onClick={() => setPanel("search")}><Icon name="search" /></button><button className="icon-button" onClick={() => toggleFavorite(selection)} aria-label="Favorite conversation" aria-pressed={favorites.includes(key)} title="Favorite conversation"><Icon name="star" fill={favorites.includes(key) ? "currentColor" : "none"} /></button><button className="icon-button" title="Conversation details" aria-label="Conversation details" onClick={() => setPanel("details")}><Icon name="details" /></button></div></header>
        {Boolean(peer?.capability_gap) && <div className="capability-note">Some newer features may be unavailable with this contact.</div>}
        {peer && !peer.is_friend && <div className="notice">{peer.friend_request ? `${peer.friend_request} friend request` : "Not yet friends"}<button onClick={() => setPanel("people")}>Manage in People</button></div>}
        {deliveryWarnings.length > 0 && <div className="notice">{deliveryWarnings.join(" · ").replaceAll("_", " ")}</div>}
        <section ref={history} className="history" aria-label="Message history" tabIndex={0} onScroll={() => { const el = history.current; if (el) { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (atBottom.current) setNewBelow(false) } }}>
          {(!archive || before !== null) && <button className="history-more" onClick={() => older()}>Load older messages</button>}
          {rows.map((row, index) => {
            const prev = rows[index - 1]
            const compact = !!prev && prev.type === "message" && row.type === "message" && prev.sender_id === row.sender_id && row.created_at - prev.created_at < 300 && new Date(prev.created_at * 1000).toDateString() === new Date(row.created_at * 1000).toDateString()
            const isOwn = row.sender_id === identity.peer_id
            const quote = row.reply_to_message_id ? rows.find(m => (m.message_id ?? m.file_id) === row.reply_to_message_id) : undefined
            const dateChanged = !prev || new Date(prev.created_at * 1000).toDateString() !== new Date(row.created_at * 1000).toDateString()
            return <Fragment key={`${row.type}:${row.message_id ?? row.file_id}`}>
              {dateChanged && <div className="date-divider">{new Date(row.created_at * 1000).toLocaleDateString([], { dateStyle: "long" })}</div>}
              {row.message_id === unreadBoundary && <div className="date-divider unread-divider">New messages</div>}
              <article id={`message-${row.message_id ?? row.file_id}`} tabIndex={0} className={`msg ${compact ? "compact" : ""} ${isOwn ? "own" : ""}`}>
              {!compact && !isOwn && <span className="msg-avatar avatar" style={hueStyle(row.sender_id ?? "?")}>{initialOf(name(row.sender_id))}</span>}
              {!compact && <div className="msg-head">{!isOwn && <span className="msg-author">{name(row.sender_id)}</span>}<span className="msg-time" title={new Date(row.created_at * 1000).toLocaleString()}>{timeOf(row.created_at)}</span></div>}
              {compact && <span className="msg-hovtime" title={new Date(row.created_at * 1000).toLocaleString()}>{timeOf(row.created_at)}</span>}
              <div className="msg-body">
                {row.reply_to_message_id && <button className="msg-reply" onClick={() => { if (quote) document.getElementById(`message-${row.reply_to_message_id}`)?.scrollIntoView({ block: "center" }); else void jump(selection, row.reply_to_message_id) }}>↩ <strong>{quote ? name(quote.sender_id) : "Someone"}</strong> {(quote?.content ?? quote?.filename)?.slice(0, 120) ?? "an earlier message"}</button>}
                {row.type === "file"
                  ? <><div className="attachment-card"><span className="attachment-icon"><Icon name="files" /></span><span className="conversation-body"><strong>{row.filename}</strong><span className="conversation-sub">{formatSize(row.file_size)} · {row.status}</span>{row.total_chunks > 0 && <progress aria-label="Transfer progress" max={row.total_chunks} value={row.received_chunks ?? 0} />}</span><button onClick={() => run(() => invoke("save_file", { fileId: row.file_id }))}>Save</button>{/\.(png|jpe?g|gif|webp)$/i.test(row.filename) && <button onClick={() => setImage(row)}>Preview</button>}{["failed", "blocked", "queued"].includes(row.status) && <button onClick={() => run(() => request("file_retry", { file_id: row.file_id }))}>Retry</button>}</div>{row.caption && <p className="msg-text">{row.caption}</p>}</>
                  : <MessageBody content={row.content} name={name} />}
                <MessageStatus message={row} own={isOwn} restore={() => edit(row.content)} name={name} />
              </div>
              <div className="msg-hover"><button title="Reply" aria-label="Reply" onClick={() => { setReply({ ...row, message_id: row.message_id ?? row.file_id, content: row.content ?? row.filename }); composer.current?.focus() }}><Icon name="reply" size={16} /></button><button title="Copy" aria-label="Copy" onClick={() => copy(row.content ?? row.filename)}><Icon name="copy" size={16} /></button>{!row.pending && <button title="Delete locally" aria-label="Delete locally" onClick={() => setDeleting(row)}><Icon name="trash" size={16} /></button>}</div>
            </article></Fragment>
          })}
          <div ref={historyEnd} />
        </section>
        {(newBelow || archive) && <button className="jump-latest" onClick={() => { archiveRef.current = false; setArchive(false); setBefore(null); atBottom.current = true; setNewBelow(false); void run(() => load(selection)); historyEnd.current?.scrollIntoView() }}>{archive ? "Return to latest messages" : "New messages ↓"}</button>}
        <div className="composer-area"><div className="typing-indicator" role="status">{typingNames.length > 0 ? `${typingNames.join(", ")} typing…` : ""}</div>{reply && <div className="reply-banner">Replying to {name(reply.sender_id)}: {reply.content.slice(0, 80)} <button onClick={() => setReply(undefined)}>×</button></div>}
          {mentionChoices.length > 0 && <div className="mention-picker" role="listbox" aria-label="Mention suggestions">{mentionChoices.map((m, i) => <button key={m.peer_id ?? m.member_id} role="option" aria-selected={i === mentionIndex} className={i === mentionIndex ? "selected" : ""} onClick={() => insertMention(i)}>@{m.display_name}</button>)}</div>}
          <div className="composer"><button className="composer-attach" aria-label="Attach files" disabled={!ready} onClick={() => chooseFiles()}><Icon name="attach" /></button><textarea rows={1} ref={composer} aria-label="Message" placeholder={`Message ${selection.name}`} value={drafts[key] ?? ""} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void pasteFiles(files) } }} onChange={e => { edit(e.target.value); setMention(mentionAt(e.target.value, e.target.selectionStart)); setMentionIndex(0); e.target.style.height = "auto"; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px` }} onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (mentionChoices.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMentionIndex(i => (i + (e.key === "ArrowDown" ? 1 : mentionChoices.length - 1)) % mentionChoices.length); return }
              if (e.key === "Tab" || e.key === "Enter" && !e.shiftKey) { e.preventDefault(); insertMention(mentionIndex); return }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMention(undefined); return }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send() }
          }} /><button className="composer-send" aria-label="Send message" title="Send message" disabled={!ready || !(drafts[key] ?? "").trim()} onClick={() => send()}><Icon name="send" /></button></div>
          <small className="composer-hint">{ready ? "Shift+Enter for a new line" : <>Not connected. <button onClick={start}>Reconnect</button></>}{new TextEncoder().encode(drafts[key] ?? "").length > MAX_MESSAGE_BYTES * .9 && ` · ${new TextEncoder().encode(drafts[key] ?? "").length.toLocaleString()}/${MAX_MESSAGE_BYTES.toLocaleString()} bytes`}</small>
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
        <button className="ctx-item" onClick={() => { toggleFavorite(conv); setMenu(null) }}>{favorites.includes(conversationKey(conv)) ? "Remove favorite" : "Add favorite"}</button>
        {isGroup ? <>
          {markRead}
           <button className="ctx-item" onClick={() => { setMenu(null); void run(async () => { const result = await request("room_invite", { room_id: conv.id }); setShareInvite(result.invite) }) }}>Share invite</button>
          {muteSub}
          <div className="ctx-sep" />
           <button className="ctx-item danger" onClick={() => { setMenu(null); setConfirming({ title: `Leave ${conv.name}?`, detail: "Your local history is kept, but you will stop receiving new group activity.", action: async () => { await request("group_leave", { group_id: conv.id }); if (selected.current?.id === conv.id) setSelection(undefined); await refresh() } }) }}>Leave Group</button>
        </> : <>
          {markRead}
          {peerRow && !peerRow.is_friend && !peerRow.is_blocked && item("Add Friend", async () => { await request("friend_send", { peer_id: conv.id }); await refresh() })}
           {peerRow?.is_friend && <button className="ctx-item danger" onClick={() => { setMenu(null); setConfirming({ title: `Remove ${conv.name}?`, detail: "You can send another friend request later.", action: async () => { await request("unfriend", { peer_id: conv.id }); await refresh() } }) }}>Remove Friend</button>}
          {muteSub}
          <div className="ctx-sep" />
          {peerRow?.is_blocked
            ? item("Unblock", async () => { await request("unblock_peer", { peer_id: conv.id }); await refresh() })
            : <button className="ctx-item danger" onClick={() => { setMenu(null); setConfirming({ title: `Block ${conv.name}?`, detail: "Their messages and friend requests will be dropped until you unblock them.", action: async () => { await request("block_peer", { peer_id: conv.id }); if (selected.current?.id === conv.id) setSelection(undefined); await refresh() } }) }}>Block</button>}
        </>}
      </div>
    })()}
    {settings && <Settings selection={selection} onClose={() => setSettings(false)} onRefresh={refresh} theme={theme} onTheme={setTheme} />}
    {join !== null && <div className="overlay"><form className="dialog" onSubmit={e => { e.preventDefault(); void run(async () => { await request("room_join", { invite: join.trim() }); setJoin(null); await refresh() }) }}><h2>Room invite</h2><p>Paste an invite to join, or copy this invite to share your room.</p><textarea aria-label="Room invite" value={join} onChange={e => setJoin(e.target.value)} /><div className="actions"><button type="button" onClick={() => setJoin(null)}>Cancel</button><button className="primary">Join room</button></div></form></div>}
    {newGroup !== null && <div className="overlay"><form className="dialog" onSubmit={e => { e.preventDefault(); void run(async () => { const result = await request("room_create", { name: newGroup }); setNewGroup(null); setShareInvite(result.invite); await refresh(); if (result.group_id) chooseConversation({ kind: "group", id: result.group_id, name: newGroup }) }) }}><h2>Create a group</h2><input aria-label="Group name" placeholder="Group name" required maxLength={80} value={newGroup} onChange={e => setNewGroup(e.target.value)} /><div className="actions"><button type="button" onClick={() => setNewGroup(null)}>Cancel</button><button className="primary">Create</button></div></form></div>}
    {shareInvite && <Dialog title="Share room invite" onClose={() => setShareInvite(undefined)}><p>Send this invite to someone you want to connect with.</p><textarea readOnly aria-label="Invite to share" value={shareInvite} /><button className="primary" onClick={() => copy(shareInvite)}>Copy invite</button></Dialog>}
    {panel === "people" && <People onClose={() => setPanel(undefined)} onSelect={chooseConversation} onRefresh={refresh} />}
    {panel === "files" && <Files onClose={() => setPanel(undefined)} onPreview={setImage} onRefresh={async () => { await refresh(); if (selection) await load(selection) }} />}
    {panel === "details" && selection && <Details conversation={selection} members={members} peers={peers} identity={identity} onClose={() => setPanel(undefined)} onSelect={chooseConversation} onRefresh={refresh} />}
    {panel === "help" && <Help onClose={() => setPanel(undefined)} />}
    {panel === "search" && <Search conversations={allConversations} selection={selection} onClose={() => setPanel(undefined)} onJump={jump} />}
    {panel === "quick" && <QuickSwitcher onClose={() => setPanel(undefined)} actions={[
      ...allConversations.map(c => ({ id: conversationKey(c), label: c.name, detail: c.kind === "group" ? "Group" : "Direct message", run: () => chooseConversation(c) })),
      ...(["people", "files", "help", "search"] as const).map(p => ({ id: p, label: p === "people" ? "People and friend requests" : p === "files" ? "Files & transfers" : p === "search" ? "Search messages" : "Keyboard shortcuts", detail: "Action", run: () => setPanel(p) })),
      { id: "settings", label: "Settings", detail: "Action", run: () => setSettings(true) }, { id: "create", label: "Create group", detail: "Action", run: () => setNewGroup("") }, { id: "join", label: "Join with invite", detail: "Action", run: () => setJoin("") },
    ]} />}
    {batch && <AttachmentComposer batch={batch} onClose={() => setBatch(undefined)} onSent={load} />}
    {image && <ImagePreview file={image} onClose={() => setImage(undefined)} />}
    {deleting && <Dialog title="Delete locally?" onClose={() => setDeleting(undefined)}><p>This removes the message or attachment from this device. Other people's copies are retained.</p><div className="actions"><button onClick={() => setDeleting(undefined)}>Cancel</button><button className="danger" onClick={() => run(async () => {
      const row = deleting
      if (!row.failed || !String(row.message_id).startsWith("local:")) await request("delete_message", { message_id: row.message_id ?? row.file_id, group_id: selection?.kind === "group" ? selection.id : undefined, file: row.type === "file" })
      if (selection) { cache.current[key] = (cache.current[key] ?? []).filter(m => m.message_id !== row.message_id); await load(selection) }
      setDeleting(undefined)
    })}>Delete locally</button></div></Dialog>}
    {confirming && <Dialog title={confirming.title} onClose={() => setConfirming(undefined)}><p>{confirming.detail}</p><div className="actions"><button onClick={() => setConfirming(undefined)}>Cancel</button><button className="danger" onClick={() => { const action = confirming.action; setConfirming(undefined); void run(action) }}>Continue</button></div></Dialog>}
    {copied && <div className="toast" role="status">Copied to clipboard</div>}
    {closeChoice && <div className="overlay"><div className="dialog"><h2>Keep MeshTalk running?</h2><p>Stay in the tray to keep receiving messages, or quit completely. You can change this in Settings.</p><div className="actions"><button onClick={() => run(async () => { await invoke("preferences", { closeMode: "quit" }); await invoke("quit") })}>Quit on close</button><button className="primary" onClick={() => run(async () => { await invoke("preferences", { closeMode: "tray" }); setCloseChoice(false); await getCurrentWindow().hide() })}>Stay in tray</button></div></div></div>}
    {onboarding && <div className="overlay"><form className="dialog" onSubmit={e => { e.preventDefault(); void run(async () => { await request("set_display_name", { display_name: displayName }); await request("control", { url: remote ? PUBLIC_CONTROL : "", dismiss_setup: true }); await request("analytics", { level: analytics }); await request("notifications", { delivery: "native", setup_dismissed: true }); setOnboarding(false); await refresh() }) }}><div className="brand-mark">◈</div><h1>Welcome to MeshTalk</h1><p>Your identity lives on this device. Choose how people see you.</p><label>Display name<input required maxLength={48} value={displayName} onChange={e => setDisplayName(e.target.value)} /></label><label><input type="checkbox" checked={remote} onChange={e => setRemote(e.target.checked)} /> Enable remote discovery using the public control service</label><label>Optional analytics<select value={analytics} onChange={e => setAnalytics(e.target.value)}><option value="off">Off</option><option value="basic">Basic</option><option value="extended">Extended</option></select></label><p className="muted">LAN messaging works offline. The control service helps peers connect and relays encrypted traffic when needed.</p><button className="primary">Get started</button></form></div>}
  </div>
}
