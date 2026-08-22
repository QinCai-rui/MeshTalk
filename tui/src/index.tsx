import { createClipboard, createCliRenderer, createHostClipboard, createRendererClipboardAdapter, decodePasteBytes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { createRoot, useKeyboard, usePaste, useRenderer, useSelectionHandler, useTerminalDimensions, type SelectProps } from "@opentui/react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { IPCClient, type IPCEvent } from "../../common/ipc-client"
import { existsSync, statSync } from "fs"
import { checkForUpdate, type Release } from "../../common/updater"
import { dirname, join, resolve } from "path"
import { notify, sendTestNotification, type NotificationDelivery, type NotificationEvent, type NotificationPreferences } from "./notifications"

declare const APP_VERSION: string
declare const MESHTALK_RELEASE: boolean

const MIN_COMPOSER_HEIGHT = 3
const MAX_COMPOSER_HEIGHT = 5
const MAX_MESSAGE_BYTES = 30 * 1024
const PUBLIC_CONTROL_URL = "wss://meshtalk-control.qincai.xyz/v1/rendezvous"
const DEFAULT_STATUS = "Ctrl+P: commands  Ctrl+U: upload  Ctrl+Up/Down: select  Ctrl+D: remove offline  Ctrl+C: quit"
const IS_RELEASE_BUILD = typeof MESHTALK_RELEASE !== "undefined" && MESHTALK_RELEASE
const APP_RELEASE_VERSION = typeof APP_VERSION !== "undefined" ? APP_VERSION : "dev"

function getComposerHeight(composer: TextareaRenderable | null): number {
  const lines = composer?.editorView.getTotalVirtualLineCount() ?? 0
  return Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, lines))
}

type VersionMismatch = {
  remote_version: number
  remote_min: number
  local_version: number
  local_min: number
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
  // Present (and non-null) only when the backend determined this peer is
  // incompatible with the local protocol version range. Computed by the
  // backend so it survives restarts and missed handshake events.
  version_mismatch?: VersionMismatch | null
  // Authoritative list of messaging limitations for this peer, computed by
  // the backend. Rendered directly by the UI (no client-side re-derivation).
  delivery_warnings?: ("offline" | "not_friend" | "rendezvous_out_of_sync" | "incompatible")[]
  capabilities?: string[]
}
type Message = {
  message_id: string
  sender_id: string
  recipient_id?: string
  group_id?: string
  content: string
  created_at: number
  kind?: string
  deliveries?: GroupDelivery[]
  delivered?: number
  blocked?: number
  queued?: number
  failed?: number
  received_at?: number
}
type GroupDelivery = {
  recipient_id: string
  display_name: string
  status: string
  updated_at: number
}
type Group = {
  group_id: string
  name: string
  member_count: number
  unread_count: number
}
type GroupMember = {
  peer_id?: string
  member_id?: string
  display_name: string
  is_online?: boolean
  show_in_sidebar?: boolean
  is_incompatible?: boolean
}
type Conversation = { kind: "peer" | "group"; id: string }
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
  group_id?: string | null
  name?: string | null
}
type ControlStatus = {
  url?: string
  connected: boolean
  setup_dismissed: boolean
  stun_server: string
  reconnect_attempts: number
  public_endpoint?: unknown[]
}
type AdvancedConfig = {
  control_url?: string | null
  control_pinned_ips: string[]
  stun_server: string
  stun_pinned_ips: string[]
}
type DebugInfo = {
  public_endpoint?: [string, number] | null
  stun_server: string
  local_tcp_port: number
  rooms: RoomStatus[]
  peers: Peer[]
}
type FileTransfer = {
  file_id: string
  filename: string
  file_size: number
  sender_id: string
  recipient_id: string
  group_id?: string | null
  direction: string
  status: string
  file_path?: string | null
  created_at: number
  completed_at?: number | null
  received_chunks?: number
  total_chunks?: number
}
type ConversationItem =
  | { type: "message"; createdAt: number; message: Message }
  | { type: "file"; createdAt: number; file: FileTransfer }

type Dialog =
  | { kind: "commands" }
  | { kind: "control"; firstRun?: boolean }
  | { kind: "control-custom"; firstRun?: boolean }
  | { kind: "control-status"; control: ControlStatus }
  | { kind: "advanced"; config: AdvancedConfig }
  | { kind: "advanced-control"; config: AdvancedConfig }
  | { kind: "advanced-stun"; config: AdvancedConfig }
  | { kind: "advanced-control-ip" }
  | { kind: "advanced-stun-ip" }
  | { kind: "rooms"; rooms: RoomStatus[] }
  | { kind: "room-create" }
  | { kind: "room-join" }
  | { kind: "room-created"; roomId: string; invite: string; copied: boolean; created?: boolean }
  | { kind: "room-detail"; room: RoomStatus }
  | { kind: "group-detail"; group: Group; members: GroupMember[] }
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
  | { kind: "notifications" }
  | { kind: "notification-enable"; firstRun?: boolean }
  | { kind: "notification-confirm"; delivery: Exclude<NotificationDelivery, "disabled">; firstRun?: boolean }
  | { kind: "notification-fallback"; firstRun?: boolean }
  | { kind: "accessibility" }
  | { kind: "debug" }
  | { kind: "debug-endpoints" }
  | { kind: "debug-peer"; peerId: string; displayName: string }
  | { kind: "file-send" }
  | { kind: "file-list"; files: FileTransfer[] }
  | { kind: "file-download"; fileId: string; filename: string; filePath: string }
  | { kind: "files-dir"; filesDir: string; env?: string; configured?: string; dataDir?: string }
  | { kind: "group-file-send" }
  | { kind: "update"; release: Release }
  | { kind: "about"; checking?: boolean; checked?: boolean }

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp * 1000)
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${dd}/${mm}/${yy} ${formatTime(timestamp)}`
}

function formatDateSeparator(timestamp: number): string {
  const d = new Date(timestamp * 1000)
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })
}

function dayKey(timestamp: number): string {
  const d = new Date(timestamp * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatTimeMinute(timestamp: number): string {
  const d = new Date(timestamp * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`
}

function transportName(transport?: Peer["active_transport"]): string {
  return transport === "lan_tcp" ? "LAN TCP" : transport === "remote_udp" ? "Remote UDP" : "No endpoint"
}

function peerPresence(peer: Peer): "active" | "away" | "offline" {
  // `presence` is computed authoritatively by the backend (it also accounts
  // for `tui_active`); only fall back when the field is genuinely absent.
  return peer.presence ?? "offline"
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

function groupDeliveryLabel(deliveries: GroupDelivery[] = []): string {
  if (!deliveries.length) return "sent"
  const delivered = deliveries.filter((delivery) => delivery.status === "delivered").length
  const queued = deliveries.filter((delivery) => delivery.status === "queued")
  const unavailable = deliveries.filter((delivery) => delivery.status === "unavailable")
  const details = [`delivered ${delivered}/${deliveries.length}`]
  if (queued.length) details.push(`queued for ${queued.map((delivery) => delivery.display_name).join(", ")}`)
  if (unavailable.length) details.push(`unavailable for ${unavailable.map((delivery) => delivery.display_name).join(", ")}`)
  return details.join(", ")
}

function groupFromResponse(response: Record<string, unknown>): Group | undefined {
  if (response.group && typeof response.group === "object") return response.group as Group
  if (typeof response.group_id !== "string" || typeof response.name !== "string") return undefined
  return { group_id: response.group_id, name: response.name, member_count: 1, unread_count: 0 }
}

function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)
}

function toFileUrl(p: string, version?: number | null): string {
  // cross-platform: OpenTUI accepts plain path but file:// is more robust
  let normalized = p.replace(/\\/g, "/")
  if (/^[a-zA-Z]:\//.test(normalized)) normalized = "/" + normalized
  // A received file is preallocated before its contents arrive. Version its
  // source once complete so the image renderer does not reuse stale bytes.
  return "file://" + normalized + (version ? `?v=${version}` : "")
}

function terminalWidth(text: string): number {
  return Array.from(text).reduce((width, character) => width + (character.codePointAt(0)! > 0xff ? 2 : 1), 0)
}

function MouseSelect(props: SelectProps) {
  const options = props.options ?? []
  const [selectedIndex, setSelectedIndex] = useState(() => Math.min(props.selectedIndex ?? 0, Math.max(0, options.length - 1)))
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [descriptionOffset, setDescriptionOffset] = useState(0)
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const menuId = useRef(crypto.randomUUID()).current
  const showDescription = props.showDescription ?? true
  const showSelectionIndicator = props.showSelectionIndicator ?? true
  const selectedBackgroundColor = props.selectedBackgroundColor ?? "#334455"
  const selectedTextColor = props.selectedTextColor ?? "#FFFF00"
  const textColor = props.textColor ?? "#FFFFFF"
  const descriptionColor = props.descriptionColor ?? "#888888"
  const selectedDescriptionColor = props.selectedDescriptionColor ?? "#CCCCCC"
  const activeIndex = hoveredIndex ?? selectedIndex
  const activeDescription = options[activeIndex]?.description ?? ""

  useEffect(() => {
    if (!showDescription || !activeDescription) return

    let offset = 0
    let pauseTicks = 10
    setDescriptionOffset(0)
    const timer = setInterval(() => {
      const viewportWidth = scrollboxRef.current?.viewport.width ?? 0
      const text = `${showSelectionIndicator ? "  " : ""}${activeDescription}`
      const maxOffset = Math.max(0, terminalWidth(text) - viewportWidth)
      if (!maxOffset) return

      if (pauseTicks > 0) pauseTicks--
      else if (offset < maxOffset) offset++
      else {
        offset = 0
        pauseTicks = 10
      }
      setDescriptionOffset(offset)
    }, 125)
    return () => clearInterval(timer)
  }, [activeDescription, showDescription, showSelectionIndicator])

  function changeSelection(index: number) {
    if (!options.length) return
    const nextIndex = props.wrapSelection
      ? (index + options.length) % options.length
      : Math.max(0, Math.min(index, options.length - 1))
    setSelectedIndex(nextIndex)
    props.onChange?.(nextIndex, options[nextIndex])
    scrollboxRef.current?.scrollChildIntoView(`${menuId}-${nextIndex}`)
  }

  function selectOption(index: number) {
    changeSelection(index)
    props.onSelect?.(index, options[index] ?? null)
  }

  return (
    <scrollbox
      ref={scrollboxRef}
      focused={props.focused}
      width={props.width}
      height={props.height}
      style={props.style}
      onKeyDown={(key) => {
        if (key.name === "up" || key.name === "k") {
          key.preventDefault()
          changeSelection(selectedIndex - 1)
        } else if (key.name === "down" || key.name === "j") {
          key.preventDefault()
          changeSelection(selectedIndex + 1)
        } else if (key.name === "return" || key.name === "linefeed") {
          key.preventDefault()
          selectOption(selectedIndex)
        }
      }}
    >
      {options.map((option, index) => {
        const highlighted = index === activeIndex
        return (
          <box
            id={`${menuId}-${index}`}
            key={index}
            width="100%"
            height={showDescription ? 2 : 1}
            flexShrink={0}
            overflow="hidden"
            backgroundColor={highlighted ? selectedBackgroundColor : undefined}
            onMouseMove={() => setHoveredIndex(index)}
            onMouseOut={() => setHoveredIndex(null)}
            onMouseDown={(event) => {
              if (event.button === 0) {
                selectOption(index)
                event.stopPropagation()
              }
            }}
          >
            <text fg={highlighted ? selectedTextColor : textColor}>{showSelectionIndicator ? highlighted ? "▶ " : "  " : ""}{option.name}</text>
            {showDescription && <text wrapMode="none" fg={highlighted ? selectedDescriptionColor : descriptionColor}>{showSelectionIndicator ? "  " : ""}{highlighted ? Array.from(option.description).slice(descriptionOffset).join("") : option.description}</text>}
          </box>
        )
      })}
    </scrollbox>
  )
}

function ChatApp() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [ipc] = useState(() => new IPCClient())
  const [tuiClientId] = useState(() => crypto.randomUUID())
  const [peers, setPeers] = useState<Peer[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [groupMembers, setGroupMembers] = useState<Record<string, GroupMember[]>>({})
  const [identity, setIdentity] = useState<{ peer_id: string; display_name: string }>()
  const [selection, setSelection] = useState<Conversation>()
  const [messages, setMessages] = useState<Message[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [draftLength, setDraftLength] = useState(0)
  const [composerHeight, setComposerHeight] = useState(MIN_COMPOSER_HEIGHT)
  const [isSending, setIsSending] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [editingName, setEditingName] = useState(false)
  const [scrollFocused, setScrollFocused] = useState(false)
  const [deliveredMessageIds, setDeliveredMessageIds] = useState<Set<string>>(() => new Set())
  const [status, setStatus] = useState("Connecting to backend...")
  const [copyToast, setCopyToast] = useState(false)
  const [mutedPeers, setMutedPeers] = useState<Record<string, number>>({})
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null)
  const [notificationTestDelivery, setNotificationTestDelivery] = useState<Exclude<NotificationDelivery, "disabled"> | null>(null)
  const [versionMismatches, setVersionMismatches] = useState<Record<string, VersionMismatch>>({})
  const [blinkOn, setBlinkOn] = useState(true)
  const [flashingEnabled, setFlashingEnabled] = useState(true)
  const [controlStatus, setControlStatus] = useState<{ connected: boolean; reconnect_attempts: number; control_url?: string | null }>({ connected: false, reconnect_attempts: 0 })
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null)
  const [fileTransfers, setFileTransfers] = useState<FileTransfer[]>([])
  const [imageRenderGeneration, setImageRenderGeneration] = useState(0)
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
  const filePickerOpen = useRef(false)
  const selectedPeerId = selection?.kind === "peer" ? selection.id : undefined
  const selectedGroupId = selection?.kind === "group" ? selection.id : undefined
  const selectionKey = selection ? `${selection.kind}:${selection.id}` : undefined

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
    setSelection((current) => current && (current.kind === "group" || next.some((peer) => peer.peer_id === current.id))
      ? current
      : next[0] ? { kind: "peer", id: next[0].peer_id } : groups[0] ? { kind: "group", id: groups[0].group_id } : undefined)
  }

  async function refreshGroups() {
    const response = await ipc.send("groups")
    if (response.error) throw new Error(response.error)
    const next = (response.groups as Group[]).sort((first, second) => first.name.localeCompare(second.name))
    setGroups(next)
    setSelection((current) => {
      if (!current) return peers[0] ? { kind: "peer", id: peers[0].peer_id } : next[0] ? { kind: "group", id: next[0].group_id } : undefined
      if (current?.kind !== "group" || next.some((group) => group.group_id === current.id)) return current
      return peers[0] ? { kind: "peer", id: peers[0].peer_id } : next[0] ? { kind: "group", id: next[0].group_id } : undefined
    })
  }

  async function refreshGroupMembers(groupId: string | undefined = selectedGroupId) {
    if (!groupId) return
    const response = await ipc.send("group_members", { group_id: groupId })
    if (response.error) throw new Error(response.error)
    setGroupMembers((current) => ({ ...current, [groupId]: response.members as GroupMember[] }))
  }

  useEffect(() => {
    ipc.connect().then(async () => {
      const response = await ipc.send("identity")
      if (response.error) throw new Error(response.error)
      const nextIdentity = { peer_id: response.peer_id as string, display_name: response.display_name as string }
      setIdentity(nextIdentity)
      setFlashingEnabled(response.flashing_enabled as boolean)
      setNameDraft(nextIdentity.display_name)
      const presence = await ipc.send("tui_presence", { client_id: tuiClientId, active: true })
      if (presence.error) throw new Error(presence.error)
      await refreshPeers()
      await refreshGroups()
      void refreshFiles()
      const mutedResp = await ipc.send("muted_peers")
      if (!mutedResp.error) setMutedPeers(mutedResp.muted_peers as Record<string, number>)
      const notificationResponse = await ipc.send("notifications")
      if (notificationResponse.error) throw new Error(notificationResponse.error)
      const preferences = notificationResponse as NotificationPreferences
      setNotificationPreferences(preferences)
      const control = await ipc.send("control")
      if (control.error) throw new Error(control.error)
      setControlStatus({ connected: control.connected as boolean, reconnect_attempts: control.reconnect_attempts as number, control_url: control.url as string | null | undefined })
      if (!(response.setup_dismissed as boolean)) {
        setDialog({ kind: "rename", firstRun: true })
      } else if (!control.url && !control.setup_dismissed) {
        setDialog({ kind: "control", firstRun: true })
      } else if (!preferences.setup_dismissed) {
        setDialog({ kind: "notification-enable", firstRun: true })
      }
      if (IS_RELEASE_BUILD) {
        void checkForUpdate(APP_RELEASE_VERSION).then((release) => {
          if (release && (response.setup_dismissed as boolean) && (control.url || control.setup_dismissed)) {
            showDialog({ kind: "update", release })
          }
        })
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

  useEffect(() => {
    // Terminal image protocol detection completes asynchronously in some
    // terminals. Remount attachment images once the final capability set is known.
    const refreshImages = () => setImageRenderGeneration((generation) => generation + 1)
    renderer.on("capabilities", refreshImages)
    return () => { renderer.off("capabilities", refreshImages) }
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
      void refreshGroups().catch((error) => {
        if (!backendDisconnected.current) setStatus(`Group refresh error: ${String(error)}`)
      })
      void refreshGroupMembers().catch((error) => {
        if (!backendDisconnected.current && selectedGroupId) setStatus(`Group member refresh error: ${String(error)}`)
      })
      void refreshFiles()
      void ipc.send("control").then((control) => {
        if (!control.error) setControlStatus({ connected: control.connected as boolean, reconnect_attempts: control.reconnect_attempts as number, control_url: control.url as string | null | undefined })
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [ipc, selectedGroupId])

  useEffect(() => {
    if (!flashingEnabled) return
    const interval = setInterval(() => setBlinkOn((value) => !value), 600)
    return () => clearInterval(interval)
  }, [flashingEnabled])

  async function setAccessibilityFlashing(enabled: boolean) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("accessibility", { flashing_enabled: enabled })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setFlashingEnabled(response.flashing_enabled as boolean)
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  function notificationEventEnabled(event: NotificationEvent): boolean {
    return Boolean(notificationPreferences?.events[event])
  }

  async function saveNotificationPreferences(changes: {
    setup_dismissed?: boolean
    delivery?: NotificationDelivery
    events?: Partial<Record<NotificationEvent, boolean>>
  }) {
    const response = await ipc.send("notifications", changes)
    if (response.error) throw new Error(response.error)
    setNotificationPreferences(response as NotificationPreferences)
    return response as NotificationPreferences
  }

  async function testNotificationDelivery(delivery: Exclude<NotificationDelivery, "disabled">, firstRun = false) {
    const action = beginDialogAction()
    if (action === null) return
    setNotificationTestDelivery(delivery)
    try {
      const sent = await sendTestNotification(delivery, renderer)
      if (dialogAction.current !== action) return
      if (sent) setDialog({ kind: "notification-confirm", delivery, firstRun })
      else if (delivery === "terminal") setDialog({ kind: "notification-fallback", firstRun })
      else throw new Error("Could not start a native notification. Check that desktop notifications are available.")
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      setNotificationTestDelivery(null)
      finishDialogAction(action)
    }
  }

  async function confirmNotificationDelivery(delivery: Exclude<NotificationDelivery, "disabled">, firstRun = false) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      await saveNotificationPreferences({ setup_dismissed: true, delivery })
      if (dialogAction.current !== action) return
      showStatus(`Desktop notifications will use ${delivery === "terminal" ? "your terminal" : "your operating system"}.`)
      if (firstRun) closeDialog()
      else showDialog({ kind: "notifications" })
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function disableNotifications(firstRun = false) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      await saveNotificationPreferences({ setup_dismissed: true, delivery: "disabled" })
      if (dialogAction.current !== action) return
      if (firstRun) closeDialog()
      else showDialog({ kind: "notifications" })
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function toggleNotificationEvent(event: NotificationEvent) {
    if (!notificationPreferences) return
    const action = beginDialogAction()
    if (action === null) return
    try {
      await saveNotificationPreferences({ events: { [event]: !notificationEventEnabled(event) } })
      if (dialogAction.current !== action) return
      showDialog({ kind: "notifications" })
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  useEffect(() => ipc.onEvent((event: IPCEvent) => {
    if (["group_message", "group_member_joined", "group_member_left"].includes(event.event)) {
      const groupId = event.group_id as string
      const group = groups.find((item) => item.group_id === groupId)
      const senderId = event.sender_id as string | undefined
      const sender = (event.display_name as string | undefined)
        ?? peers.find((peer) => peer.peer_id === senderId)?.display_name
        ?? groupMembers[groupId]?.find((member) => (member.peer_id ?? member.member_id) === senderId)?.display_name
        ?? "a member"
      if (event.event === "group_message" && groupId !== selectedGroupId) {
        void notify(notificationPreferences, "messages", renderer, `New message from ${sender} in ${group?.name ?? "a group"}`)
      }
      if (groupId !== selectedGroupId) {
        setGroups((current) => current.map((item) => item.group_id === groupId ? { ...item, unread_count: item.unread_count + 1 } : item))
      } else {
        void ipc.send("group_messages", { group_id: groupId }).then((response) => {
          if (!response.error) setMessages(response.messages as Message[])
        })
      }
      void refreshGroups()
      if (event.event !== "group_message") {
        void ipc.send("group_members", { group_id: groupId }).then((response) => {
          if (!response.error) setGroupMembers((current) => ({ ...current, [groupId]: response.members as GroupMember[] }))
        })
      }
      return
    }
    if (event.event === "group_delivered" || event.event === "group_sent") {
      const messageId = event.message_id as string
      setMessages((current) => current.map((message) => {
        if (message.message_id !== messageId) return message
        if (Array.isArray(event.deliveries)) return { ...message, deliveries: event.deliveries as GroupDelivery[] }
        const recipientId = event.recipient_id as string | undefined
        if (!recipientId) return message
        return {
          ...message,
          deliveries: (message.deliveries ?? []).map((delivery) => delivery.recipient_id === recipientId
            ? { ...delivery, status: (event.status as string | undefined) ?? (event.event === "group_delivered" ? "delivered" : "sent"), updated_at: (event.updated_at as number | undefined) ?? Date.now() / 1000 }
            : delivery),
        }
      }))
      if (selectedGroupId && selectedGroupId === event.group_id) {
        void ipc.send("group_messages", { group_id: selectedGroupId }).then((response) => {
          if (!response.error) setMessages(response.messages as Message[])
        })
      }
      return
    }
    if (event.event === "delivered") {
      const messageId = event.message_id as string
      setDeliveredMessageIds((current) => new Set(current).add(messageId))
      setMessages((current) => current.map((message) =>
        message.message_id === messageId ? { ...message, delivered: 1, queued: 0, received_at: Date.now() / 1000 } : message
      ))
      showStatus("Message delivered.")
      return
    }
    if (event.event === "message_sent") {
      const messageId = event.message_id as string
      setMessages((current) => current.map((message) =>
        message.message_id === messageId ? { ...message, queued: 0 } : message
      ))
      return
    }
    if (event.event === "message_blocked") {
      const messageId = event.message_id as string
      const name = (event.display_name as string) ?? "a peer"
      setMessages((current) => current.map((message) =>
        message.message_id === messageId ? { ...message, blocked: 1 } : message
      ))
      if (event.removed_friend) showStatus(`${name} removed you as a friend. You are no longer friends.`)
      else showStatus(`Message blocked: ${name} hasn't added you as a friend yet.`)
      void refreshPeers()
      return
    }
    if (event.event === "message_failed") {
      const messageId = event.message_id as string
      setMessages((current) => current.map((message) =>
        message.message_id === messageId ? { ...message, failed: 1, queued: 0 } : message
      ))
      showStatus("Message cancelled because the peer protocol is incompatible.")
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
      void notify(notificationPreferences, "friend_requests", renderer, `Friend request from ${request.sender_name}`)
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
      void refreshPeers()
      return
    }
    if (event.event === "file_offer") {
      const filename = event.filename as string
      const sender = peers.find((p) => p.peer_id === event.sender_id)?.display_name ?? String(event.sender_id).slice(0,8)
      showStatus(`Incoming file: ${filename} (${event.file_size} bytes) from ${sender}`)
      void notify(notificationPreferences, "file_offers", renderer, `Incoming file ${filename} from ${sender}`)
      void ipc.send("files").then((res) => {
        if (!res.error) setFileTransfers(res.files as FileTransfer[])
      })
      return
    }
    if (event.event === "file_progress") {
      const fileId = event.file_id as string
      // Update fileTransfers if list open
      setFileTransfers((cur) => cur.map((f) => f.file_id === fileId ? { ...f, received_chunks: (event.received as number) ?? f.received_chunks } : f))
      return
    }
    if (event.event === "file_completed") {
      const filename = event.filename as string
      const fpath = event.file_path as string
      const fileId = event.file_id as string
      showStatus(`File received: ${filename} -> ${fpath}`)
      void notify(notificationPreferences, "file_completed", renderer, `File received: ${filename}`)
      // The offer has already populated this entry. Update it immediately so
      // the completed image mounts without waiting for the next IPC response.
      setFileTransfers((current) => current.map((file) => file.file_id === fileId
        ? { ...file, status: "completed", file_path: fpath, completed_at: Date.now() / 1000 }
        : file
      ))
      void ipc.send("files").then((res) => {
        if (!res.error) setFileTransfers(res.files as FileTransfer[])
      })
      return
    }
    if (event.event === "file_sent" || event.event === "file_delivered" || event.event === "file_queued") {
      const name = (event.file_id as string)?.slice(0, 8) ?? "file"
      if (event.event === "file_sent") showStatus(`File ${name} sent.`)
      else if (event.event === "file_delivered") showStatus(`File ${name} delivered.`)
      else showStatus(`File ${name} queued for offline peer.`)
      void ipc.send("files").then((res) => {
        if (!res.error) setFileTransfers(res.files as FileTransfer[])
      })
      return
    }
    if (event.event !== "message") {
      if (event.event === "peer_update") {
        const peerId = event.peer_id as string
        const mismatch = event.version_mismatch as VersionMismatch | null | undefined
        setVersionMismatches((current) => {
          if (mismatch) return { ...current, [peerId]: mismatch }
          // A peer_update without mismatch data is emitted on disconnect, so
          // do not keep an incompatibility warning for an offline peer.
          const { [peerId]: _, ...next } = current
          return next
        })
        void refreshPeers()
      }
      return
    }
    const senderId = event.sender_id as string
    const sender = peers.find((peer) => peer.peer_id === senderId)?.display_name ?? "a peer"
    const mutedUntil = mutedPeers[senderId]
    const isMuted = mutedUntil === undefined ? false : mutedUntil <= 0 || Date.now() / 1000 < mutedUntil
    if (!isMuted && senderId !== selectedPeerId) {
      void notify(notificationPreferences, "messages", renderer, `New message from ${sender}`)
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
      received_at: Date.now() / 1000,
    }])
    void ipc.send("messages", { peer_id: senderId }).then((response) => {
      if (!response.error) {
        setMessages(response.messages as Message[])
        void refreshPeers()
      }
    })
  }), [ipc, mutedPeers, peers, groups, groupMembers, renderer, selectedPeerId, selectedGroupId, dialog])

  useEffect(() => {
    let cancelled = false
    if (!selection || !selectionKey) {
      setMessages([])
      setDraftLength(0)
      setComposerHeight(MIN_COMPOSER_HEIGHT)
      return
    }
    setScrollFocused(false)
    setDraftLength(new TextEncoder().encode(drafts[selectionKey] ?? "").length)
    setComposerHeight(MIN_COMPOSER_HEIGHT)
    if (selection.kind === "peer") {
      setPeers((current) => current.map((peer) => peer.peer_id === selection.id ? { ...peer, unread_count: 0 } : peer))
    } else {
      setGroups((current) => current.map((group) => group.group_id === selection.id ? { ...group, unread_count: 0 } : group))
      void ipc.send("group_members", { group_id: selection.id }).then((response) => {
        if (!cancelled && !response.error) setGroupMembers((current) => ({ ...current, [selection.id]: response.members as GroupMember[] }))
      })
    }
    const request = selection.kind === "peer"
      ? ipc.send("messages", { peer_id: selection.id })
      : ipc.send("group_messages", { group_id: selection.id })
    request.then((response) => {
      if (response.error) throw new Error(response.error)
      if (cancelled) return
      setMessages(response.messages as Message[])
      if (selection.kind === "peer") void refreshPeers()
      else void refreshGroups()
    }).catch((error) => {
      if (!cancelled && !backendDisconnected.current) {
        setStatus(`History error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return () => { cancelled = true }
  }, [selectionKey])

  useEffect(() => {
    const composer = composerRef.current
    if (composer) {
      setComposerHeight(getComposerHeight(composer))
    }
  }, [selectionKey, width])

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
      setSelection(remaining[0] ? { kind: "peer", id: remaining[0].peer_id } : groups[0] ? { kind: "group", id: groups[0].group_id } : undefined)
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
    if (!dialog || dialog.kind === "commands" || dialog.kind === "update" || (dialog.kind === "control" && dialog.firstRun) || (dialog.kind === "rename" && dialog.firstRun)) {
      closeDialog()
    } else if (dialog.kind === "control-custom") {
      showDialog({ kind: "control", firstRun: dialog.firstRun })
    } else if (dialog.kind === "control-status") {
      showDialog({ kind: "control" })
    } else if (dialog.kind === "advanced-control-ip" || dialog.kind === "advanced-stun-ip") {
      void loadAdvancedConfig()
    } else if (dialog.kind === "advanced-control" || dialog.kind === "advanced-stun") {
      void loadAdvancedConfig()
    } else if (dialog.kind === "advanced" || dialog.kind === "about") {
      showDialog({ kind: "commands" })
    } else if (["room-create", "room-join", "room-created", "room-detail"].includes(dialog.kind)) {
      showDialog({ kind: "rooms", rooms: [] })
      void loadRooms()
    } else if (dialog.kind === "group-detail") {
      closeDialog()
    } else if (dialog.kind === "mute-timeout") {
      showDialog({ kind: "notifications" })
    } else if (dialog.kind === "unmute-confirm") {
      showDialog({ kind: "notifications" })
    } else if (dialog.kind === "friend-request-incoming") {
      showDialog({ kind: "friend-requests", requests: [] })
      void loadFriendRequests()
    } else if (dialog.kind === "friend-requests" || dialog.kind === "add-friend" || dialog.kind === "remove-friend") {
      showDialog({ kind: "friends" })
    } else if (dialog.kind === "friends") {
      showDialog({ kind: "commands" })
    } else if (dialog.kind === "notifications") {
      showDialog({ kind: "commands" })
    } else if (dialog.kind === "notification-enable" || dialog.kind === "notification-confirm" || dialog.kind === "notification-fallback") {
      if (dialog.firstRun) closeDialog()
      else showDialog({ kind: "notification-settings" })
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
    } else if (dialog.kind === "file-send" || dialog.kind === "group-file-send") {
      if (selection?.kind === "group") showDialog({ kind: "commands" })
      else showDialog({ kind: "commands" })
    } else if (dialog.kind === "file-list") {
      showDialog({ kind: "commands" })
    } else if (dialog.kind === "file-download") {
      showDialog({ kind: "file-list", files: fileTransfers })
    } else if (dialog.kind === "files-dir") {
      showDialog({ kind: "file-list", files: fileTransfers })
    } else {
      showDialog({ kind: "commands" })
    }
  }

  function installUpdate(release: Release) {
    const action = beginDialogAction()
    if (action === null) return
    const suffix = process.platform === "win32" ? ".exe" : ""
    const launcher = join(dirname(process.execPath), `meshtalk${suffix}`)
    try {
      Bun.spawn([launcher, "update", "--install"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      renderer.destroy()
    } catch (error) {
      failDialogAction(action, error)
    }
  }

  async function checkForUpdatesFromAbout() {
    if (!IS_RELEASE_BUILD) {
      setDialog({ kind: "about", checked: true })
      return
    }
    const action = beginDialogAction()
    if (action === null) return
    setDialog({ kind: "about", checking: true })
    try {
      const release = await checkForUpdate(APP_RELEASE_VERSION)
      if (dialogAction.current !== action) return
      setDialog(release ? { kind: "update", release } : { kind: "about", checked: true })
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
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

  async function loadAdvancedConfig() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("advanced_config")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDialog({ kind: "advanced", config: response as AdvancedConfig })
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function saveAdvancedConfig(params: Record<string, unknown>, message: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("advanced_config", params)
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDialog({ kind: "advanced", config: response as AdvancedConfig })
      showStatus(message)
    } catch (error) {
      failDialogAction(action, error)
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

  async function createRoom(name: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_create", { name: name.trim() })
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
      const group = groupFromResponse(response)
      const groupId = group?.group_id ?? response.room_id as string
      setDialog({ kind: "room-created", roomId: groupId, invite, copied, created: true })
      if (group) {
        setGroups((current) => [...current.filter((item) => item.group_id !== group.group_id), group].sort((first, second) => first.name.localeCompare(second.name)))
        setSelection({ kind: "group", id: group.group_id })
      } else {
        void refreshGroups()
      }
      showStatus(`Group ${group?.name ?? name.trim()} created.`)
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
      const group = groupFromResponse(response)
      showStatus(`Joined room ${(group?.group_id ?? response.room_id as string).slice(0, 12)}.`)
      setDialog({ kind: "rooms", rooms: rooms.rooms as RoomStatus[] })
      if (group) {
        setGroups((current) => [...current.filter((item) => item.group_id !== group.group_id), group].sort((first, second) => first.name.localeCompare(second.name)))
        setSelection({ kind: "group", id: group.group_id })
        showStatus(`Joined ${group.name}.`)
      } else {
        void refreshGroups()
      }
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

  async function loadGroupDetails(group: Group) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("group_members", { group_id: group.group_id })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      const members = response.members as GroupMember[]
      setGroupMembers((current) => ({ ...current, [group.group_id]: members }))
      setDialog({ kind: "group-detail", group, members })
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function leaveGroup(group: Group) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("group_leave", { group_id: group.group_id })
      if (response.error) throw new Error(response.error)
      const remaining = groups.filter((item) => item.group_id !== group.group_id)
      setGroups(remaining)
      if (selectedGroupId === group.group_id) {
        setSelection(peers[0] ? { kind: "peer", id: peers[0].peer_id } : remaining[0] ? { kind: "group", id: remaining[0].group_id } : undefined)
      }
      showStatus(`Left ${group.name}.`)
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
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

  async function loadFiles() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("files")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      const files = response.files as FileTransfer[]
      setFileTransfers(files)
      setDialog({ kind: "file-list", files })
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function refreshFiles() {
    try {
      const response = await ipc.send("files")
      if (!response.error) setFileTransfers(response.files as FileTransfer[])
    } catch {}
  }

  async function sendFile(filePath: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const trimmed = filePath.trim()
      if (!trimmed) throw new Error("File path is empty")
      const home = process.env.HOME || process.env.USERPROFILE || ""
      const expanded = home && (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
        ? home + trimmed.slice(1)
        : trimmed
      const absolutePath = resolve(expanded)
      // Cross-platform: expand separators — backend will normalize again, but do minimal client check
      if (selection?.kind === "peer") {
        const response = await ipc.send("file_send", { recipient_id: selection.id, file_path: absolutePath })
        if (response.error) throw new Error(response.error)
        showStatus(`File transfer started: ${absolutePath} -> ${selection.id.slice(0, 8)}`)
      } else if (selection?.kind === "group") {
        const response = await ipc.send("group_file_send", { group_id: selection.id, file_path: absolutePath })
        if (response.error) throw new Error(response.error)
        showStatus(`Group file transfer started: ${absolutePath}`)
      } else {
        throw new Error("Select a peer or group first")
      }
      if (dialogAction.current !== action) return
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function openFilePicker() {
    if (filePickerOpen.current) return
    if (!selection) {
      showStatus("Select a peer or group before sending a file.")
      return
    }
    if (process.platform === "linux" && !Bun.which("zenity")) {
      showStatus("No native file picker found. Enter a path in the upload screen.")
      showDialog({ kind: "file-send" })
      return
    }
    filePickerOpen.current = true
    try {
      const command = process.platform === "darwin"
        ? ["osascript", "-e", 'POSIX path of (choose file with prompt "Select a file to send")']
        : process.platform === "win32"
          ? ["powershell.exe", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }"]
          : ["zenity", "--file-selection", "--title=Select a file to send"]
      const pickerProcess = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const [exitCode, output] = await Promise.all([pickerProcess.exited, new Response(pickerProcess.stdout).text()])
      const filePath = output.trim()
      if (exitCode === 0 && filePath) await sendFile(filePath)
    } catch (error) {
      showStatus(`Could not open file picker: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      filePickerOpen.current = false
    }
  }

  function defaultDownloadPath(filename: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || ""
    const dl = home ? `${home}/Downloads/${filename}` : filename
    // Use forward slashes for display; backend normalizes
    return dl.replace(/\\/g, "/")
  }

  async function downloadFile(fileId: string, destPath: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const trimmed = destPath.trim()
      if (!trimmed) throw new Error("Destination path required")
      const response = await ipc.send("file_download", { file_id: fileId, dest_path: trimmed })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus(`Saved ${response.dest_path as string}`)
      closeDialog()
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function loadFilesDir() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("files_dir")
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      setDialog({ kind: "files-dir", filesDir: response.files_dir as string, env: response.env as string | undefined, configured: response.configured as string | undefined, dataDir: response.data_dir as string | undefined })
      setDialogDraft(response.files_dir as string)
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  async function setFilesDir(path: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const trimmed = path.trim()
      if (!trimmed) throw new Error("Path required")
      const response = await ipc.send("files_dir", { path: trimmed })
      if (response.error) throw new Error(response.error)
      if (dialogAction.current !== action) return
      showStatus(`Files storage set to ${response.files_dir as string}. New files will go there.`)
      setDialog({ kind: "files-dir", filesDir: response.files_dir as string, env: response.env as string | undefined, configured: response.configured as string | undefined, dataDir: response.data_dir as string | undefined })
      setDialogDraft(response.files_dir as string)
    } catch (error) {
      failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  // Drag-and-drop / paste file path into composer (cross-platform)
  // Terminals paste dropped file as bracketed paste with path text.
  usePaste((event) => {
    if (dialog || editingName) return
    try {
      const raw = decodePasteBytes(event.bytes).trim()
      if (!raw) return
      let candidate = raw.split("\n")[0].trim()
      if (candidate.startsWith("file://")) {
        candidate = decodeURIComponent(candidate.replace(/^file:\/\//, ""))
        if (/^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1)
      }
      candidate = candidate.replace(/^["']|["']$/g, "").trim()
      const candidates = [candidate]
      if (candidate.includes(" ") && !existsSync(candidate)) {
        const m = raw.match(/"[^"]+"|'[^']+'|\S+/g)
        if (m && m[0]) candidates.unshift(m[0].replace(/^["']|["']$/g, ""))
      }
      for (const p of candidates) {
        try {
          if (p && existsSync(p) && statSync(p).isFile()) {
            if (!selection) {
              showStatus("Select a peer or group before dropping files.")
              return
            }
            setTimeout(() => {
              const c = composerRef.current
              if (c) {
                const cur = c.plainText
                if (cur.includes(p) || cur.includes(raw.slice(0, 50))) {
                  c.selectAll()
                  c.deleteSelection()
                  setDraftLength(0)
                  if (selectionKey) setDrafts((d) => ({ ...d, [selectionKey]: "" }))
                  setComposerHeight(MIN_COMPOSER_HEIGHT)
                }
              }
            }, 30)
            void sendFile(p)
            return
          }
        } catch {}
      }
    } catch {}
  })

  function runCommand(command: string) {
    if (command === "control") {
      showDialog({ kind: "control" })
    } else if (command === "rooms") {
      showDialog({ kind: "rooms", rooms: [] })
      void loadRooms()
    } else if (command === "group-details") {
      const group = groups.find((item) => item.group_id === selectedGroupId)
      if (!group) { showStatus("Select a group first."); return }
      showDialog({ kind: "group-detail", group, members: groupMembers[group.group_id] ?? [] })
      void loadGroupDetails(group)
    } else if (command === "friends") {
      showDialog({ kind: "friends" })
    } else if (command === "notifications") {
      showDialog({ kind: "notifications" })
    } else if (command === "accessibility") {
      showDialog({ kind: "accessibility" })
    } else if (command === "advanced") {
      void loadAdvancedConfig()
    } else if (command === "rename") {
      const displayName = identity?.display_name ?? ""
      setNameDraft(displayName)
      setDialogDraft(displayName)
      setDialogError("")
      setDialog({ kind: "rename" })
    } else if (command === "mute") {
      const peer = peers.find((p) => p.peer_id === selectedPeerId)
      if (!peer) { showStatus("Select a peer to mute."); return }
      if (peer.peer_id === identity?.peer_id) { showStatus("You cannot mute yourself."); return }
      if (!peer.is_online) { showStatus(`${peer.display_name} is not online.`); return }
      if (mutedPeers[peer.peer_id]) { showStatus(`${peer.display_name} is already muted.`); return }
      showDialog({ kind: "mute-timeout", peerId: peer.peer_id, displayName: peer.display_name })
    } else if (command === "unmute") {
      const peer = peers.find((p) => p.peer_id === selectedPeerId)
      if (!peer) { showStatus("Select a peer to unmute."); return }
      if (!mutedPeers[peer.peer_id]) { showStatus(`${peer.display_name} is not muted.`); return }
      showDialog({ kind: "unmute-confirm", peerId: peer.peer_id, displayName: peer.display_name })
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
    } else if (command === "send-file") {
      if (!selection) { showStatus("Select a peer or group before sending a file."); return }
      showDialog({ kind: "file-send" })
    } else if (command === "files") {
      showDialog({ kind: "file-list", files: [] })
      void loadFiles()
    } else if (command === "about") {
      showDialog({ kind: "about" })
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
    if (key.ctrl && key.name === "u") {
      void openFilePicker()
      return
    }
    if (key.ctrl && key.name === "d") {
      void removeSelectedPeer()
      return
    }
    if ((key.name === "up" || key.name === "down") && key.ctrl && (peers.length || groups.length)) {
      const conversations: Conversation[] = [
        ...peers.map((peer) => ({ kind: "peer" as const, id: peer.peer_id })),
        ...groups.map((group) => ({ kind: "group" as const, id: group.group_id })),
      ]
      const index = conversations.findIndex((item) => item.kind === selection?.kind && item.id === selection.id)
      const direction = key.name === "up" ? -1 : 1
      setSelection(conversations[(index + direction + conversations.length) % conversations.length])
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
    const content = composer?.plainText.trim() ?? ""
    if (!content) {
      showStatus("Message is empty.")
      return
    }
    if (!selection || !selectionKey || !identity) {
      showStatus("Select a peer or group before sending.")
      return
    }
    if (new TextEncoder().encode(content).length > MAX_MESSAGE_BYTES) {
      showStatus("Message exceeds the 30 KiB limit.")
      return
    }
    setIsSending(true)
    try {
      const response = selection.kind === "peer"
        ? await ipc.send("send", { recipient_id: selection.id, content })
        : await ipc.send("group_send", { group_id: selection.id, content })
      if (response.error) throw new Error(response.error)
      const queued = Boolean(response.queued)
      setMessages((current) => [...current, {
        message_id: response.message_id as string,
        sender_id: identity.peer_id,
        ...(selection.kind === "peer" ? { recipient_id: selection.id } : { group_id: selection.id, deliveries: response.deliveries as GroupDelivery[] }),
        content,
        created_at: Date.now() / 1000,
        delivered: 0,
        queued: queued ? 1 : 0,
      }])
      if (composer && composer === composerRef.current) {
        composer.selectAll()
        composer.deleteSelection()
      }
      setDrafts((current) => ({ ...current, [selectionKey]: "" }))
      setDraftLength(0)
      setComposerHeight(MIN_COMPOSER_HEIGHT)
      showStatus(selection.kind === "group"
        ? `Group message sent: ${groupDeliveryLabel(response.deliveries as GroupDelivery[])}.`
        : queued
          ? "Message stored and queued. It will send when the peer is online."
          : "Message sent. Waiting for delivery confirmation.")
    } catch (error) {
      if (!backendDisconnected.current) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No known public key")) {
          showStatus(`You must connect to ${selected?.display_name ?? "this peer"} at least once before offline messages can be queued.`)
        } else {
          setStatus(`Send error: ${message}`)
        }
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
  const selectedVersionMismatch = selected && (selected.version_mismatch ?? versionMismatches[selected.peer_id])
  const selectedIsIncompatible = Boolean(selectedVersionMismatch)
  const incompatiblePeerMessage = selectedVersionMismatch
    ? `Incompatible peer protocol: peer supports v${selectedVersionMismatch.remote_min === -1 ? 0 : selectedVersionMismatch.remote_min}-v${selectedVersionMismatch.remote_version === -1 ? 0 : selectedVersionMismatch.remote_version}; local supports v${selectedVersionMismatch.local_min}-v${selectedVersionMismatch.local_version}. Most features are disabled.`
    : ""
  const selectedGroup = groups.find((group) => group.group_id === selectedGroupId)
  const conversationFiles = useMemo(() => fileTransfers.filter((f) => {
    if (!f.file_path) return false
    if (f.status !== "completed" && f.status !== "sent") return false
    if (selection?.kind === "peer") {
      return !f.group_id && (f.sender_id === selection.id || f.recipient_id === selection.id)
    }
    if (selection?.kind === "group") {
      return f.group_id === selection.id
    }
    return false
  }).sort((a, b) => a.created_at - b.created_at), [fileTransfers, selection])
  const conversationItems = useMemo<ConversationItem[]>(() => [
    ...messages.map((message) => ({ type: "message" as const, createdAt: message.created_at, message })),
    ...conversationFiles.map((file) => ({ type: "file" as const, createdAt: file.created_at, file })),
  ].sort((a, b) => a.createdAt - b.createdAt || (a.type === b.type ? 0 : a.type === "message" ? -1 : 1)), [messages, conversationFiles])
  const incompatibleGroupMembers = selectedGroup
    ? (groupMembers[selectedGroup.group_id] ?? []).filter((member) => member.is_incompatible)
    : []
  const activeCount = peers.filter((peer) => peerPresence(peer) === "active").length
  const sidebarWidth = width < 72 ? 22 : 32
  const compact = width < 72
  const limitColor = composerLimitColor(draftLength)
  const dialogWidth = Math.min(68, Math.max(1, width - 4))
  const dialogHeight = Math.min(20, Math.max(1, height - 4))
  function dialogWidthFor(kind: Dialog["kind"]): number {
    if (kind === "room-detail" || kind === "group-detail") return Math.min(78, Math.max(1, width - 2))
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
        <box title={`Peers: ${activeCount} active`} bottomTitle="Ctrl+D removes offline" style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 3, flexDirection: "column", padding: 1 }}>
          <scrollbox
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
            contentOptions={{ flexDirection: "column" }}
            verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
          >
            {!peers.length ? <text fg="#888888">No peers discovered</text> : null}
            {peers.map((peer) => {
              const presence = peerPresence(peer)
              const mismatch = peer.version_mismatch ?? versionMismatches[peer.peer_id]
              const muted = peer.peer_id in mutedPeers
              return <box
                key={peer.peer_id}
                onMouseDown={() => {
                  setSelection({ kind: "peer", id: peer.peer_id })
                  setScrollFocused(false)
                }}
                style={{ width: "100%", flexDirection: "column", backgroundColor: peer.peer_id === selectedPeerId ? "#25354d" : undefined }}
              >
                <text truncate fg={mismatch ? "#66dd88" : presence === "active" ? "#66dd88" : presence === "away" ? "#e0a34a" : "#888888"}>
                  {peer.peer_id === selectedPeerId ? "> " : "  "}{compact ? peer.display_name.slice(0, 10) : peer.display_name} {mismatch ? <span fg="#ff5555">INCOMPATIBLE</span> : presence}{peer.unread_count ? ` (${peer.unread_count} new)` : ""}{friendMarkers(peer)}{muted ? " M" : ""}
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
        <box title={`Groups: ${groups.length}`} style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 3, flexDirection: "column", padding: 1 }}>
          <scrollbox
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
            contentOptions={{ flexDirection: "column" }}
            verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
          >
            {!groups.length ? <text fg="#888888">No groups joined</text> : null}
            {groups.map((group) => (
              <box
                key={group.group_id}
                onMouseDown={() => {
                  setSelection({ kind: "group", id: group.group_id })
                  setScrollFocused(false)
                }}
                style={{ width: "100%", flexDirection: "column", backgroundColor: group.group_id === selectedGroupId ? "#25354d" : undefined }}
              >
                <text truncate fg="#b69cff">
                  {group.group_id === selectedGroupId ? "> " : "  "}{compact ? group.name.slice(0, 14) : group.name}{group.unread_count ? ` (${group.unread_count} new)` : ""}
                </text>
                <text fg="#718096">  {group.member_count} member{group.member_count === 1 ? "" : "s"}</text>
                {group.group_id === selectedGroupId && groupMembers[group.group_id]?.filter((member) => member.show_in_sidebar !== false).map((member, index) => {
                  const memberId = member.peer_id ?? member.member_id
                  const knownPeer = peers.find((peer) => peer.peer_id === memberId)
                  const color = memberId === identity?.peer_id
                    ? "#65a9ff"
                    : knownPeer
                      ? peerPresence(knownPeer) === "active" ? "#66dd88" : peerPresence(knownPeer) === "away" ? "#e0a34a" : "#888888"
                      : member.is_online ? "#66dd88" : "#888888"
                  return <text key={memberId ?? String(index)} truncate fg={color}>
                    {"    "}{compact ? member.display_name.slice(0, 12) : member.display_name}
                  </text>
                })}
              </box>
            ))}
          </scrollbox>
        </box>
      </box>

      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", gap: 1 }}>
        {controlStatus.control_url && !controlStatus.connected ? (
          <box style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
            <text wrapMode="word" fg={(flashingEnabled ? blinkOn : true) ? "#ff9f43" : "#7a4b12"}>
              <b>Out-of-sync with rendezvous server. Peer connectivity may degrade over time;</b> reconnecting ({controlStatus.reconnect_attempts}).
            </text>
          </box>
        ) : null}
        <box
          title={selectedGroup ? `Group: ${selectedGroup.name} (${selectedGroup.member_count} members)` : selected ? `Chat: ${selected.display_name}${selected.is_friend ? " \u2665" : ""}${selected.peer_id in mutedPeers ? " (muted)" : ""} (${selectedIsIncompatible ? "incompatible" : peerPresence(selected) === "offline" ? "offline" : `${peerPresence(selected)}: ${transportName(selected.active_transport)} ${selected.active_endpoint ?? ""}`})${selected.protocol_version != null ? ` protocol: v${selected.protocol_version}${selected.remote_protocol_version != null ? ` (max: v${selected.remote_protocol_version === -1 ? 0 : selected.remote_protocol_version})` : ""}` : ""}` : "Chat"}
          bottomTitle={compact ? "PgUp/PgDn scroll" : "PgUp/PgDn scroll  End latest  Drag text to select"}
          style={{ border: true, borderColor: scrollFocused ? "#6ea8fe" : undefined, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}
        >
          {(selected && ((selected.delivery_warnings ?? []).length > 0 || selectedIsIncompatible)) ? (
            <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
              {(selected.delivery_warnings ?? []).map((kind) => {
                if (kind === "offline") {
                  return <text key="offline" wrapMode="word" fg="#e0a34a">This peer is offline. Messages will be queued and delivered automatically upon reconnection.</text>
                }
                if (kind === "not_friend") {
                  return <text key="not_friend" wrapMode="word" fg="#e0a34a">Not friends yet. Your messages will be blocked until they accept your friend request (commands {'>'} friends {'>'} add friend).</text>
                }
                if (kind === "incompatible" && selectedVersionMismatch) {
                  return <text key="incompatible" wrapMode="word" fg={(flashingEnabled ? blinkOn : true) ? "#ff5555" : "#8a2e2e"}><b>{incompatiblePeerMessage}</b></text>
                }
                return null
              })}
              {selectedIsIncompatible && !(selected.delivery_warnings ?? []).includes("incompatible") ? (
                <text wrapMode="word" fg={(flashingEnabled ? blinkOn : true) ? "#ff5555" : "#8a2e2e"}><b>{incompatiblePeerMessage}</b></text>
              ) : null}
            </box>
          ) : null}
          {selectedGroup && incompatibleGroupMembers.length > 0 ? (
            <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
              <text wrapMode="word" fg="#ff9f43">
                Some group peers are incompatible: {incompatibleGroupMembers.map((member) => member.display_name).join(", ")}. Most features are disabled for these peers.
              </text>
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
            {!selected && !selectedGroup ? <text fg="#888888">Select a peer or group.</text> : null}
            {selected && !conversationItems.length && selected.is_online ? <text fg="#888888">No messages yet. Say hello.</text> : null}
            {selectedGroup && !conversationItems.length ? <text fg="#888888">No messages yet. Say hello to the group.</text> : null}
            {conversationItems.map((item, index) => {
              const rows: ReactNode[] = []
              const prev = conversationItems[index - 1]
              if (!prev || dayKey(prev.createdAt) !== dayKey(item.createdAt)) {
                rows.push(
                  <box key={`sep-${dayKey(item.createdAt)}`} style={{ alignItems: "center", marginTop: 1, marginBottom: 1 }}>
                    <text fg="#5b6b82">───── {formatDateSeparator(item.createdAt)} ─────</text>
                  </box>
                )
              }
              if (item.type === "file") {
                const file = item.file
                const isLocal = file.sender_id === identity?.peer_id
                const senderName = peers.find((peer) => peer.peer_id === file.sender_id)?.display_name
                  ?? groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === file.sender_id)?.display_name
                  ?? "Unknown member"
                rows.push(
                  <box key={`file-${file.file_id}`} style={{ flexDirection: "column", marginBottom: 1 }}>
                    <text>
                      <span fg="#888888">{formatTime(file.created_at)} </span>
                      <span fg={isLocal ? "#65a9ff" : "#66dd88"}>{isLocal ? "You" : selectedGroup ? senderName : selected?.display_name}</span>
                      <span fg="#888888"> shared an attachment</span>
                    </text>
                    <text wrapMode="word"><span fg="#7aa2d6">{file.filename}</span><span fg="#888888"> · {(file.file_size / 1024).toFixed(1)} KiB</span></text>
                    {isImageFile(file.filename) && (
                      <image key={`${file.file_id}-${file.completed_at ?? 0}-${imageRenderGeneration}`} source={toFileUrl(file.file_path!, file.completed_at)} fit="fit" protocol="auto" style={{ width: 40, height: 12 }} onError={() => {}} />
                    )}
                  </box>
                )
                return rows
              }
              const message = item.message
              const isLocal = message.sender_id === identity?.peer_id
              const delivered = Boolean(message.delivered) || deliveredMessageIds.has(message.message_id)
              const blocked = Boolean(message.blocked)
              const queued = Boolean(message.queued)
              const failed = Boolean(message.failed)
              const isSystem = Boolean(selectedGroup && message.kind && message.kind !== "message" && message.kind !== "text")
              const senderName = groupMembers[selectedGroupId ?? ""]?.find((member) => (member.peer_id ?? member.member_id) === message.sender_id)?.display_name
                ?? peers.find((peer) => peer.peer_id === message.sender_id)?.display_name
                ?? "Unknown member"
              const renderedContent = isSystem
                ? message.kind === "join"
                  ? `${isLocal ? "You" : senderName} joined the group`
                  : message.kind === "leave"
                    ? `${isLocal ? "You" : senderName} left the group`
                    : message.content
                : message.content
              const showReceived =
                typeof message.received_at === "number" &&
                formatTimeMinute(message.received_at) !== formatTimeMinute(message.created_at)
              rows.push(
                <box key={message.message_id} style={{ flexDirection: "column", marginBottom: 1 }}>
                  <text>
                    <span fg="#888888">{formatTime(message.created_at)} </span>
                    <span fg={isSystem ? "#e0a34a" : isLocal ? "#65a9ff" : "#66dd88"}>{isSystem ? "System" : isLocal ? "You" : selectedGroup ? senderName : selected?.display_name}</span>
                    {isLocal && !isSystem && (
                      <span fg={blocked || failed ? "#ff7777" : queued ? "#d9b36b" : "#888888"}>
                        {selectedGroup ? ` ${groupDeliveryLabel(message.deliveries)}` : blocked ? " blocked" : failed ? " disabled" : queued ? " stored and queued" : delivered ? " delivered" : " sent"}
                      </span>
                    )}
                    {showReceived && <span fg="#888888"> ({isLocal ? "delivered at " : "received at "}{formatDateTime(message.received_at!)})</span>}
                  </text>
                  <text wrapMode="word">{renderedContent}</text>
                </box>
              )
              return rows
            })}
           </scrollbox>
         </box>

        <box
          title={selectedGroup || selected?.is_online ? (compact ? "Message" : "Message: Enter sends, Alt+Enter adds a line") : "Message: queued until peer is online"}
          bottomTitle={isSending ? "Sending..." : `${draftLength.toLocaleString()} / ${MAX_MESSAGE_BYTES.toLocaleString()} bytes`}
          titleColor={limitColor ?? "#888888"}
          style={{ border: true, borderColor: limitColor ?? (!scrollFocused && !editingName && (selected?.is_online || selectedGroup) ? "#6ea8fe" : undefined), flexShrink: 0, overflow: "hidden", padding: 1 }}
        >
          <textarea
            key={selectionKey ?? "no-conversation"}
            ref={composerRef}
            initialValue={selectionKey ? drafts[selectionKey] ?? "" : ""}
            placeholder={selectedGroup ? `Message ${selectedGroup.name} — drop file/image here` : selected ? "Write a message — drop file/image to send" : "Select a peer or group"}
            focused={Boolean(selected || selectedGroup) && !editingName && !scrollFocused && !isSending && !dialog}
            onMouseDown={() => setScrollFocused(false)}
            onContentChange={() => {
              const composer = composerRef.current
              const content = composer?.plainText ?? ""
              // If user typed/pasted a raw file path that exists, hint but let usePaste handle drop;
              // also support manual path entry: if draft is single line file path, allow Enter to send as file via Ctrl+P flow
              setDraftLength(new TextEncoder().encode(content).length)
              setComposerHeight(getComposerHeight(composer))
              if (selectionKey) setDrafts((current) => ({ ...current, [selectionKey]: content }))
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
      <box style={{ position: "absolute", right: 1, bottom: 0 }}>
        <text><span fg="#66dd88">● </span><span fg="#bbbbbb">MeshTalk </span><span fg="#888888">{typeof APP_VERSION !== "undefined" ? APP_VERSION : "dev"}</span></text>
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
              : dialog.kind.startsWith("advanced") ? "Advanced Configuration"
              : dialog.kind === "rename" ? "Display name"
              : dialog.kind === "mute-timeout" ? "Mute peer"
              : dialog.kind === "unmute-confirm" ? "Unmute peer"
              : dialog.kind === "add-friend" ? "Add friend"
              : dialog.kind === "remove-friend" ? "Remove friend"
              : dialog.kind === "friend-requests" ? "Friend requests"
              : dialog.kind === "friend-request-incoming" ? "Friend request"
              : dialog.kind === "friends" ? "Friends"
              : dialog.kind === "notifications" ? "Notifications"
              : dialog.kind === "notification-settings" ? "Desktop alerts"
              : dialog.kind === "notification-peer" ? "Selected peer alerts"
              : dialog.kind === "accessibility" ? "Accessibility"
              : dialog.kind === "blocked" ? "Blocked friends"
              : dialog.kind === "block-peer-pick" ? "Block a peer"
              : dialog.kind === "block-peer" ? "Block friend requests"
              : dialog.kind === "cancel-friend-confirm" ? "Cancel friend request"
              : dialog.kind === "debug-peer" ? "Peer details"
              : dialog.kind === "debug-endpoints" ? "Endpoints"
              : dialog.kind === "debug" ? "Debug"
              : dialog.kind === "update" ? "Update available"
              : dialog.kind === "about" ? "About MeshTalk"
              : dialog.kind === "group-detail" ? "Group details"
              : dialog.kind === "file-send" ? "Upload file"
              : dialog.kind === "file-list" ? "Files"
              : dialog.kind === "file-download" ? "Save file"
              : dialog.kind === "files-dir" ? "File storage"
              : "Private rooms"}
            bottomTitle={dialogBusy ? "Working..." : "Esc back  Ctrl+P commands"}
            style={{ width: dialogWidthFor(dialog.kind), height: dialogHeight, border: true, borderColor: dialog.kind === "about" ? "#9b8cff" : dialog.kind === "update" ? "#e0a34a" : "#6ea8fe", backgroundColor: "#111923", padding: 1, flexDirection: "column", gap: 1 }}
          >
            {dialog.kind === "commands" && (
              <>
                <text><span fg="#b9a7ff"><b>COMMAND CENTER</b></span> <span fg="#77718f">Choose an action</span></text>
                <text fg="#534b70">────────────────────────────────────────</text>
                <MouseSelect
                  focused
                  height={Math.max(5, dialogHeight - 5)}
                  options={[
                    { name: "Control server", description: "Set up or inspect remote discovery", value: "control" },
                    { name: "Private rooms", description: "Create, join, view, or leave rooms", value: "rooms" },
                    ...(selectedGroup ? [{ name: "Group details", description: `View members or leave ${selectedGroup.name}`, value: "group-details" }] : []),
                    { name: "Friends", description: "Add a friend, respond to requests, remove, or block", value: "friends" },
                    { name: "Send file", description: selection ? `Send a file to ${selection.kind === "peer" ? peers.find((p) => p.peer_id === selection.id)?.display_name ?? "peer" : groups.find((g) => g.group_id === selection.id)?.name ?? "group"}` : "Select a peer or group first", value: "send-file" },
                    { name: "Files", description: "View file transfer history and status", value: "files" },
                    { name: "Notifications", description: "Mute or unmute desktop notifications for the selected peer", value: "notifications" },
                    { name: "Accessibility", description: "Reduce motion and other accessibility options", value: "accessibility" },
                    { name: "Advanced Configuration", description: "Pin server IP addresses to bypass DNS", value: "advanced" },
                    { name: "Rename yourself", description: "Change the display name peers see", value: "rename" },
                    { name: "Debug", description: "Re-STUN and connection diagnostics", value: "debug" },
                    { name: "★  ABOUT & UPDATES  ★", description: "Version, credits, and check for updates", value: "about" },
                  ]}
                  onSelect={(_, option) => option && runCommand(option.value as string)}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "about" && (
              <box style={{ flexDirection: "column", gap: 1, backgroundColor: "#111923", width: "100%", height: "100%" }}>
                <text><span fg="#b9a7ff"><b>MeshTalk</b></span> <span fg="#77718f">terminal messenger</span></text>
                <text><span fg="#8fa7ff">Version </span><span fg="#66ddaa"><b>{APP_RELEASE_VERSION}</b></span></text>
                <text><span fg="#e0a34a">Made with love</span> <span fg="#bbbbbb">by </span><span fg="#ff8fa3">Raymont</span><span fg="#bbbbbb"> and </span><span fg="#8fa7ff">friends.</span></text>
                {dialog.checked && <text fg={IS_RELEASE_BUILD ? "#66dd88" : "#ff5555"}>{IS_RELEASE_BUILD ? "You are up to date, or release metadata is unavailable." : "Updates are available only in compiled MeshTalk releases."}</text>}
                {dialogError && <text fg="#ff7777">{dialogError}</text>}
                <MouseSelect
                  focused
                  height={Math.max(3, dialogHeight - 7)}
                  options={[
                    { name: dialog.checking ? "Checking for updates..." : "Check for updates", description: IS_RELEASE_BUILD ? "Look for the latest stable MeshTalk release" : "Available in compiled MeshTalk releases", value: "check" },
                    { name: "Back", description: "Return to Commands", value: "back" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "check" && !dialog.checking) void checkForUpdatesFromAbout()
                    else if (option?.value === "back") goBack()
                  }}
                  wrapSelection
                  showDescription
                />
              </box>
            )}
            {dialog.kind === "update" && (
              <>
                <text><b>MeshTalk {dialog.release.version} is available.</b></text>
                <text fg="#bbbbbb">Installed version: {APP_RELEASE_VERSION}</text>
                <text fg="#bbbbbb">The download will be verified with GitHub's SHA-256 digest before installation.</text>
                {dialogError && <text fg="#ff7777">{dialogError}</text>}
                <MouseSelect
                  focused
                  height={Math.max(3, dialogHeight - 7)}
                  options={[
                    { name: "Install now", description: "Close MeshTalk and install the verified release", value: "install" },
                    { name: "Ignore", description: "Ask again the next time MeshTalk starts", value: "ignore" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "install") installUpdate(dialog.release)
                    else if (option?.value === "ignore") closeDialog()
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "control" && (
              <>
                {dialog.firstRun && <text fg="#e0a34a">Set up remote discovery to connect outside your LAN. You can skip this for LAN-only chat.</text>}
                <MouseSelect
                  focused
                  height={Math.max(6, dialogHeight - 4)}
                  options={[
                    { name: "Use MeshTalk public server", description: "wss://meshtalk-control.qincai.xyz/v1/rendezvous", value: "public" },
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
                <MouseSelect
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
            {dialog.kind === "advanced" && (
              <>
                <MouseSelect
                  focused
                  height={Math.max(5, dialogHeight - 3)}
                  options={[
                    { name: "Control server", description: dialog.config.control_pinned_ips.length ? `Pinned: ${dialog.config.control_pinned_ips.join(", ")}` : "No IP pin", value: "control" },
                    { name: "STUN server", description: dialog.config.stun_pinned_ips.length ? `Pinned: ${dialog.config.stun_pinned_ips.join(", ")}` : "No IP pin", value: "stun" },
                    { name: "Back to commands", description: "Return to the command palette", value: "back" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "control") {
                      showDialog({ kind: "advanced-control", config: dialog.config })
                    } else if (option?.value === "stun") {
                      showDialog({ kind: "advanced-stun", config: dialog.config })
                    } else if (option?.value === "back") {
                      showDialog({ kind: "commands" })
                    }
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "advanced-control" && (
              <MouseSelect
                focused
                height={Math.max(5, dialogHeight - 3)}
                options={[
                  { name: "Manual IP address", description: "Enter one or more comma-separated IPv4 or IPv6 addresses", value: "manual" },
                  { name: "Auto: resolve and pin", description: "Query A and AAAA records, then save the results as pins", value: "auto" },
                  ...(dialog.config.control_pinned_ips.length ? [{ name: "Remove IP pin", description: `Pinned: ${dialog.config.control_pinned_ips.join(", ")}`, value: "clear" }] : []),
                  { name: "Back", description: "Return to Advanced Configuration", value: "back" },
                ]}
                onSelect={(_, option) => {
                  if (option?.value === "manual") {
                    setDialogDraft(dialog.config.control_pinned_ips.join(", "))
                    setDialog({ kind: "advanced-control-ip" })
                  } else if (option?.value === "auto") {
                    void saveAdvancedConfig({ auto_control_pinned_ip: true }, "Control server addresses resolved and pinned.")
                  } else if (option?.value === "clear") {
                    void saveAdvancedConfig({ clear_control_pinned_ip: true }, "Control server IP pin cleared.")
                  } else if (option?.value === "back") {
                    showDialog({ kind: "advanced", config: dialog.config })
                  }
                }}
                wrapSelection
                showDescription
              />
            )}
            {dialog.kind === "advanced-stun" && (
              <MouseSelect
                focused
                height={Math.max(5, dialogHeight - 3)}
                options={[
                  { name: "Manual IP address", description: "Enter one or more comma-separated IPv4 addresses", value: "manual" },
                  { name: "Auto: resolve and pin", description: "Query A records, then save the results as pins", value: "auto" },
                  ...(dialog.config.stun_pinned_ips.length ? [{ name: "Remove IP pin", description: `Pinned: ${dialog.config.stun_pinned_ips.join(", ")}`, value: "clear" }] : []),
                  { name: "Back", description: "Return to Advanced Configuration", value: "back" },
                ]}
                onSelect={(_, option) => {
                  if (option?.value === "manual") {
                    setDialogDraft(dialog.config.stun_pinned_ips.join(", "))
                    setDialog({ kind: "advanced-stun-ip" })
                  } else if (option?.value === "auto") {
                    void saveAdvancedConfig({ auto_stun_pinned_ip: true }, "STUN server addresses resolved and pinned.")
                  } else if (option?.value === "clear") {
                    void saveAdvancedConfig({ clear_stun_pinned_ip: true }, "STUN server IP pin cleared.")
                  } else if (option?.value === "back") {
                    showDialog({ kind: "advanced", config: dialog.config })
                  }
                }}
                wrapSelection
                showDescription
              />
            )}
            {dialog.kind === "advanced-control-ip" && (
              <>
                <text>Enter comma-separated IPv4 or IPv6 addresses for the control server.</text>
                <input focused value={dialogDraft} placeholder="104.21.6.171, 172.67.135.15, 2606:4700:3032::6815:6ab, 2606:4700:3037::ac43:870f" onInput={setDialogDraft} onSubmit={(value) => void saveAdvancedConfig({ control_pinned_ip: typeof value === "string" ? value : dialogDraft }, "Control server IPs pinned.")} maxLength={1024} />
                <text fg="#888888">Enter saves the IP pin.</text>
              </>
            )}
            {dialog.kind === "advanced-stun-ip" && (
              <>
                <text>Enter comma-separated IPv4 addresses for the STUN server.</text>
                <input focused value={dialogDraft} placeholder="203.0.113.10, 203.0.113.11" onInput={setDialogDraft} onSubmit={(value) => void saveAdvancedConfig({ stun_pinned_ip: typeof value === "string" ? value : dialogDraft }, "STUN server IPs pinned.")} maxLength={1024} />
                <text fg="#888888">Enter saves the IP pin.</text>
              </>
            )}
            {dialog.kind === "rooms" && (
              <>
                <MouseSelect
                  focused
height={Math.max(5, dialogHeight - 3)}
                options={[
                  { name: "Create a private room", description: "Generate a secret invite and copy it", value: "create" },
                  { name: "Join with an invite", description: "Paste a room or group invite", value: "join" },
                    ...dialog.rooms.map((room) => ({
                      name: room.name ?? `Room ${room.room_id.slice(0, 12)}`,
                      description: `${room.members} control connection${room.members === 1 ? "" : "s"} - view or leave`,
                      value: room.room_id,
                    })),
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "create") showDialog({ kind: "room-create" })
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
            {dialog.kind === "room-create" && (
              <>
                <text>Choose a name for the new group.</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder="Group name"
                  onInput={setDialogDraft}
                  onSubmit={(value) => void createRoom(typeof value === "string" ? value : dialogDraft)}
                  maxLength={80}
                />
                <text fg="#888888">Enter creates the group and copies its secret invite.</text>
              </>
            )}
            {dialog.kind === "room-join" && (
              <>
                <text>Paste the secret invite you received from another room member.</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder="meshtalk:... or meshtalk-group:..."
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
                <MouseSelect
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
                <MouseSelect
                  focused
                  height={6}
                  options={[
                    { name: "Keep room", description: "Return without making changes", value: "keep" },
                    { name: "Copy invite", description: "Reveal and copy this room's secret invite", value: "copy" },
                    { name: "Leave room", description: "Permanently remove this room from this device", value: "leave" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "leave") {
                      const group = groups.find((item) => item.group_id === dialog.room.group_id)
                      if (group) void leaveGroup(group)
                      else void leaveRoom(dialog.room.room_id)
                    }
                    else if (option?.value === "copy") void loadRoomInvite(dialog.room.room_id)
                    else void loadRooms()
                  }}
                />
              </>
            )}
            {dialog.kind === "group-detail" && (
              <>
                <text><span fg="#888888">Name: </span>{dialog.group.name}</text>
                <text><span fg="#888888">Group ID: </span>{dialog.group.group_id}</text>
                <scrollbox
                  style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
                  contentOptions={{ flexDirection: "column" }}
                  verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
                >
                  {!dialog.members.length ? <text fg="#888888">No member details available.</text> : null}
                  {dialog.members.map((member, index) => (
                    <text key={member.peer_id ?? member.member_id ?? String(index)}>
                      <span fg={(member.peer_id ?? member.member_id) === identity?.peer_id ? "#65a9ff" : "#66dd88"}>{member.display_name}</span>
                      <span fg="#718096"> {(member.peer_id ?? member.member_id ?? "").slice(0, 12)}</span>
                    </text>
                  ))}
                </scrollbox>
                <MouseSelect
                  focused
                  height={4}
                  options={[
                    { name: "Close", description: "Return to the group chat", value: "close" },
                    { name: "Leave group", description: "Remove this group from this device", value: "leave" },
                  ]}
                  onSelect={(_, option) => option?.value === "leave" ? void leaveGroup(dialog.group) : closeDialog()}
                  wrapSelection
                  showDescription
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
                <MouseSelect
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
                <MouseSelect
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
                <MouseSelect
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
                  <MouseSelect
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
                <MouseSelect
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
              <MouseSelect
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
            {dialog.kind === "notification-enable" && (
              <>
                <text fg="#bbbbbb">{dialogBusy ? "Switch to another terminal tab now. The test will be sent in four seconds." : "Would you like MeshTalk to send desktop notifications?"}</text>
                <MouseSelect
                  focused
                  height={Math.max(4, dialogHeight - 5)}
                  options={[
                    { name: "Enable and test", description: "Send a test through your terminal notification protocol", value: "enable" },
                    { name: "Not now", description: "Keep desktop notifications off; configure them later in Commands", value: "disable" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "enable") void testNotificationDelivery("terminal", dialog.firstRun)
                    else if (option?.value === "disable") void disableNotifications(dialog.firstRun)
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "notification-confirm" && (
              <>
                <text fg="#bbbbbb">A test notification was sent using {dialog.delivery === "terminal" ? "your terminal" : "your operating system"}.</text>
                {dialog.delivery === "native" && process.platform === "darwin" && <text fg="#e0a34a">macOS can suppress banners in Focus mode or when terminal-notifier, Script Editor, or osascript alerts are disabled in System Settings {'>'} Notifications.</text>}
                <MouseSelect
                  focused
                  height={Math.max(4, dialogHeight - 5)}
                  options={[
                    { name: "I received it", description: "Use this notification method", value: "confirm" },
                    { name: "I did not receive it", description: dialog.delivery === "terminal" ? "Try your operating system's native notification method" : "Leave notifications disabled", value: "missing" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "confirm") void confirmNotificationDelivery(dialog.delivery, dialog.firstRun)
                    else if (option?.value === "missing" && dialog.delivery === "terminal") showDialog({ kind: "notification-fallback", firstRun: dialog.firstRun })
                    else if (option?.value === "missing") void disableNotifications(dialog.firstRun)
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "notification-fallback" && (
              <>
                <text fg="#e0a34a">Terminal notifications are unavailable or were not received. Try a native desktop notification instead.</text>
                {dialogError && <text fg="#ff7777">{dialogError}</text>}
                <MouseSelect
                  focused
                  height={Math.max(4, dialogHeight - 6)}
                  options={[
                    { name: "Test native notification", description: "Use macOS, Linux, or Windows notification support", value: "test" },
                    { name: "Disable notifications", description: "You can configure this later in Commands", value: "disable" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "test") void testNotificationDelivery("native", dialog.firstRun)
                    else if (option?.value === "disable") void disableNotifications(dialog.firstRun)
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "notifications" && (
              <>
                <text fg="#888888">Choose what you want to manage.</text>
                <MouseSelect
                  focused
                  height={Math.max(4, dialogHeight - 4)}
                  options={[
                    { name: "Desktop alerts", description: "Delivery method, test alert, and alert types", value: "desktop" },
                    { name: "Selected peer alerts", description: selectedPeerId ? "Mute or unmute the selected peer" : "Select a peer first to manage their alerts", value: "peer" },
                    { name: "Back to commands", description: "Return to the command palette", value: "back" },
                  ]}
                  onSelect={(_, option) => {
                    if (option?.value === "desktop") showDialog({ kind: "notification-settings" })
                    else if (option?.value === "peer") showDialog({ kind: "notification-peer" })
                    else if (option?.value === "back") showDialog({ kind: "commands" })
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "notification-settings" && (() => {
              const options: { name: string; description: string; value: string }[] = []
              const configuredDelivery = notificationPreferences?.delivery ?? "disabled"
              options.push({
                name: configuredDelivery === "disabled" ? "Enable desktop notifications" : "Configure delivery method",
                description: configuredDelivery === "disabled" ? "Test terminal or native desktop notifications" : `Current method: ${configuredDelivery === "terminal" ? "terminal" : "native OS notification"}`,
                value: "configure",
              })
              if (configuredDelivery !== "disabled") {
                options.push({ name: "Test notification", description: "Send a test using the current delivery method", value: "test" })
                const eventLabels: [NotificationEvent, string][] = [
                  ["messages", "Messages"],
                  ["friend_requests", "Friend requests"],
                  ["file_offers", "Incoming files"],
                  ["file_completed", "Completed files"],
                ]
                for (const [event, label] of eventLabels) {
                  options.push({ name: `${notificationEventEnabled(event) ? "Disable" : "Enable"} ${label}`, description: `${notificationEventEnabled(event) ? "Stop" : "Allow"} desktop alerts for ${label.toLowerCase()}`, value: `event:${event}` })
                }
              }
              options.push({ name: "Back to Notifications", description: "Return to notification options", value: "back" })
              return (
                <>
                  {dialogBusy && notificationTestDelivery === "terminal" && <text fg="#e0a34a">Switch to another terminal tab now. The test will be sent in four seconds.</text>}
                  {dialogBusy && notificationTestDelivery === "native" && <text fg="#bbbbbb">Sending a native desktop notification...</text>}
                  <MouseSelect
                    focused
                    height={Math.max(5, dialogHeight - 4)}
                    options={options}
                    onSelect={(_, option) => {
                      if (!option) return
                      if (option.value === "back") showDialog({ kind: "notifications" })
                      else if (option.value === "configure") showDialog({ kind: "notification-enable" })
                      else if (option.value === "test" && configuredDelivery !== "disabled") void testNotificationDelivery(configuredDelivery)
                      else if (option.value.startsWith("event:")) void toggleNotificationEvent(option.value.slice("event:".length) as NotificationEvent)
                    }}
                    wrapSelection
                    showDescription
                  />
                </>
              )
            })()}
            {dialog.kind === "notification-peer" && (() => {
              const peer = peers.find((p) => p.peer_id === selectedPeerId)
              const isMuted = peer ? !!mutedPeers[peer.peer_id] : false
              const isOnline = peer ? peer.is_online : false
              const isSelf = peer ? peer.peer_id === identity?.peer_id : false
              const options: { name: string; description: string; value: string }[] = []
              if (peer && !isMuted && isOnline && !isSelf) {
                options.push({ name: "Mute", description: `Mute notifications from ${peer.display_name}`, value: "mute" })
              }
              if (peer && isMuted) {
                options.push({ name: "Unmute", description: `Resume notifications from ${peer.display_name}`, value: "unmute" })
              }
              options.push({ name: "Back to Notifications", description: "Return to notification options", value: "back" })
              return (
                <>
                  {!peer && <text fg="#888888">Select a peer in the sidebar first.</text>}
                  {peer && isSelf && <text fg="#888888">You cannot mute or unmute yourself.</text>}
                  {peer && !isSelf && !isOnline && !isMuted && <text fg="#888888">{peer.display_name} is not online.</text>}
                  <MouseSelect
                    focused
                    height={Math.max(5, dialogHeight - 4)}
                    options={options}
                    onSelect={(_, option) => {
                      if (!option) return
                      if (option.value === "back") showDialog({ kind: "notifications" })
                      else runCommand(option.value)
                    }}
                    wrapSelection
                    showDescription
                  />
                </>
              )
            })()}
            {dialog.kind === "accessibility" && (
              <>
                <text fg="#888888">Reduce motion and other accessibility options.</text>
                <MouseSelect
                  focused
                  height={Math.max(4, dialogHeight - 4)}
                  options={[
                    {
                      name: flashingEnabled ? "Disable Flashing" : "Re-enable Flashing",
                      description: flashingEnabled
                        ? "Stop incompatible-protocol and rendezvous warnings from blinking"
                        : "Allow incompatible-protocol and rendezvous warnings to blink",
                      value: "toggle-flash",
                    },
                    { name: "Back to commands", description: "Return to the command palette", value: "back" },
                  ]}
                  onSelect={(_, option) => {
                    if (!option) return
                    if (option.value === "toggle-flash") void setAccessibilityFlashing(!flashingEnabled)
                    else showDialog({ kind: "commands" })
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "blocked" && (
              <>
                {!dialog.blocked.length && <text fg="#888888">No blocked peers. Blocked peers cannot send you friend requests.</text>}
                {dialog.blocked.length > 0 && (
                  <MouseSelect
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
                  <MouseSelect
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
                <MouseSelect
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
                <MouseSelect
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
                <MouseSelect
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
                <MouseSelect
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
                <MouseSelect
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
                  <MouseSelect
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
            {dialog.kind === "file-send" && (
              <>
                <text>Enter full file path to send to <span fg="#66dd88">{selection?.kind === "peer" ? peers.find((p)=>p.peer_id===selection.id)?.display_name ?? selection.id.slice(0,8) : groups.find((g)=>g.group_id===selection?.id)?.name ?? "group"}</span></text>
                <text fg="#888888">Works cross-platform. Windows: C:\path\to\file  macOS/Linux: /path/to/file</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder={process.platform === "win32" ? "C:\\Users\\you\\Documents\\file.txt" : "/home/you/file.txt"}
                  onInput={setDialogDraft}
                  onSubmit={(value) => void sendFile(typeof value === "string" ? value : dialogDraft)}
                  maxLength={4096}
                />
                <text fg="#888888">Enter sends. Path must be readable by the MeshTalk backend. Files up to 50 MiB.</text>
              </>
            )}
            {dialog.kind === "file-list" && (
              <>
                <scrollbox
                  style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
                  contentOptions={{ flexDirection: "column" }}
                  verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
                >
                  {!dialog.files.length && <text fg="#888888">No file transfers yet.</text>}
                  {dialog.files.map((f) => (
                    <box key={f.file_id} style={{ flexDirection: "column", paddingBottom: 1 }}>
                      <text><span fg={f.direction === "inbound" ? "#66dd88" : "#65a9ff"}>{f.direction === "inbound" ? "↓" : "↑"}</span> {f.filename} ({(f.file_size/1024).toFixed(1)} KiB) <span fg="#888888">{f.status}</span></text>
                      <text fg="#888888">  {f.file_id.slice(0,8)} {f.direction === "inbound" ? `from ${f.sender_id.slice(0,8)}` : `to ${f.recipient_id.slice(0,8)}`} {f.file_path ?? ""} {isImageFile(f.filename) ? "(image)" : ""}</text>
                      {f.status === "completed" && f.file_path && isImageFile(f.filename) && (
                      <image key={`${f.file_id}-${f.completed_at ?? 0}-${imageRenderGeneration}`} source={toFileUrl(f.file_path, f.completed_at)} fit="fit" protocol="auto" style={{ width: 20, height: 6 }} onError={() => {}} />
                      )}
                    </box>
                  ))}
                </scrollbox>
                <MouseSelect
                  focused
                  height={Math.min(8, dialogHeight - 4)}
                  options={[
                    ...dialog.files.filter((f) => f.status === "completed" || f.status === "sent").map((f) => ({
                      name: `Save ${f.filename} to...`,
                      description: `${f.file_id.slice(0,8)} -> choose destination`,
                      value: `dl:${f.file_id}`,
                    })),
                    { name: "Storage location", description: "View/change where received files are saved (e.g., E:\\ drive)", value: "storage" },
                    { name: "Refresh", description: "Reload file list", value: "refresh" },
                    { name: "Back", description: "Return to commands", value: "back" },
                  ]}
                  onSelect={(_, option) => {
                    if (!option) return
                    if (option.value === "refresh") void loadFiles()
                    else if (option.value === "back") showDialog({ kind: "commands" })
                    else if (option.value === "storage") void loadFilesDir()
                    else if (option.value.startsWith("dl:")) {
                      const fid = option.value.slice(3)
                      const f = dialog.files.find((x) => x.file_id === fid)
                      if (f) {
                        setDialogDraft(defaultDownloadPath(f.filename))
                        showDialog({ kind: "file-download", fileId: f.file_id, filename: f.filename, filePath: f.file_path ?? "" })
                      }
                    }
                  }}
                  wrapSelection
                  showDescription
                />
              </>
            )}
            {dialog.kind === "files-dir" && (
              <>
                <text>Files storage directory (cross-platform):</text>
                <text fg="#66dd88" wrapMode="word">{dialog.filesDir}</text>
                {dialog.env && <text fg="#e0a34a">Overridden by MESHTALK_FILES_DIR={dialog.env} (env var takes precedence)</text>}
                {dialog.configured && !dialog.env && <text fg="#888888">Custom (from settings.json)</text>}
                {!dialog.configured && !dialog.env && <text fg="#888888">Default: {dialog.dataDir}/files</text>}
                <text fg="#888888">Examples: Windows E:\MeshTalkFiles  Linux /mnt/e/MeshTalkFiles  macOS /Volumes/E/MeshTalkFiles</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder="E:\MeshTalkFiles"
                  onInput={setDialogDraft}
                  onSubmit={(v) => void setFilesDir(typeof v === "string" ? v : dialogDraft)}
                  maxLength={4096}
                />
                <text fg="#888888">Enter saves. New files go there; existing files stay in old location.</text>
                <MouseSelect
                  focused={false}
                  height={3}
                  options={[{ name: "Back to files", description: "Return to file list", value: "back" }]}
                  onSelect={() => void loadFiles()}
                />
              </>
            )}
            {dialog.kind === "file-download" && (
              <>
                <text>Save <span fg="#66dd88">{dialog.filename}</span> to:</text>
                <text fg="#888888">{dialog.filePath}</text>
                <input
                  focused
                  value={dialogDraft}
                  placeholder={defaultDownloadPath(dialog.filename)}
                  onInput={setDialogDraft}
                  onSubmit={(v) => void downloadFile(dialog.fileId, typeof v === "string" ? v : dialogDraft)}
                  maxLength={4096}
                />
                <text fg="#888888">Enter saves. Works on Linux/macOS/Windows. Path may be folder or file.</text>
              </>
            )}
            {dialogError && <text fg="#ff7777">{dialogError}</text>}
          </box>
        </box>
      )}
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
createRoot(renderer).render(<ChatApp />)
