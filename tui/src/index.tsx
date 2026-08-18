import { createClipboard, createCliRenderer, createHostClipboard, createRendererClipboardAdapter, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { IPCClient, type IPCEvent } from "../../common/ipc-client"

const MIN_COMPOSER_HEIGHT = 3
const MAX_COMPOSER_HEIGHT = 5
const MAX_MESSAGE_BYTES = 30 * 1024
const PUBLIC_CONTROL_URL = "wss://meshtalk-control.qincai.xyz/v1/rendezvous"
const DEFAULT_STATUS = "Ctrl+P: commands  Ctrl+Up/Down: select  Ctrl+D: remove offline  Ctrl+C: quit"

function getComposerHeight(composer: TextareaRenderable | null): number {
  const lines = composer?.editorView.getTotalVirtualLineCount() ?? 0
  return Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, lines))
}

type Peer = {
  peer_id: string
  display_name: string
  is_online: number
  last_seen: number
  unread_count: number
  presence?: "active" | "away" | "offline"
  is_friend?: boolean
  is_blocked?: boolean
  friend_request?: "incoming" | "outgoing" | "both" | null
  active_transport?: "lan_tcp" | "remote_udp"
  active_endpoint?: string
  endpoints: { transport: "lan_tcp" | "remote_udp"; endpoint: string; active: boolean }[]
  protocol_version?: number
  // -1 means legacy peer (no version fields in handshake), displayed as v0
  remote_protocol_version?: number
  capabilities?: string[]
}
type Message = {
  message_id: string
  sender_id: string
  recipient_id: string
  content: string
  created_at: number
  delivered?: number
  blocked?: number
}
type FriendRequest = {
  request_id: string
  sender_id: string
  sender_name: string
  recipient_id?: string
  recipient_name?: string
  note?: string | null
  created_at: number
  direction: "incoming" | "outgoing"
  status?: string
}
type BlockedPeer = {
  peer_id: string
  display_name: string
  created_at: number
}
type RoomStatus = {
  room_id: string
  members: number
}
type ControlStatus = {
  url?: string
  connected: boolean
  setup_dismissed: boolean
  stun_server: string
  reconnect_attempts: number
  public_endpoint?: unknown[]
}
type DebugInfo = {
  public_endpoint?: [string, number] | null
  stun_server: string
  local_tcp_port: number
  rooms: RoomStatus[]
  peers: Peer[]
}
type Dialog =
  | { kind: "commands" }
  | { kind: "control"; firstRun?: boolean }
  | { kind: "control-custom"; firstRun?: boolean }
  | { kind: "control-status"; control: ControlStatus }
  | { kind: "rooms"; rooms: RoomStatus[] }
  | { kind: "room-join" }
  | { kind: "room-created"; roomId: string; invite: string; copied: boolean; created?: boolean }
  | { kind: "room-detail"; room: RoomStatus }
  | { kind: "rename"; firstRun?: boolean }
  | { kind: "mute-timeout"; peerId: string; displayName: string }
  | { kind: "unmute-confirm"; peerId: string; displayName: string }
  | { kind: "add-friend"; peerId: string; displayName: string }
  | { kind: "remove-friend"; peerId: string; displayName: string }
  | { kind: "friend-requests"; requests: FriendRequest[] }
  | { kind: "friend-request-incoming"; request: FriendRequest }
  | { kind: "friends" }
  | { kind: "blocked"; blocked: BlockedPeer[] }
  | { kind: "block-peer-pick" }
  | { kind: "block-peer"; peerId: string; displayName: string }
  | { kind: "cancel-friend-confirm"; requestId: string; displayName: string }
  | { kind: "debug" }
  | { kind: "debug-endpoints" }
  | { kind: "debug-peer"; peerId: string; displayName: string }

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function transportName(transport?: Peer["active_transport"]): string {
  return transport === "lan_tcp" ? "LAN TCP" : transport === "remote_udp" ? "Remote UDP" : "No endpoint"
}

function peerPresence(peer: Peer): "active" | "away" | "offline" {
  return peer.presence ?? (peer.is_online ? "away" : "offline")
}

function friendMarkers(peer: Peer): string {
  const markers: string[] = []
  if (peer.is_friend) markers.push("\u2665")
  if (peer.friend_request === "incoming" || peer.friend_request === "both") markers.push("\u2199")
  if (peer.friend_request === "outgoing" || peer.friend_request === "both") markers.push("\u2197")
  return markers.length ? ` ${markers.join("")}` : ""
}

function composerLimitColor(length: number): string | undefined {
  const usage = length / MAX_MESSAGE_BYTES
  if (usage >= 1) return "#ff7777"
  if (usage >= 0.9) return "#ff9f43"
  if (usage >= 0.75) return "#e0a34a"
  return undefined
}

function ChatApp() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [ipc] = useState(() => new IPCClient())
  const [tuiClientId] = useState(() => crypto.randomUUID())
  const [peers, setPeers] = useState<Peer[]>([])
  const [identity, setIdentity] = useState<{ peer_id: string; display_name: string }>()
  const [selectedPeerId, setSelectedPeerId] = useState<string>()
  const [messages, setMessages] = useState<Message[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [draftLength, setDraftLength] = useState(0)
  const [composerHeight, setComposerHeight] = useState(MIN_COMPOSER_HEIGHT)
  const [isSending, setIsSending] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [editingName, setEditingName] = useState(false)
  const [scrollFocused, setScrollFocused] = useState(false)
  const [deliveredMessageIds, setDeliveredMessageIds] = useState<Set<string>>(() => new Set())
  const [blockedMessageIds, setBlockedMessageIds] = useState<Set<string>>(() => new Set())
  const [status, setStatus] = useState("Connecting to backend...")
  const [copyToast, setCopyToast] = useState(false)
  const [mutedPeers, setMutedPeers] = useState<Record<string, number>>({})
  const [versionMismatches, setVersionMismatches] = useState<Record<string, { remote_version: number; remote_min: number; local_version: number; local_min: number }>>({})
  const [controlStatus, setControlStatus] = useState<{ connected: boolean; reconnect_attempts: number }>({ connected: false, reconnect_attempts: 0 })
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dialogDraft, setDialogDraft] = useState("")
  const [dialogError, setDialogError] = useState("")
  const [dialogBusy, setDialogBusy] = useState(false)
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const composerRef = useRef<TextareaRenderable>(null)
  const backendDisconnected = useRef(false)
  const statusReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const copyToastReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clipboard = useRef<ReturnType<typeof createClipboard> | null>(null)
  const dialogAction = useRef(0)
  const dialogBusyRef = useRef(false)

  function showStatus(message: string) {
    if (statusReset.current) clearTimeout(statusReset.current)
    setStatus(message)
    statusReset.current = setTimeout(() => setStatus(DEFAULT_STATUS), 2_000)
  }

  function showCopyToast() {
    if (copyToastReset.current) clearTimeout(copyToastReset.current)
    setCopyToast(true)
    copyToastReset.current = setTimeout(() => setCopyToast(false), 2_000)
  }

  async function refreshPeers() {
    const response = await ipc.send("peers")
    if (response.error) throw new Error(response.error)
    const next = (response.peers as Peer[]).sort((first, second) =>
      second.is_online - first.is_online || first.display_name.localeCompare(second.display_name)
    )
    setPeers(next)
    setSelectedPeerId((current) => current && next.some((peer) => peer.peer_id === current) ? current : next[0]?.peer_id)
  }

  useEffect(() => {
    ipc.connect().then(async () => {
      const response = await ipc.send("identity")
      if (response.error) throw new Error(response.error)
      const nextIdentity = { peer_id: response.peer_id as string, display_name: response.display_name as string }
      setIdentity(nextIdentity)
      setNameDraft(nextIdentity.display_name)
      const presence = await ipc.send("tui_presence", { client_id: tuiClientId, active: true })
      if (presence.error) throw new Error(presence.error)
      await refreshPeers()
      const mutedResp = await ipc.send("muted_peers")
      if (!mutedResp.error) setMutedPeers(mutedResp.muted_peers as Record<string, number>)
      const control = await ipc.send("control")
      if (control.error) throw new Error(control.error)
      setControlStatus({ connected: control.connected as boolean, reconnect_attempts: control.reconnect_attempts as number })
      if (!(response.setup_dismissed as boolean)) {
        setDialog({ kind: "rename", firstRun: true })
      } else if (!control.url && !control.setup_dismissed) {
        setDialog({ kind: "control", firstRun: true })
      }
      setStatus(DEFAULT_STATUS)
    }).catch((error) => {
      if (!backendDisconnected.current) {
        setStatus(`Backend error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return () => {
      void ipc.send("tui_presence", { client_id: tuiClientId, active: false })
      ipc.close()
    }
  }, [tuiClientId])

  useEffect(() => () => {
    if (statusReset.current) clearTimeout(statusReset.current)
    if (copyToastReset.current) clearTimeout(copyToastReset.current)
  }, [])

  useEffect(() => {
    const service = createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(renderer),
    })
    clipboard.current = service
    return () => {
      clipboard.current = null
      void service.dispose()
    }
  }, [renderer])

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    if (!text) return
    void clipboard.current?.writeText(text, {
      destination: "all-available",
      allowRemoteHost: true,
    }).then(() => {
      renderer.clearSelection()
      showCopyToast()
    })
  })

  useEffect(() => {
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = ipc.onDisconnect(() => {
      backendDisconnected.current = true
      setStatus("Backend connection lost. Closing MeshTalk...")
      exitTimer = setTimeout(() => renderer.destroy(), 1500)
    })
    return () => {
      unsubscribe()
      if (exitTimer) clearTimeout(exitTimer)
    }
  }, [ipc, renderer])

  useEffect(() => {
    const interval = setInterval(() => {
      void refreshPeers().catch((error) => {
        if (!backendDisconnected.current) setStatus(`Peer refresh error: ${String(error)}`)
      })
      void ipc.send("control").then((control) => {
        if (!control.error) setControlStatus({ connected: control.connected as boolean, reconnect_attempts: control.reconnect_attempts as number })
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [ipc])

  useEffect(() => ipc.onEvent((event: IPCEvent) => {
    if (event.event === "delivered") {
      const messageId = event.message_id as string
      setDeliveredMessageIds((current) => new Set(current).add(messageId))
      setMessages((current) => current.map((message) =>
        message.message_id === messageId ? { ...message, delivered: 1 } : message
      ))
      showStatus("Message delivered.")
      return
    }
    if (event.event === "message_blocked") {
      const messageId = event.message_id as string
      const name = (event.display_name as string) ?? "a peer"
      setBlockedMessageIds((current) => new Set(current).add(messageId))
      setMessages((current) => current.map((message) =>
        message.message_id === messageId ? { ...message, blocked: 1 } : message
      ))
      if (event.removed_friend) showStatus(`${name} removed you as a friend. You are no longer friends.`)
      else showStatus(`Message blocked: ${name} hasn't added you as a friend yet.`)
      void refreshPeers()
      return
    }
    if (event.event === "friend_request") {
      const request: FriendRequest = {
        request_id: event.request_id as string,
        sender_id: event.sender_id as string,
        sender_name: (event.sender_name as string) ?? "a peer",
        note: (event.note as string | null | undefined) ?? null,
        created_at: event.created_at as number,
        direction: "incoming",
        status: "pending",
      }
      if (renderer.capabilities?.notifications) {
        renderer.triggerNotification(`Friend request from ${request.sender_name}`, "MeshTalk")
      }
      if (!dialog) setDialog({ kind: "friend-request-incoming", request })
      else showStatus(`Friend request from ${request.sender_name}. Open Commands > Friends to respond.`)
      void refreshPeers()
      return
    }
    if (event.event === "friend_response") {
      const name = (event.display_name as string) ?? "a peer"
      showStatus(event.accepted
        ? `${name} accepted your friend request. You can now chat.`
        : `${name} declined your friend request.`)
      void refreshPeers()
      return
    }
    if (event.event === "friend_cancelled") {
      const name = (event.display_name as string) ?? "a peer"
      showStatus(`${name} cancelled their friend request.`)
      void refreshPeers()
      return
    }
    if (event.event === "peer_version_mismatch") {
      const peerId = event.peer_id as string
      setVersionMismatches((current) => ({
        ...current,
        [peerId]: {
          remote_version: event.remote_version as number,
          remote_min: event.remote_min_version as number,
          local_version: event.local_version as number,
          local_min: event.local_min_version as number,
        },
      }))
      showStatus(`Version mismatch with ${peers.find((p) => p.peer_id === peerId)?.display_name ?? peerId}.`)
      return
    }
    if (event.event !== "message") {
      if (event.event === "peer_update") void refreshPeers()
      return
    }
    const senderId = event.sender_id as string
    const sender = peers.find((peer) => peer.peer_id === senderId)?.display_name ?? "a peer"
    const mutedUntil = mutedPeers[senderId]
    const isMuted = mutedUntil === undefined ? false : mutedUntil <= 0 || Date.now() / 1000 < mutedUntil
    if (renderer.capabilities?.notifications && !isMuted) {
      renderer.triggerNotification(`New message from ${sender}`, "MeshTalk")
    }
    if (senderId !== selectedPeerId) {
      setPeers((current) => current.map((peer) =>
        peer.peer_id === senderId ? { ...peer, unread_count: peer.unread_count + 1 } : peer
      ))
      return
    }
    setMessages((current) => [...current, {
      message_id: event.message_id as string,
      sender_id: senderId,
      recipient_id: "",
      content: event.content as string,
      created_at: event.created_at as number,
    }])
    void ipc.send("messages", { peer_id: senderId }).then((response) => {
      if (!response.error) setMessages(response.messages as Message[])
    })
  }), [ipc, mutedPeers, peers, renderer, selectedPeerId, dialog])

  useEffect(() => {
    if (!selectedPeerId) {
      setMessages([])
      setDraftLength(0)
      setComposerHeight(MIN_COMPOSER_HEIGHT)
      return
    }
    setScrollFocused(false)
    setDraftLength(new TextEncoder().encode(drafts[selectedPeerId] ?? "").length)
    setComposerHeight(MIN_COMPOSER_HEIGHT)
    setPeers((current) => current.map((peer) =>
      peer.peer_id === selectedPeerId ? { ...peer, unread_count: 0 } : peer
    ))
    ipc.send("messages", { peer_id: selectedPeerId }).then((response) => {
      if (response.error) throw new Error(response.error)
      setMessages(response.messages as Message[])
    }).catch((error) => {
      if (!backendDisconnected.current) {
        setStatus(`History error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }, [selectedPeerId])

  useEffect(() => {
    const composer = composerRef.current
    if (composer) {
      setComposerHeight(getComposerHeight(composer))
    }
  }, [selectedPeerId, width])

  async function removeSelectedPeer() {
    const peer = peers.find((item) => item.peer_id === selectedPeerId)
    if (!peer) return
    if (peer.is_online) {
      showStatus("Disconnect from this peer before removing it.")
      return
    }
    try {
      const response = await ipc.send("remove_peer", { peer_id: peer.peer_id })
      if (response.error) throw new Error(response.error)
      const remaining = peers.filter((item) => item.peer_id !== peer.peer_id)
      setPeers(remaining)
      setSelectedPeerId(remaining[0]?.peer_id)
      showStatus(`Removed ${peer.display_name} from the peer list.`)
    } catch (error) {
      if (!backendDisconnected.current) {
        setStatus(`Remove error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function closeDialog() {
    dialogAction.current++
    dialogBusyRef.current = false
    setDialog(null)
    setDialogDraft("")
    setDialogError("")
    setDialogBusy(false)
  }

  function showDialog(next: Dialog) {
    dialogAction.current++
    dialogBusyRef.current = false
    setDialog(next)
    setDialogDraft("")
    setDialogError("")
    setDialogBusy(false)
  }

  function beginDialogAction(): number | null {
    if (dialogBusyRef.current) return null
    dialogBusyRef.current = true
    const action = ++dialogAction.current
    setDialogBusy(true)
    setDialogError("")
    return action
  }

  function finishDialogAction(action: number) {
    if (dialogAction.current !== action) return
    dialogBusyRef.current = false
    setDialogBusy(false)
  }

  function failDialogAction(action: number, error: unknown) {
    if (dialogAction.current !== action) return
    setDialogError(error instanceof Error ? error.message : String(error))
    finishDialogAction(action)
  }

  function goBack() {
    if (!dialog || dialog.kind === "commands" || (dialog.kind === "control" && dialog.firstRun) || (dialog.kind === "rename" && dialog.firstRun)) {
      closeDialog()
    } else if (dialog.kind === "control-custom") {
      showDialog({ kind: "control", firstRun: dialog.firstRun })
    } else if (dialog.kind === "control-status") {
      showDialog({ kind: "control" })
    } else if (["room-join", "room-created", "room-detail"].includes(dialog.kind)) {
      showDialog({ kind: "rooms", rooms: [] })
      void loadRooms()
    } else if (dialog.kind === "mute-timeout") {
      showDialog({ kind: "commands" })
    } else if (dialog.kind === "unmute-confirm") {
      showDialog({ kind: "commands" })
    } else if (dialog.kind === "friend-request-incoming") {
      showDialog({ kind: "friend-requests", requests: [] })
      void loadFriendRequests()
    } else if (dialog.kind === "friend-requests" || dialog.kind === "add-friend" || dialog.kind === "remove-friend") {
      showDialog({ kind: "friends" })
    } else if (dialog.kind === "friends") {
      showDialog({ kind: "commands" })
    } else if (dialog.kind === "blocked") {
      showDialog({ kind: "friends" })
    } else if (dialog.kind === "block-peer-pick") {
      showDialog({ kind: "blocked", blocked: [] })
      void loadBlockedPeers()
    } else if (dialog.kind === "block-peer") {
      showDialog({ kind: "blocked", blocked: [] })
      void loadBlockedPeers()
    } else if (dialog.kind === "cancel-friend-confirm") {
      showDialog({ kind: "friend-requests", requests: [] })
      void loadFriendRequests()
    } else if (dialog.kind === "debug-peer") {
      showDialog({ kind: "debug-endpoints" })
    } else if (dialog.kind === "debug-endpoints") {
      showDialog({ kind: "debug" })
    } else if (dialog.kind === "debug") {
      showDialog({ kind: "commands" })
    } else {
      showDialog({ kind: "commands" })
    }
  }

  async function loadControlStatus() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("control")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDialog({ kind: "control-status", control: response as ControlStatus })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function loadRooms() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("rooms")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDialog({ kind: "rooms", rooms: response.rooms as RoomStatus[] })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function configureControl(url: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("control", { url })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus(`Control server set to ${response.url}.`)
      setDialog({ kind: "control-status", control: response as ControlStatus })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function dismissControlSetup() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("control", { dismiss_setup: true })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current === action) closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    }
  }

  async function createRoom() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_create")
      if (response.error) throw new Error(response.error)
      const invite = response.invite as string
      let copied = false
      try {
        const result = await clipboard.current?.writeText(invite, {
          destination: "best-available",
        })
        copied = result?.host.status === "written" || result?.terminal.status === "attempted"
      } catch {}
      if (dialogAction.current !== action) return
      setDialog({ kind: "room-created", roomId: response.room_id as string, invite, copied, created: true })
      showStatus("Private room created.")
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function joinRoom(invite: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_join", { invite: invite.trim() })
      if (response.error) throw new Error(response.error)
      const rooms = await ipc.send("rooms")
      if (rooms.error) throw new Error(rooms.error)
      if (dialogAction.current !== action) return
      showStatus(`Joined room ${(response.room_id as string).slice(0, 12)}.`)
      setDialog({ kind: "rooms", rooms: rooms.rooms as RoomStatus[] })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function leaveRoom(roomId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_leave", { room_id: roomId })
      if (response.error) throw new Error(response.error)
      const rooms = await ipc.send("rooms")
      if (rooms.error) throw new Error(rooms.error)
      if (dialogAction.current !== action) return
      showStatus(`Left room ${roomId.slice(0, 12)}.`)
      setDialog({ kind: "rooms", rooms: rooms.rooms as RoomStatus[] })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function loadRoomInvite(roomId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_invite", { room_id: roomId })
      if (response.error) throw new Error(response.error)
      const invite = response.invite as string
      let copied = false
      try {
        const result = await clipboard.current?.writeText(invite, {
          destination: "best-available",
        })
        copied = result?.host.status === "written" || result?.terminal.status === "attempted"
      } catch {}
      if (dialogAction.current !== action) return
      setDialog({ kind: "room-created", roomId, invite, copied })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function copyInvite(invite: string) {
    try {
      const result = await clipboard.current?.writeText(invite, {
        destination: "best-available",
      })
      if (result?.host.status !== "written" && result?.terminal.status !== "attempted") {
        throw new Error("No clipboard is available. Select and copy the invite text manually.")
      }
      setDialog((current) => current?.kind === "room-created" ? { ...current, copied: true } : current)
      showCopyToast()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    }
  }

  async function mutePeer(peerId: string, timeout: number) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("mute", { peer_id: peerId, timeout })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      const mutedResp = await ipc.send("muted_peers")
      if (!mutedResp.error) setMutedPeers(mutedResp.muted_peers as Record<string, number>)
      const until = response.until as number
      const label = until <= 0 ? "permanently" : `until ${new Date(until * 1000).toLocaleTimeString()}`
      const peer = peers.find((p) => p.peer_id === peerId)
      showStatus(`Muted ${peer?.display_name ?? peerId} ${label}.`)
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function unmutePeer(peerId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("unmute", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      const mutedResp = await ipc.send("muted_peers")
      if (!mutedResp.error) setMutedPeers(mutedResp.muted_peers as Record<string, number>)
      const peer = peers.find((p) => p.peer_id === peerId)
      showStatus(`Unmuted ${peer?.display_name ?? peerId}.`)
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function loadFriendRequests() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_requests")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDialog({ kind: "friend-requests", requests: response.requests as FriendRequest[] })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function sendFriendRequest(peerId: string, note: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_send", { peer_id: peerId, note })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus("Friend request sent. You can chat once they accept.")
      await refreshPeers()
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function respondToFriendRequest(request: FriendRequest, accept: boolean) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_respond", { request_id: request.request_id, accept })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus(accept
        ? `You and ${request.sender_name} are now friends.`
        : `Declined ${request.sender_name}'s friend request.`)
      await refreshPeers()
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function cancelFriendRequest(requestId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_cancel", { request_id: requestId })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus("Friend request cancelled.")
      await refreshPeers()
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function unfriendPeer(peerId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("unfriend", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      const peer = peers.find((p) => p.peer_id === peerId)
      showStatus(`Removed ${peer?.display_name ?? peerId} as a friend.`)
      await refreshPeers()
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function loadBlockedPeers() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("blocked_peers")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDialog({ kind: "blocked", blocked: response.blocked as BlockedPeer[] })
    } catch (error) {
      failDialogAction(action, error)
      return
    } finally {
      finishDialogAction(action)
    }
  }

  async function blockPeer(peerId: string, displayName: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("block_peer", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus(`Blocked ${displayName}. Their friend requests are now ignored.`)
      await refreshPeers()
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function unblockPeer(peerId: string, displayName: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("unblock_peer", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus(`Unblocked ${displayName}. They can send friend requests again.`)
      await refreshPeers()
      void loadBlockedPeers()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function blockSenderFromRequest(request: FriendRequest) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("block_peer", { peer_id: request.sender_id })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus(`Blocked ${request.sender_name}. Their friend requests are now ignored.`)
      await refreshPeers()
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function reStun() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("debug_re_stun")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      const endpoint = response.public_endpoint as [string, number] | null
      showStatus(endpoint ? `STUN complete. Endpoint: ${endpoint[0]}:${endpoint[1]}` : "STUN failed. No public endpoint discovered.")
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function loadDebugInfo() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("debug_info")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDebugInfo(response as unknown as DebugInfo)
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  function runCommand(command: string) {
    if (command === "control") {
      showDialog({ kind: "control" })
    } else if (command === "rooms") {
      showDialog({ kind: "rooms", rooms: [] })
      void loadRooms()
    } else if (command === "friends") {
      showDialog({ kind: "friends" })
    } else if (command === "rename") {
      const displayName = identity?.display_name ?? ""
      setNameDraft(displayName)
      setDialogDraft(displayName)
      setDialogError("")
      setDialog({ kind: "rename" })
    } else if (command === "mute") {
      const online = peers.filter((p) => p.is_online && p.peer_id !== identity?.peer_id && !mutedPeers[p.peer_id])
      if (!online.length) { showStatus("No unmuted online peers to mute."); return }
      showDialog({ kind: "mute-timeout", peerId: online[0].peer_id, displayName: online[0].display_name })
    } else if (command === "unmute") {
      const mutedIds = Object.keys(mutedPeers)
      const mutedList = peers.filter((p) => mutedIds.includes(p.peer_id))
      if (!mutedList.length) { showStatus("No muted peers to unmute."); return }
      showDialog({ kind: "unmute-confirm", peerId: mutedList[0].peer_id, displayName: mutedList[0].display_name })
    } else if (command === "add-friend") {
      const peer = peers.find((p) => p.peer_id === selectedPeerId)
      if (!peer) { showStatus("Select a peer to add as a friend."); return }
      if (peer.is_friend) { showStatus(`${peer.display_name} is already your friend.`); return }
      if (peer.is_blocked) { showStatus(`${peer.display_name} is blocked. Unblock them in Commands {'>'} Friends {'>'} Block.`); return }
      if (peer.friend_request === "outgoing" || peer.friend_request === "both") { showStatus(`Friend request to ${peer.display_name} is already pending.`); return }
      setDialogDraft("")
      showDialog({ kind: "add-friend", peerId: peer.peer_id, displayName: peer.display_name })
    } else if (command === "remove-friend") {
      const peer = peers.find((p) => p.peer_id === selectedPeerId)
      if (!peer) { showStatus("Select a friend to remove."); return }
      if (!peer.is_friend) { showStatus(`${peer.display_name} is not your friend.`); return }
      showDialog({ kind: "remove-friend", peerId: peer.peer_id, displayName: peer.display_name })
    } else if (command === "friend-requests") {
      void loadFriendRequests()
    } else if (command === "debug") {
      showDialog({ kind: "debug" })
      void loadDebugInfo()
    }
  }

  useKeyboard((key) => {
    if (dialog && dialogBusyRef.current) return
    if (key.ctrl && key.name === "p") {
      if (dialog?.kind === "commands") closeDialog()
      else showDialog({ kind: "commands" })
      return
    }
    if (dialog) {
      if (key.name === "escape") {
        goBack()
      }
      return
    }
    if (key.name === "escape" && editingName) {
      setEditingName(false)
      setNameDraft(identity?.display_name ?? "")
      showStatus("Name edit cancelled.")
      return
    }
    if (key.ctrl && key.name === "n") {
      setNameDraft(identity?.display_name ?? "")
      setEditingName(true)
      return
    }
    if (key.ctrl && key.name === "d") {
      void removeSelectedPeer()
      return
    }
    if ((key.name === "up" || key.name === "down") && key.ctrl && peers.length) {
      const index = peers.findIndex((peer) => peer.peer_id === selectedPeerId)
      const direction = key.name === "up" ? -1 : 1
      setSelectedPeerId(peers[(index + direction + peers.length) % peers.length].peer_id)
    }
    if (key.name === "pageup") {
      setScrollFocused(true)
      scrollboxRef.current?.scrollBy(-1, "viewport")
    }
    if (key.name === "pagedown") {
      setScrollFocused(true)
      scrollboxRef.current?.scrollBy(1, "viewport")
    }
    if (scrollFocused && key.name === "home") {
      scrollboxRef.current?.scrollTo(0)
    }
    if (scrollFocused && key.name === "end") {
      scrollboxRef.current?.scrollTo(scrollboxRef.current.scrollHeight)
    }
  })

  async function send() {
    const composer = composerRef.current
    const recipientId = selectedPeerId
    const content = composer?.plainText.trim() ?? ""
    if (!content) {
      showStatus("Message is empty.")
      return
    }
    if (!recipientId || !identity || !selected?.is_online) {
      showStatus("Select an active or away peer before sending.")
      return
    }
    if (new TextEncoder().encode(content).length > MAX_MESSAGE_BYTES) {
      showStatus("Message exceeds the 30 KiB limit.")
      return
    }
    setIsSending(true)
    try {
      const response = await ipc.send("send", { recipient_id: recipientId, content })
      if (response.error) throw new Error(response.error)
      setMessages((current) => [...current, {
        message_id: response.message_id as string,
        sender_id: identity.peer_id,
        recipient_id: recipientId,
        content,
        created_at: Date.now() / 1000,
        delivered: 0,
      }])
      if (composer && composer === composerRef.current) {
        composer.selectAll()
        composer.deleteSelection()
      }
      setDrafts((current) => ({ ...current, [recipientId]: "" }))
      setDraftLength(0)
      setComposerHeight(MIN_COMPOSER_HEIGHT)
      showStatus("Message sent. Waiting for delivery confirmation.")
    } catch (error) {
      if (!backendDisconnected.current) {
        setStatus(`Send error: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      setIsSending(false)
    }
  }

  async function saveDisplayName(value = nameDraft) {
    const action = dialog?.kind === "rename" ? beginDialogAction() : undefined
    if (action === null) return
    try {
      const response = await ipc.send("set_display_name", { display_name: value })
      if (response.error) throw new Error(response.error)
      if (action !== undefined && dialogAction.current !== action) return
      const displayName = response.display_name as string
      setIdentity((current) => current ? { ...current, display_name: displayName } : current)
      setNameDraft(displayName)
      setEditingName(false)
      if (action !== undefined && dialog?.kind === "rename" && dialog.firstRun) {
        const control = await ipc.send("control")
        if (control.error) throw new Error(control.error)
        if (dialogAction.current !== action) return
        if (control.url) {
          setDialog({ kind: "control-status", control: control as ControlStatus })
        } else if (!control.setup_dismissed) {
          setDialog({ kind: "control", firstRun: true })
        } else {
          closeDialog()
        }
      } else if (action !== undefined) {
        closeDialog()
      }
      showStatus("Display name updated and shared with connected peers.")
    } catch (error) {
      if (!backendDisconnected.current) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`Name error: ${message}`)
        if (action !== undefined) failDialogAction(action, error)
      }
    } finally {
      if (action !== undefined) finishDialogAction(action)
    }
  }

  const selected = peers.find((peer) => peer.peer_id === selectedPeerId)
  const activeCount = peers.filter((peer) => peerPresence(peer) === "active").length
  const sidebarWidth = width < 72 ? 22 : 32
  const compact = width < 72
  const limitColor = composerLimitColor(draftLength)
  const dialogWidth = Math.min(68, Math.max(1, width - 4))
  const dialogHeight = Math.min(20, Math.max(1, height - 4))
  function dialogWidthFor(kind: Dialog["kind"]): number {
    if (kind === "room-detail") return Math.min(78, Math.max(1, width - 2))
    return dialogWidth
  }
  return (
    <box style={{ flexDirection: "row", width: "100%", height: "100%", minWidth: 0, padding: 1, gap: 1 }}>
      <box title={`You: ${identity?.display_name ?? "..."}`} style={{ border: true, width: sidebarWidth, flexShrink: 0, flexDirection: "column", padding: 1, gap: 1 }}>
        <box onMouseDown={() => setEditingName(true)}>
          {editingName ? (
            <input
              value={nameDraft}
              focused={!dialog}
              placeholder="Display name"
              onInput={setNameDraft}
              onSubmit={() => void saveDisplayName()}
              maxLength={48}
            />
          ) : (
            <>
              <text fg="#888888">Click to rename</text>
              <text fg="#888888">{identity?.peer_id.slice(0, 12)}</text>
            </>
          )}
        </box>
        <box title={`Peers: ${activeCount} active`} bottomTitle="Ctrl+D removes offline" style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", padding: 1 }}>
          <scrollbox
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
            contentOptions={{ flexDirection: "column" }}
            verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
          >
            {!peers.length ? <text fg="#888888">No peers discovered</text> : null}
            {peers.map((peer) => {
              const presence = peerPresence(peer)
              const muted = peer.peer_id in mutedPeers
              return <box
                key={peer.peer_id}
                onMouseDown={() => {
                  setSelectedPeerId(peer.peer_id)
                  setScrollFocused(false)
                }}
                style={{ width: "100%", flexDirection: "column", backgroundColor: peer.peer_id === selectedPeerId ? "#25354d" : undefined }}
              >
                <text truncate fg={presence === "active" ? "#66dd88" : presence === "away" ? "#e0a34a" : "#888888"}>
                  {peer.peer_id === selectedPeerId ? "> " : "  "}{compact ? peer.display_name.slice(0, 10) : peer.display_name} {presence}{peer.unread_count ? ` (${peer.unread_count} new)` : ""}{friendMarkers(peer)}{muted ? " M" : ""}
                </text>
                {peer.endpoints.length ? peer.endpoints.map((endpoint) => (
                  <text key={`${endpoint.transport}-${endpoint.endpoint}`} truncate fg={endpoint.active ? "#7aa2d6" : "#718096"}>
                    {endpoint.active ? "* " : "  "}{transportName(endpoint.transport)} {endpoint.endpoint}
                  </text>
                )) : <text fg="#718096">No known endpoint</text>}
              </box>
            })}
          </scrollbox>
        </box>
      </box>

      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", gap: 1 }}>
        <box
          title={selected ? `Chat: ${selected.display_name}${selected.is_friend ? " \u2665" : ""}${selected.peer_id in mutedPeers ? " (muted)" : ""} (${peerPresence(selected) === "offline" ? "offline" : `${peerPresence(selected)}: ${transportName(selected.active_transport)} ${selected.active_endpoint ?? ""}`})${selected.protocol_version != null ? ` protocol: v${selected.protocol_version}${selected.remote_protocol_version != null ? ` (max: v${selected.remote_protocol_version === -1 ? 0 : selected.remote_protocol_version})` : ""}` : ""}` : "Chat"}
          bottomTitle={compact ? "PgUp/PgDn scroll" : "PgUp/PgDn scroll  End latest  Drag text to select"}
          style={{ border: true, borderColor: scrollFocused ? "#6ea8fe" : undefined, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}
        >
          {(
            (selected && !selected.is_online) ||
            (selected && selected.is_online && !selected.is_friend) ||
            (selected && selected.is_online && selected.active_transport === "remote_udp" && !controlStatus.connected) ||
            (selected && versionMismatches[selected.peer_id])
          ) ? (
            <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
              {selected && !selected.is_online ? (
                <text wrapMode="word" fg="#e0a34a">This peer is offline. Messages cannot be sent until it reconnects.</text>
              ) : null}
              {selected && selected.is_online && !selected.is_friend ? (
                <text wrapMode="word" fg="#e0a34a">Not friends yet. Your messages will be blocked until they accept your friend request (commands {'>'} friends {'>'} add friend).</text>
              ) : null}
              {selected && selected.is_online && selected.active_transport === "remote_udp" && !controlStatus.connected ? (
                <text wrapMode="word" fg="#ff9f43">Out-of-sync with rendezvous server. Peer connectivity may degrade over time; reconnecting ({controlStatus.reconnect_attempts}).</text>
              ) : null}
              {selected && versionMismatches[selected.peer_id] ? (() => {
                const m = versionMismatches[selected.peer_id]
                const remoteMax = m.remote_version === -1 ? 0 : m.remote_version
                const remoteMin = m.remote_min === -1 ? 0 : m.remote_min
                return <text wrapMode="word" fg="#e0a34a">Version mismatch: this peer supports v{remoteMin}-v{remoteMax}, local is v{m.local_min}-v{m.local_version}. Features may not work correctly.</text>
              })() : null}
            </box>
          ) : null}
          <scrollbox
            ref={scrollboxRef}
            focused={scrollFocused && !dialog}
            onMouseDown={() => setScrollFocused(true)}
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, padding: 1 }}
            contentOptions={{ flexDirection: "column" }}
            stickyScroll
            stickyStart="bottom"
            viewportCulling={false}
            verticalScrollbarOptions={{
              showArrows: true,
              trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" },
              arrowOptions: { foregroundColor: "#6ea8fe" },
            }}
          >
            {!selected ? <text fg="#888888">Waiting for a connected peer.</text> : null}
            {selected && !messages.length && selected.is_online ? <text fg="#888888">No messages yet. Say hello.</text> : null}
            {messages.map((message) => {
              const isLocal = message.sender_id === identity?.peer_id
              const delivered = Boolean(message.delivered) || deliveredMessageIds.has(message.message_id)
              const blocked = Boolean(message.blocked) || blockedMessageIds.has(message.message_id)
              return (
                <box key={message.message_id} style={{ flexDirection: "column", marginBottom: 1 }}>
                  <text>
                    <span fg="#888888">{formatTime(message.created_at)} </span>
                    <span fg={isLocal ? "#65a9ff" : "#66dd88"}>{isLocal ? "You" : selected?.display_name}</span>
                    {isLocal && <span fg={blocked ? "#ff7777" : "#888888"}> {blocked ? "blocked" : delivered ? "delivered" : "sent"}</span>}
                  </text>
                  <text wrapMode="word">{message.content}</text>
                </box>
              )
            })}
          </scrollbox>
        </box>

        <box
          title={selected?.is_online ? (compact ? "Message" : "Message: Enter sends, Alt+Enter adds a line") : "Message: peer offline"}
          bottomTitle={isSending ? "Sending..." : `${draftLength.toLocaleString()} / ${MAX_MESSAGE_BYTES.toLocaleString()} bytes`}
          titleColor={limitColor ?? "#888888"}
          style={{ border: true, borderColor: limitColor ?? (!scrollFocused && !editingName && selected?.is_online ? "#6ea8fe" : undefined), flexShrink: 0, overflow: "hidden", padding: 1 }}
        >
          <textarea
            key={selectedPeerId ?? "no-peer"}
            ref={composerRef}
            initialValue={selectedPeerId ? drafts[selectedPeerId] ?? "" : ""}
            placeholder={selected?.is_online ? "Write a message" : "Select an online peer"}
            focused={Boolean(selected?.is_online) && !editingName && !scrollFocused && !isSending && !dialog}
            onMouseDown={() => setScrollFocused(false)}
            onContentChange={() => {
              const composer = composerRef.current
              const content = composer?.plainText ?? ""
              setDraftLength(new TextEncoder().encode(content).length)
              setComposerHeight(getComposerHeight(composer))
              if (selectedPeerId) setDrafts((current) => ({ ...current, [selectedPeerId]: content }))
            }}
            onSubmit={() => void send()}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", meta: true, action: "newline" },
            ]}
            height={composerHeight}
            wrapMode="word"
            overflow="hidden"
            scrollMargin={1}
            selectionBg="#365b85"
          />
        </box>
        <text fg={status.includes("error") || status.includes("lost") || status.includes("exceeds") ? "#ff7777" : "#888888"}>{status}</text>
      </box>
      {copyToast && (
        <box style={{ position: "absolute", right: 2, top: 1, border: true, borderColor: "#66dd88", backgroundColor: "#18251d", paddingLeft: 1, paddingRight: 1 }}>
          <text fg="#66dd88">Copied to clipboard</text>
        </box>
      )}
      {dialog && (
        <box style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", backgroundColor: "#080b10", alignItems: "center", justifyContent: "center" }}>
          <box
            title={dialog.kind === "commands" ? "Commands"
              : dialog.kind.startsWith("control") ? "Control server"
              : dialog.kind === "rename" ? "Display name"
              : dialog.kind === "mute-timeout" ? "Mute peer"
              : dialog.kind === "unmute-confirm" ? "Unmute peer"
              : dialog.kind === "add-friend" ? "Add friend"
              : dialog.kind === "remove-friend" ? "Remove friend"
              : dialog.kind === "friend-requests" ? "Friend requests"
              : dialog.kind === "friend-request-incoming" ? "Friend request"
              : dialog.kind === "friends" ? "Friends"
              : dialog.kind === "blocked" ? "Blocked friends"
              : dialog.kind === "block-peer-pick" ? "Block a peer"
              : dialog.kind === "block-peer" ? "Block friend requests"
              : dialog.kind === "cancel-friend-confirm" ? "Cancel friend request"
              : dialog.kind === "debug-peer" ? "Peer details"
              : dialog.kind === "debug-endpoints" ? "Endpoints"
              : dialog.kind === "debug" ? "Debug"
              : "Private rooms"}
            bottomTitle={dialogBusy ? "Working..." : "Esc back  Ctrl+P commands"}
            style={{ width: dialogWidthFor(dialog.kind), height: dialogHeight, border: true, borderColor: "#6ea8fe", backgroundColor: "#111923", padding: 1, flexDirection: "column", gap: 1 }}
          >
            {dialog.kind === "commands" && (
              <select
                focused
                height={Math.max(5, dialogHeight - 3)}
                options={[
                  { name: "Control server", description: "Set up or inspect remote discovery", value: "control" },
                  { name: "Private rooms", description: "Create, join, view, or leave rooms", value: "rooms" },
                  { name: "Friends", description: "Add a friend, respond to requests, remove, or block", value: "friends" },
                  { name: "Mute peer", description: "Mute desktop notifications from an online peer", value: "mute" },
                  { name: "Unmute peer", description: "Resume desktop notifications for a muted peer", value: "unmute" },
                  { name: "Rename yourself", description: "Change the display name peers see", value: "rename" },
                  { name: "Debug", description: "Re-STUN and connection diagnostics", value: "debug" },
                ]}
                onSelect={(_, option) => option && runCommand(option.value as string)}
                wrapSelection
                showDescription
              />
            )}
            {dialog.kind === "control" && (
              <>
                {dialog.firstRun && <text fg="#e0a34a">Set up remote discovery to connect outside your LAN. You can skip this for LAN-only chat.</text>}
                <select
                  focused
                  height={Math.max(6, dialogHeight - 4)}
                  options={[
                    { name: "Use MeshTalk public server", description: PUBLIC_CONTROL_URL, value: "public" },
                    { name: "Use a custom server", description: "Enter another secure WebSocket URL", value: "custom" },
                    { name: "View connection status", description: "See the current URL, connection, STUN, and endpoint", value: "status" },
                    ...(dialog.firstRun ? [{ name: "Continue with LAN only", description: "You can configure this later with Ctrl+P", value: "skip" }] : []),
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "public") void configureControl(PUBLIC_CONTROL_URL)
                    else if (option?.value === "custom") showDialog({ kind: "control-custom", firstRun: dialog.firstRun })
                    else if (option?.value === "status") void loadControlStatus()
                    else if (option?.value === "skip") void dismissControlSetup()
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "control-custom" && (
              <>
                <text>Enter a `wss://` URL. Plain `ws://` is accepted only for localhost.</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder="wss://control.example/v1/rendezvous"
                  onInput={setDialogDraft}
                  onSubmit={(value) => void configureControl(typeof value === "string" ? value : dialogDraft)}
                  maxLength={2048}
                />
                <text fg="#888888">Enter saves the server.</text>
              </>
            )}
            {dialog.kind === "control-status" && (
              <>
                <text><span fg="#888888">Server: </span>{dialog.control.url ?? "Not configured"}</text>
                <text><span fg="#888888">Connection: </span><span fg={dialog.control.connected ? "#66dd88" : "#e0a34a"}>{dialog.control.connected ? "Connected" : "Disconnected"}</span></text>
                <text><span fg="#888888">STUN: </span>{dialog.control.stun_server}</text>
                <text><span fg="#888888">Public endpoint: </span>{dialog.control.public_endpoint?.join(":") ?? "Not discovered"}</text>
                <select
                  focused
                  height={5}
                  options={[
                    { name: "Change server", description: "Choose the public server or enter a custom URL", value: "change" },
                    { name: "Back to commands", description: "Return to the command palette", value: "back" },
                  ]}
                  onSelect={(_, option) => option?.value === "change" ? showDialog({ kind: "control" }) : showDialog({ kind: "commands" })}
                />
              </>
            )}
            {dialog.kind === "rooms" && (
              <>
                <select
                  focused
height={Math.max(5, dialogHeight - 3)}
                options={[
                  { name: "Create a private room", description: "Generate a secret invite and copy it", value: "create" },
                  { name: "Join with an invite", description: "Paste a meshtalk: invite", value: "join" },
                    ...dialog.rooms.map((room) => ({
                      name: `Room ${room.room_id.slice(0, 12)}`,
                      description: `${room.members} control connection${room.members === 1 ? "" : "s"} - view or leave`,
                      value: room.room_id,
                    })),
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "create") void createRoom()
                    else if (option?.value === "join") showDialog({ kind: "room-join" })
                    else {
                      const room = dialog.rooms.find((item) => item.room_id === option?.value)
                      if (room) showDialog({ kind: "room-detail", room })
                    }
                  }}
                  wrapSelection
                  showDescription
                />
                {!dialog.rooms.length && <text fg="#888888">No joined rooms yet.</text>}
              </>
            )}
            {dialog.kind === "room-join" && (
              <>
                <text>Paste the secret invite you received from another room member.</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder="meshtalk:..."
                  onInput={setDialogDraft}
                  onSubmit={(value) => void joinRoom(typeof value === "string" ? value : dialogDraft)}
                  maxLength={4096}
                />
                <text fg="#888888">Enter joins the room. Invites are secrets.</text>
              </>
            )}
            {dialog.kind === "room-created" && (
              <>
                <text fg="#66dd88">{dialog.created ? "Room created" : "Room invite"}</text>
                <text><span fg="#888888">ID: </span>{dialog.roomId}</text>
                <text wrapMode="word"><span fg="#888888">Invite: </span>{dialog.invite}</text>
                <text fg={dialog.copied ? "#66dd88" : "#e0a34a"}>{dialog.copied ? "Copy requested. Paste once to confirm your terminal accepted it." : "Copy the invite before sharing it."}</text>
                <select
                  focused
                  height={5}
                  options={[
                    { name: "Copy invite", description: "Copy the secret invite to the clipboard", value: "copy" },
                    { name: "Back to rooms", description: "Manage your private rooms", value: "back" },
                  ]}
                  onSelect={(_, option) => option?.value === "copy" ? void copyInvite(dialog.invite) : void loadRooms()}
                />
              </>
            )}
            {dialog.kind === "room-detail" && (
              <>
                <text><span fg="#888888">Room ID: </span>{dialog.room.room_id}</text>
                <text><span fg="#888888">Control connections: </span>{dialog.room.members}</text>
                <text fg="#e0a34a">Leaving removes this room and its secret from this device.</text>
                <select
                  focused
                  height={6}
                  options={[
                    { name: "Keep room", description: "Return without making changes", value: "keep" },
                    { name: "Copy invite", description: "Reveal and copy this room's secret invite", value: "copy" },
                    { name: "Leave room", description: "Permanently remove this room from this device", value: "leave" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "leave") void leaveRoom(dialog.room.room_id)
                    else if (option?.value === "copy") void loadRoomInvite(dialog.room.room_id)
                    else void loadRooms()
                  }}
                />
              </>
            )}
            {dialog.kind === "rename" && (
              <>
                <text>Choose the name other peers will see.</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder="Display name"
                  onInput={(value) => {
                    setDialogDraft(value)
                    setNameDraft(value)
                  }}
                  onSubmit={(value) => void saveDisplayName(typeof value === "string" ? value : dialogDraft)}
                  maxLength={48}
                />
                <text fg="#888888">Enter saves and shares the name with connected peers.</text>
              </>
            )}
            {dialog.kind === "mute-timeout" && (
              <>
                <text>Mute notifications from <span fg="#66dd88">{dialog.displayName}</span>.</text>
                <text fg="#888888">Choose how long notifications will stay muted.</text>
                <select
                  focused
                  height={Math.max(5, dialogHeight - 6)}
                  options={[
                    { name: "15 minutes", description: "Mute for a short break", value: String(15 * 60) },
                    { name: "1 hour", description: "Mute for a while", value: String(60 * 60) },
                    { name: "4 hours", description: "Mute for half a workday", value: String(4 * 60 * 60) },
                    { name: "8 hours", description: "Mute for a full workday", value: String(8 * 60 * 60) },
                    { name: "Permanent", description: "Mute until you manually unmute", value: "0" },
                  ]}
                  onSelect={(_, option) => option && void mutePeer(dialog.peerId, Number(option.value))}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "unmute-confirm" && (
              <>
                <text>Unmute notifications from <span fg="#66dd88">{dialog.displayName}</span>?</text>
                <select
                  focused
                  height={4}
                  options={[
                    { name: "Yes, unmute", description: "Resume desktop notifications from this peer", value: "yes" },
                    { name: "Cancel", description: "Keep muted", value: "no" },
                  ]}
                  onSelect={(_, option) => option?.value === "yes" ? void unmutePeer(dialog.peerId) : showDialog({ kind: "commands" })}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "add-friend" && (
              <>
                <text>Send a friend request to <span fg="#66dd88">{dialog.displayName}</span>?</text>
                <text fg="#888888">They must accept before your messages get through.</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder="Optional note"
                  onInput={setDialogDraft}
                  onSubmit={(value) => void sendFriendRequest(dialog.peerId, typeof value === "string" ? value : dialogDraft)}
                  maxLength={1024}
                />
                <text fg="#888888">Enter sends the request. Esc backs out.</text>
              </>
            )}
            {dialog.kind === "remove-friend" && (
              <>
                <text>Remove <span fg="#66dd88">{dialog.displayName}</span> as a friend?</text>
                <text fg="#888888">Their future messages will be blocked until you accept a new request.</text>
                <select
                  focused
                  height={4}
                  options={[
                    { name: "Remove friend", description: "Stop being friends and block their messages", value: "yes" },
                    { name: "Cancel", description: "Keep them as a friend", value: "no" },
                  ]}
                  onSelect={(_, option) => option?.value === "yes" ? void unfriendPeer(dialog.peerId) : showDialog({ kind: "commands" })}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "friend-requests" && (
              <>
                {!dialog.requests.length && <text fg="#888888">No pending friend requests.</text>}
                {dialog.requests.length > 0 && (
                  <select
                    focused
                    height={Math.max(5, dialogHeight - 3)}
                    options={[
                      ...dialog.requests
                        .filter((request) => request.direction === "incoming")
                        .map((request) => ({
                          name: `\u2199 Request from ${request.sender_name}`,
                          description: request.note || "Accept, decline, or block",
                          value: `incoming:${request.request_id}`,
                        })),
                      ...dialog.requests
                        .filter((request) => request.direction === "outgoing")
                        .map((request) => ({
                          name: `\u2197 Request to ${request.recipient_name ?? request.sender_name}`,
                          description: "Cancel this request",
                          value: `outgoing:${request.request_id}`,
                        })),
                      { name: "Back to commands", description: "Return to the command palette", value: "back" },
                    ]}
                    onSelect={(_, option) => {
                      if (!option) return
                      if (option.value === "back") showDialog({ kind: "commands" })
                      else if (option.value.startsWith("incoming:")) {
                        const id = option.value.slice("incoming:".length)
                        const request = dialog.requests.find((item) => item.request_id === id)
                        if (request) showDialog({ kind: "friend-request-incoming", request })
                      } else if (option.value.startsWith("outgoing:")) {
                        const id = option.value.slice("outgoing:".length)
                        const request = dialog.requests.find((item) => item.request_id === id)
                        if (request) showDialog({ kind: "cancel-friend-confirm", requestId: request.request_id, displayName: request.recipient_name ?? request.sender_name })
                      }
                    }}
                    wrapSelection
                    showDescription
                  />
                )}
              </>
            )}
            {dialog.kind === "friend-request-incoming" && (
              <>
                <text><span fg="#66dd88">{dialog.request.sender_name}</span> wants to add you as a friend.</text>
                {dialog.request.note ? <text wrapMode="word"><span fg="#888888">Note: </span>{dialog.request.note}</text> : null}
                <select
                  focused
                  height={7}
                  options={[
                    { name: "Accept", description: "Become friends and allow direct messages", value: "accept" },
                    { name: "Decline", description: "Reject this friend request", value: "decline" },
                    { name: "Block sender", description: "Ignore all future friend requests from this person", value: "block" },
                  ]}
                  onSelect={(_, option) => {
                    if (!option) return
                    if (option.value === "block") void blockSenderFromRequest(dialog.request)
                    else void respondToFriendRequest(dialog.request, option.value === "accept")
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "friends" && (
              <select
                focused
                height={Math.max(5, dialogHeight - 3)}
                options={[
                  { name: "Block", description: "Ignore friend requests from a specific person", value: "blocked" },
                  { name: "Add friend", description: "Send a friend request to the selected peer", value: "add-friend" },
                  { name: "Friend requests", description: "View and respond to pending requests", value: "friend-requests" },
                  { name: "Remove friend", description: "Stop being friends with the selected peer", value: "remove-friend" },
                  { name: "Back to commands", description: "Return to the command palette", value: "back" },
                ]}
                onSelect={(_, option) => {
                  if (!option) return
                  if (option.value === "back") showDialog({ kind: "commands" })
                  else if (option.value === "blocked") void loadBlockedPeers()
                  else runCommand(option.value)
                }}
                wrapSelection
                showDescription
              />
            )}
            {dialog.kind === "blocked" && (
              <>
                {!dialog.blocked.length && <text fg="#888888">No blocked peers. Blocked peers cannot send you friend requests.</text>}
                {dialog.blocked.length > 0 && (
                  <select
                    focused
                    height={Math.max(5, dialogHeight - 6)}
                    options={[
                      ...dialog.blocked.map((peer) => ({
                        name: peer.display_name,
                        description: "Unblock — allow friend requests again",
                        value: `unblock:${peer.peer_id}`,
                      })),
                      { name: "Block a peer...", description: "Ignore friend requests from a specific person", value: "block-pick" },
                      { name: "Back to friends", description: "Return to the Friends menu", value: "back" },
                    ]}
                    onSelect={(_, option) => {
                      if (!option) return
                      if (option.value === "block-pick") showDialog({ kind: "block-peer-pick" })
                      else if (option.value === "back") showDialog({ kind: "friends" })
                      else if (option.value.startsWith("unblock:")) {
                        const peer = dialog.blocked.find((item) => `unblock:${item.peer_id}` === option.value)
                        if (peer) void unblockPeer(peer.peer_id, peer.display_name)
                      }
                    }}
                    wrapSelection
                    showDescription
                  />
                )}
                {dialog.blocked.length === 0 && (
                  <select
                    focused
                    height={4}
                    options={[
                      { name: "Block a peer...", description: "Ignore friend requests from a specific person", value: "block-pick" },
                      { name: "Back to friends", description: "Return to the Friends menu", value: "back" },
                    ]}
                    onSelect={(_, option) => {
                      if (option?.value === "block-pick") showDialog({ kind: "block-peer-pick" })
                      else if (option?.value === "back") showDialog({ kind: "friends" })
                    }}
                    wrapSelection
                    showDescription
                  />
                )}
              </>
            )}
            {dialog.kind === "block-peer-pick" && (
              <>
                <text fg="#888888">Choose someone to block. Blocked peers cannot send you friend requests.</text>
                <select
                  focused
                  height={Math.max(5, dialogHeight - 6)}
                  options={[
                    ...peers
                      .filter((peer) => peer.peer_id !== identity?.peer_id && !peer.is_blocked)
                      .map((peer) => ({
                        name: peer.display_name,
                        description: peer.is_online ? "Online" : "Offline",
                        value: peer.peer_id,
                      })),
                    { name: "Back to blocked friends", description: "Return to the blocked friends list", value: "back" },
                  ]}
                  onSelect={(_, option) => {
                    if (!option) return
                    if (option.value === "back") {
                      showDialog({ kind: "blocked", blocked: [] })
                      void loadBlockedPeers()
                      return
                    }
                    const peer = peers.find((item) => item.peer_id === option.value)
                    if (peer) showDialog({ kind: "block-peer", peerId: peer.peer_id, displayName: peer.display_name })
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "block-peer" && (
              <>
                <text>Block friend requests from <span fg="#66dd88">{dialog.displayName}</span>?</text>
                <text fg="#888888">You can unblock later in Commands {'>'} Friends {'>'} Block.</text>
                <select
                  focused
                  height={4}
                  options={[
                    { name: "Block", description: "Ignore friend requests from this person", value: "yes" },
                    { name: "Cancel", description: "Keep receiving friend requests", value: "no" },
                  ]}
                  onSelect={(_, option) => {
                    if (!option) return
                    if (option.value === "yes") void blockPeer(dialog.peerId, dialog.displayName)
                    else {
                      showDialog({ kind: "blocked", blocked: [] })
                      void loadBlockedPeers()
                    }
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "cancel-friend-confirm" && (
              <>
                <text>Cancel friend request to <span fg="#66dd88">{dialog.displayName}</span>?</text>
                <text fg="#888888">They will no longer see your pending request.</text>
                <select
                  focused
                  height={4}
                  options={[
                    { name: "Cancel request", description: "Withdraw the pending friend request", value: "yes" },
                    { name: "Keep request", description: "Leave the request pending", value: "no" },
                  ]}
                  onSelect={(_, option) => {
                    if (!option) return
                    if (option.value === "yes") void cancelFriendRequest(dialog.requestId)
                    else {
                      showDialog({ kind: "friend-requests", requests: [] })
                      void loadFriendRequests()
                    }
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "debug" && (
              <>
                <text><span fg="#888888">Control: </span>{controlStatus.connected ? "Connected" : "Disconnected"}{controlStatus.reconnect_attempts ? ` (reconnects: ${controlStatus.reconnect_attempts})` : ""}</text>
                <text><span fg="#888888">STUN server: </span>{debugInfo?.stun_server ?? "..."}</text>
                <select
                  focused
                  height={Math.min(8, Math.max(1, dialogHeight - 8))}
                  options={[
                    { name: "Re-STUN", description: "Re-query STUN server and republish endpoint cards", value: "re-stun" },
                    { name: "Endpoints", description: "View your endpoint and connected peers", value: "endpoints" },
                    { name: "Refresh", description: "Reload debug information", value: "refresh" },
                    { name: "Back to commands", description: "Return to the command palette", value: "back" },
                  ]}
                  onSelect={(_, option) => {
                    if (!option) return
                    if (option.value === "re-stun") void reStun()
                    else if (option.value === "endpoints") { showDialog({ kind: "debug-endpoints" }); void loadDebugInfo() }
                    else if (option.value === "refresh") void loadDebugInfo()
                    else showDialog({ kind: "commands" })
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "debug-endpoints" && (
              <>
                {!debugInfo && <text fg="#888888">Loading debug info...</text>}
                {debugInfo && (
                  <scrollbox
                    style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
                    contentOptions={{ flexDirection: "column" }}
                    verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
                  >
                    <text><span fg="#888888">My public endpoint: </span>{debugInfo.public_endpoint ? `${debugInfo.public_endpoint[0]}:${debugInfo.public_endpoint[1]}` : "None"}</text>
                    <text><span fg="#888888">Local TCP port: </span>{debugInfo.local_tcp_port}</text>
                    <text fg="#888888">{"─".repeat(40)}</text>
                    <text><span fg="#888888">Local</span></text>
                    {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "lan_tcp")).length === 0 && <text fg="#888888">  No local peers</text>}
                    {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "lan_tcp")).map((peer) => (
                      <box key={`lp-${peer.peer_id}`} onMouseDown={() => showDialog({ kind: "debug-peer", peerId: peer.peer_id, displayName: peer.display_name })} style={{ width: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
                        <text truncate fg={peer.is_online ? "#66dd88" : "#888888"}>{"> "}{peer.display_name} ({peer.peer_id.slice(0, 12)})</text>
                      </box>
                    ))}
                    <text fg="#888888">{"─".repeat(40)}</text>
                    <text><span fg="#888888">Remote</span></text>
                    {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "remote_udp")).length === 0 && <text fg="#888888">  No remote peers</text>}
                    {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "remote_udp")).map((peer) => (
                      <box key={`rp-${peer.peer_id}`} onMouseDown={() => showDialog({ kind: "debug-peer", peerId: peer.peer_id, displayName: peer.display_name })} style={{ width: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
                        <text truncate fg={peer.is_online ? "#66dd88" : "#888888"}>{"> "}{peer.display_name} ({peer.peer_id.slice(0, 12)})</text>
                      </box>
                    ))}
                  </scrollbox>
                )}
                <select
                  focused
                  height={3}
                  options={[{ name: "Back", description: "Return to debug", value: "back" }]}
                  onSelect={(_, option) => { if (option?.value === "back") showDialog({ kind: "debug" }) }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "debug-peer" && (() => {
              const d = dialog
              const peer = debugInfo?.peers.find((p) => p.peer_id === d.peerId)
              if (!peer) return <text fg="#888888">Peer not found (try Refresh)</text>
              return (
                <>
                  <scrollbox
                    style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
                    contentOptions={{ flexDirection: "column" }}
                    verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
                  >
                    <text><span fg="#888888">Name: </span>{peer.display_name}</text>
                    <text><span fg="#888888">Peer ID: </span>{peer.peer_id}</text>
                    <text><span fg="#888888">Online: </span>{peer.is_online ? "Yes" : "No"}</text>
                    <text><span fg="#888888">Active transport: </span>{peer.active_transport ?? "None"}</text>
                    <text><span fg="#888888">Active endpoint: </span>{peer.active_endpoint ?? "None"}</text>
                    {peer.protocol_version != null && <text><span fg="#888888">Protocol version: </span>v{peer.protocol_version}{peer.remote_protocol_version != null ? ` (max: v${peer.remote_protocol_version === -1 ? 0 : peer.remote_protocol_version})` : ""}</text>}
                    {peer.capabilities?.length ? <text><span fg="#888888">Capabilities: </span>{peer.capabilities.join(", ")}</text> : null}
                    <text><span fg="#888888">Endpoints:</span></text>
                    {peer.endpoints.map((e) => (
                      <text key={`${e.transport}-${e.endpoint}`}>  {e.transport} {e.endpoint}{e.active ? " *" : ""}</text>
                    ))}
                  </scrollbox>
                  <select
                    focused
                    height={3}
                    options={[{ name: "Back", description: "Return to endpoints", value: "back" }]}
                    onSelect={(_, option) => { if (option?.value === "back") showDialog({ kind: "debug-endpoints" }) }}
                    wrapSelection
                    showDescription
                  />
                </>
              )
            })()}
            {dialogError && <text fg="#ff7777">{dialogError}</text>}
          </box>
        </box>
      )}
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
createRoot(renderer).render(<ChatApp />)
