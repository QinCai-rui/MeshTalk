import { createClipboard, createHostClipboard, createRendererClipboardAdapter, decodePasteBytes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { IPCClient, type IPCEvent } from "../../common/ipc-client"
import { existsSync, statSync } from "fs"
import { checkForUpdate } from "../../common/updater"
import type { Conversation, ConversationItem, Dialog, FileTransfer, Group, GroupMember, Message, Peer, VersionMismatch } from "./types"
import { composerLimitColor, DEFAULT_STATUS, getComposerHeight, MIN_COMPOSER_HEIGHT, peerPresence } from "./utils"
import { Sidebar } from "./components/Sidebar"
import { ConversationPanel } from "./components/ConversationPanel"
import { DialogPanel } from "./components/DialogPanel"
import { notify, truncatePreview, type NotificationDelivery, type NotificationPreferences } from "./notifications"
import { useChatActions } from "./useChatActions"

declare const APP_VERSION: string
declare const MESHTALK_RELEASE: boolean

const IS_RELEASE_BUILD = typeof MESHTALK_RELEASE !== "undefined" && MESHTALK_RELEASE
const APP_RELEASE_VERSION = typeof APP_VERSION !== "undefined" && APP_VERSION ? APP_VERSION : "dev"

export function ChatApp() {
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
  const [debugInfo, setDebugInfo] = useState<import("./types").DebugInfo | null>(null)
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

  const actions = useChatActions({
    ipc, clipboardRef: clipboard, renderer, backendDisconnectedRef: backendDisconnected,
    peers, setPeers, groups, setGroups, groupMembers, setGroupMembers, identity, setIdentity,
    selection, setSelection, selectedPeerId, selectedGroupId, messages, setMessages,
    drafts, setDrafts, draftLength, setDraftLength, composerHeight, setComposerHeight,
    isSending, setIsSending, nameDraft, setNameDraft, editingName, setEditingName,
    scrollFocused, setScrollFocused, deliveredMessageIds, setDeliveredMessageIds,
    status, setStatus, copyToast, setCopyToast, mutedPeers, setMutedPeers,
    notificationPreferences, setNotificationPreferences, notificationTestDelivery, setNotificationTestDelivery,
    versionMismatches, setVersionMismatches, flashingEnabled, setFlashingEnabled,
    controlStatus, setControlStatus, debugInfo, setDebugInfo, fileTransfers, setFileTransfers,
    dialog, setDialog, setDialogDraft, setDialogError, setDialogBusy,
    statusResetRef: statusReset, copyToastResetRef: copyToastReset, dialogActionRef: dialogAction,
    dialogBusyRef, filePickerOpenRef: filePickerOpen, composerRef, selectionKey,
  })

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
      await actions.refreshPeers()
      await actions.refreshGroups()
      void actions.refreshFiles()
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
            actions.showDialog({ kind: "update", release })
          }
        }).catch(() => {})
      }
      setStatus(DEFAULT_STATUS)
    }).catch((error) => {
      if (!backendDisconnected.current) {
        setStatus(`Backend error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return () => {
      void ipc.send("tui_presence", { client_id: tuiClientId, active: false }).finally(() => {
        ipc.close()
      })
    }
  }, [tuiClientId])

  useEffect(() => () => {
    if (statusReset.current) clearTimeout(statusReset.current)
    if (copyToastReset.current) clearTimeout(copyToastReset.current)
  }, [])

  useEffect(() => {
    const service = createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) })
    clipboard.current = service
    return () => { clipboard.current = null; void service.dispose() }
  }, [renderer])

  useEffect(() => {
    const refreshImages = () => setImageRenderGeneration((g) => g + 1)
    renderer.on("capabilities", refreshImages)
    return () => { renderer.off("capabilities", refreshImages) }
  }, [renderer])

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    if (!text) return
    void clipboard.current?.writeText(text, { destination: "all-available", allowRemoteHost: true }).then(() => {
      renderer.clearSelection()
      actions.showCopyToast()
    })
  })

  useEffect(() => {
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = ipc.onDisconnect(() => {
      backendDisconnected.current = true
      setStatus("Backend connection lost. Closing MeshTalk...")
      exitTimer = setTimeout(() => renderer.destroy(), 1500)
    })
    return () => { unsubscribe(); if (exitTimer) clearTimeout(exitTimer) }
  }, [ipc, renderer])

  useEffect(() => {
    const interval = setInterval(() => {
      void actions.refreshPeers().catch((error) => {
        if (!backendDisconnected.current) setStatus(`Peer refresh error: ${String(error)}`)
      })
      void actions.refreshGroups().catch((error) => {
        if (!backendDisconnected.current) setStatus(`Group refresh error: ${String(error)}`)
      })
      void actions.refreshGroupMembers().catch((error) => {
        if (!backendDisconnected.current && selectedGroupId) setStatus(`Group member refresh error: ${String(error)}`)
      })
      void actions.refreshFiles()
      void ipc.send("control").then((control) => {
        if (!control.error) setControlStatus({ connected: control.connected as boolean, reconnect_attempts: control.reconnect_attempts as number, control_url: control.url as string | null | undefined })
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [ipc, selectedGroupId])

  useEffect(() => {
    if (!flashingEnabled) return
    const interval = setInterval(() => setBlinkOn((v) => !v), 600)
    return () => clearInterval(interval)
  }, [flashingEnabled])

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
        const preview = truncatePreview(String(event.content ?? ""))
        const title = group?.name ? `${sender} in ${group.name}` : sender
        const body = preview ? `${preview}` : `New message in ${group?.name ?? "a group"}`
        void notify(notificationPreferences, "messages", renderer, body, title)
      }
      if (groupId !== selectedGroupId) {
        setGroups((current) => current.map((item) => item.group_id === groupId ? { ...item, unread_count: item.unread_count + 1 } : item))
      } else {
        void ipc.send("group_messages", { group_id: groupId }).then((response) => {
          if (!response.error) setMessages(response.messages as Message[])
        }).catch(() => {})
      }
      void actions.refreshGroups()
      if (event.event !== "group_message") {
        void ipc.send("group_members", { group_id: groupId }).then((response) => {
          if (!response.error) setGroupMembers((current) => ({ ...current, [groupId]: response.members as GroupMember[] }))
        }).catch(() => {})
      }
      return
    }
    if (event.event === "group_delivered" || event.event === "group_sent") {
      const messageId = event.message_id as string
      setMessages((current) => current.map((message) => {
        if (message.message_id !== messageId) return message
        if (Array.isArray(event.deliveries)) return { ...message, deliveries: event.deliveries as import("./types").GroupDelivery[] }
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
        }).catch(() => {})
      }
      return
    }
    if (event.event === "delivered") {
      const messageId = event.message_id as string
      setDeliveredMessageIds((c) => new Set(c).add(messageId))
      setMessages((current) => current.map((message) => message.message_id === messageId ? { ...message, delivered: 1, queued: 0, received_at: Date.now() / 1000 } : message))
      actions.showStatus("Message delivered.")
      return
    }
    if (event.event === "message_sent") {
      const messageId = event.message_id as string
      setMessages((current) => current.map((message) => message.message_id === messageId ? { ...message, queued: 0 } : message))
      return
    }
    if (event.event === "message_blocked") {
      const messageId = event.message_id as string
      const name = (event.display_name as string) ?? "a peer"
      setMessages((current) => current.map((message) => message.message_id === messageId ? { ...message, blocked: 1 } : message))
      if (event.removed_friend) actions.showStatus(`${name} removed you as a friend. You are no longer friends.`)
      else actions.showStatus(`Message blocked: ${name} hasn't added you as a friend yet.`)
      void actions.refreshPeers()
      return
    }
    if (event.event === "message_failed") {
      const messageId = event.message_id as string
      setMessages((current) => current.map((message) => message.message_id === messageId ? { ...message, failed: 1, queued: 0 } : message))
      actions.showStatus("Message cancelled because the peer protocol is incompatible.")
      return
    }
    if (event.event === "friend_request") {
      const request: import("./types").FriendRequest = {
        request_id: event.request_id as string, sender_id: event.sender_id as string,
        sender_name: (event.sender_name as string) ?? "a peer", note: (event.note as string | null | undefined) ?? null,
        created_at: event.created_at as number, direction: "incoming", status: "pending",
      }
      {
        const notePreview = request.note ? truncatePreview(request.note) : ""
        const body = notePreview ? `Friend request: ${notePreview}` : "Sent you a friend request"
        void notify(notificationPreferences, "friend_requests", renderer, body, request.sender_name)
      }
      if (!dialog) setDialog({ kind: "friend-request-incoming", request })
      else actions.showStatus(`Friend request from ${request.sender_name}. Open Commands > Friends to respond.`)
      void actions.refreshPeers()
      return
    }
    if (event.event === "friend_response") {
      const name = (event.display_name as string) ?? "a peer"
      actions.showStatus(event.accepted ? `${name} accepted your friend request. You can now chat.` : `${name} declined your friend request.`)
      void actions.refreshPeers()
      return
    }
    if (event.event === "friend_cancelled") {
      const name = (event.display_name as string) ?? "a peer"
      actions.showStatus(`${name} cancelled their friend request.`)
      void actions.refreshPeers()
      return
    }
    if (event.event === "peer_version_mismatch") {
      const peerId = event.peer_id as string
      setVersionMismatches((c) => ({ ...c, [peerId]: { remote_version: event.remote_version as number, remote_min: event.remote_min_version as number, local_version: event.local_version as number, local_min: event.local_min_version as number } }))
      void actions.refreshPeers()
      return
    }
    if (event.event === "file_offer") {
      const filename = event.filename as string
      const sender = peers.find((p) => p.peer_id === event.sender_id)?.display_name ?? String(event.sender_id).slice(0, 8)
      actions.showStatus(`Incoming file: ${filename} (${event.file_size} bytes) from ${sender}`)
      void notify(notificationPreferences, "file_offers", renderer, `Incoming file: ${filename} (${event.file_size} bytes)`, sender)
      void ipc.send("files").then((res) => { if (!res.error) setFileTransfers(res.files as FileTransfer[]) }).catch(() => {})
      return
    }
    if (event.event === "file_progress") {
      setFileTransfers((cur) => cur.map((f) => f.file_id === event.file_id ? { ...f, received_chunks: (event.received as number) ?? f.received_chunks } : f))
      return
    }
    if (event.event === "file_completed") {
      const filename = event.filename as string
      const fpath = event.file_path as string
      const fileId = event.file_id as string
      actions.showStatus(`File received: ${filename} -> ${fpath}`)
      void notify(notificationPreferences, "file_completed", renderer, `Saved to ${fpath}`, `File received: ${filename}`)
      setFileTransfers((current) => current.map((file) => file.file_id === fileId ? { ...file, status: "completed", file_path: fpath, completed_at: Date.now() / 1000 } : file))
      void ipc.send("files").then((res) => { if (!res.error) setFileTransfers(res.files as FileTransfer[]) }).catch(() => {})
      return
    }
    if (event.event === "file_sent" || event.event === "file_delivered" || event.event === "file_queued") {
      const name = (event.file_id as string)?.slice(0, 8) ?? "file"
      if (event.event === "file_sent") actions.showStatus(`File ${name} sent.`)
      else if (event.event === "file_delivered") actions.showStatus(`File ${name} delivered.`)
      else actions.showStatus(`File ${name} queued for offline peer.`)
      void ipc.send("files").then((res) => { if (!res.error) setFileTransfers(res.files as FileTransfer[]) }).catch(() => {})
      return
    }
    if (event.event !== "message") {
      if (event.event === "peer_update") {
        const peerId = event.peer_id as string
        const mismatch = event.version_mismatch as VersionMismatch | null | undefined
        setVersionMismatches((c) => { if (mismatch) return { ...c, [peerId]: mismatch }; const { [peerId]: _, ...next } = c; return next })
        void actions.refreshPeers()
      }
      return
    }
    const senderId = event.sender_id as string
    const sender = peers.find((peer) => peer.peer_id === senderId)?.display_name ?? "a peer"
    const mutedUntil = mutedPeers[senderId]
    const isMuted = mutedUntil === undefined ? false : mutedUntil <= 0 || Date.now() / 1000 < mutedUntil
    if (!isMuted && senderId !== selectedPeerId) {
      const preview = truncatePreview(String(event.content ?? ""))
      const body = preview || "New message"
      void notify(notificationPreferences, "messages", renderer, body, sender)
    }
    if (senderId !== selectedPeerId) {
      setPeers((current) => current.map((peer) => peer.peer_id === senderId ? { ...peer, unread_count: peer.unread_count + 1 } : peer))
      return
    }
    setMessages((current) => [...current, {
      message_id: event.message_id as string, sender_id: senderId, recipient_id: "",
      content: event.content as string, created_at: event.created_at as number, received_at: Date.now() / 1000,
    }])
    void ipc.send("messages", { peer_id: senderId }).then((response) => {
      if (!response.error) { setMessages(response.messages as Message[]); void actions.refreshPeers() }
    }).catch(() => {})
  }), [ipc, mutedPeers, peers, groups, groupMembers, renderer, selectedPeerId, selectedGroupId, dialog])

  useEffect(() => {
    let cancelled = false
    if (!selection || !selectionKey) { setMessages([]); setDraftLength(0); setComposerHeight(MIN_COMPOSER_HEIGHT); return }
    setScrollFocused(false)
    setDraftLength(new TextEncoder().encode(drafts[selectionKey] ?? "").length)
    setComposerHeight(MIN_COMPOSER_HEIGHT)
    if (selection.kind === "peer") {
      setPeers((current) => current.map((peer) => peer.peer_id === selection.id ? { ...peer, unread_count: 0 } : peer))
    } else {
      setGroups((current) => current.map((group) => group.group_id === selection.id ? { ...group, unread_count: 0 } : group))
      void ipc.send("group_members", { group_id: selection.id }).then((response) => {
        if (!cancelled && !response.error) setGroupMembers((current) => ({ ...current, [selection.id]: response.members as GroupMember[] }))
      }).catch(() => {})
    }
    const request = selection.kind === "peer" ? ipc.send("messages", { peer_id: selection.id }) : ipc.send("group_messages", { group_id: selection.id })
    request.then((response) => {
      if (response.error) throw new Error(response.error)
      if (cancelled) return
      setMessages(response.messages as Message[])
      if (selection.kind === "peer") void actions.refreshPeers()
      else void actions.refreshGroups()
    }).catch((error) => {
      if (!cancelled && !backendDisconnected.current) setStatus(`History error: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { cancelled = true }
  }, [selectionKey])

  useEffect(() => {
    const composer = composerRef.current
    if (composer) setComposerHeight(getComposerHeight(composer))
  }, [selectionKey, width])

  usePaste((event) => {
    if (dialog || editingName) return
    try {
      const raw = decodePasteBytes(event.bytes).trim()
      if (!raw) return
      let candidate = raw.split("\n")[0].trim()
      if (candidate.startsWith("file://")) { candidate = decodeURIComponent(candidate.replace(/^file:\/\//, "")); if (/^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1) }
      candidate = candidate.replace(/^["']|["']$/g, "").trim()
      const candidates = [candidate]
      if (candidate.includes(" ") && !existsSync(candidate)) { const m = raw.match(/"[^"]+"|'[^']+'|\S+/g); if (m && m[0]) candidates.unshift(m[0].replace(/^["']|["']$/g, "")) }
      for (const p of candidates) {
        try {
          if (p && existsSync(p) && statSync(p).isFile()) {
            if (!selection) { actions.showStatus("Select a peer or group before dropping files."); return }
            setTimeout(() => {
              const c = composerRef.current
              if (c) {
                const cur = c.plainText
                if (cur.includes(p) || cur.includes(raw.slice(0, 50))) { c.selectAll(); c.deleteSelection(); setDraftLength(0); if (selectionKey) setDrafts((d) => ({ ...d, [selectionKey]: "" })); setComposerHeight(MIN_COMPOSER_HEIGHT) }
              }
            }, 30)
            void actions.sendFile(p)
            return
          }
        } catch {}
      }
    } catch {}
  })

  useKeyboard((key) => {
    if (dialog && dialogBusyRef.current) return
    if (key.ctrl && key.name === "p") { if (dialog?.kind === "commands") actions.closeDialog(); else actions.showDialog({ kind: "commands" }); return }
    if (dialog) { if (key.name === "escape") actions.goBack(); return }
    if (key.name === "escape" && editingName) { setEditingName(false); setNameDraft(identity?.display_name ?? ""); actions.showStatus("Name edit cancelled."); return }
    if (key.ctrl && key.name === "n") { setNameDraft(identity?.display_name ?? ""); setEditingName(true); return }
    if (key.ctrl && key.name === "u") { void actions.openFilePicker(); return }
    if (key.ctrl && key.name === "d") { void actions.removeSelectedPeer(); return }
    if ((key.name === "up" || key.name === "down") && key.ctrl && (peers.length || groups.length)) {
      const conversations: Conversation[] = [...peers.map((peer) => ({ kind: "peer" as const, id: peer.peer_id })), ...groups.map((group) => ({ kind: "group" as const, id: group.group_id }))]
      const index = conversations.findIndex((item) => item.kind === selection?.kind && item.id === selection.id)
      if (index === -1) {
        setSelection(key.name === "up" ? conversations[conversations.length - 1] : conversations[0])
      } else {
        const direction = key.name === "up" ? -1 : 1
        setSelection(conversations[(index + direction + conversations.length) % conversations.length])
      }
    }
    if (key.name === "pageup") { setScrollFocused(true); scrollboxRef.current?.scrollBy(-1, "viewport") }
    if (key.name === "pagedown") { setScrollFocused(true); scrollboxRef.current?.scrollBy(1, "viewport") }
    if (scrollFocused && key.name === "home") scrollboxRef.current?.scrollTo(0)
    if (scrollFocused && key.name === "end") scrollboxRef.current?.scrollTo(scrollboxRef.current.scrollHeight)
  })

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
    if (selection?.kind === "peer") return !f.group_id && (f.sender_id === selection.id || f.recipient_id === selection.id)
    if (selection?.kind === "group") return f.group_id === selection.id
    return false
  }).sort((a, b) => a.created_at - b.created_at), [fileTransfers, selection])
  const conversationItems = useMemo<ConversationItem[]>(() => [
    ...messages.map((message) => ({ type: "message" as const, createdAt: message.created_at, message })),
    ...conversationFiles.map((file) => ({ type: "file" as const, createdAt: file.created_at, file })),
  ].sort((a, b) => a.createdAt - b.createdAt || (a.type === b.type ? 0 : a.type === "message" ? -1 : 1)), [messages, conversationFiles])
  const incompatibleGroupMembers = selectedGroup ? (groupMembers[selectedGroup.group_id] ?? []).filter((member) => member.is_incompatible) : []
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
      <Sidebar activeCount={activeCount} compact={compact} dialogOpen={Boolean(dialog)} editingName={editingName} groups={groups} groupMembers={groupMembers} identity={identity} mutedPeers={mutedPeers} nameDraft={nameDraft} peers={peers} selectedGroupId={selectedGroupId} selectedPeerId={selectedPeerId} sidebarWidth={sidebarWidth} versionMismatches={versionMismatches} setEditingName={setEditingName} setNameDraft={setNameDraft} setSelection={setSelection} setScrollFocused={setScrollFocused} saveDisplayName={() => void actions.saveDisplayName()} />
      <ConversationPanel compact={compact} controlStatus={controlStatus} conversationItems={conversationItems} deliveredMessageIds={deliveredMessageIds} dialogOpen={Boolean(dialog)} draftLength={draftLength} drafts={drafts} flashingEnabled={flashingEnabled} blinkOn={blinkOn} composerHeight={composerHeight} composerRef={composerRef} groupMembers={groupMembers} identity={identity} imageRenderGeneration={imageRenderGeneration} incompatibleGroupMembers={incompatibleGroupMembers} incompatiblePeerMessage={incompatiblePeerMessage} isSending={isSending} limitColor={limitColor} mutedPeers={mutedPeers} peers={peers} selected={selected} selectedGroup={selectedGroup} selectedGroupId={selectedGroupId} selectedIsIncompatible={selectedIsIncompatible} selectedVersionMismatch={selectedVersionMismatch} selectionKey={selectionKey} editingName={editingName} scrollFocused={scrollFocused} scrollboxRef={scrollboxRef} status={status} width={width} setComposerHeight={setComposerHeight} setDraftLength={setDraftLength} setDrafts={setDrafts} setScrollFocused={setScrollFocused} send={() => void actions.send()} />
      {copyToast && (
        <box style={{ position: "absolute", right: 2, top: 1, border: true, borderColor: "#66dd88", backgroundColor: "#18251d", paddingLeft: 1, paddingRight: 1 }}>
          <text fg="#66dd88">Copied to clipboard</text>
        </box>
      )}
      {dialog && <DialogPanel dialog={dialog} dialogBusy={dialogBusy} dialogError={dialogError} dialogHeight={dialogHeight} dialogWidth={dialogWidth} dialogDraft={dialogDraft} controlStatus={controlStatus} debugInfo={debugInfo} flashingEnabled={flashingEnabled} groups={groups} identity={identity} imageRenderGeneration={imageRenderGeneration} mutedPeers={mutedPeers} notificationPreferences={notificationPreferences} notificationTestDelivery={notificationTestDelivery} peers={peers} selected={selected} selectedGroupId={selectedGroupId} selection={selection} dialogWidthFor={dialogWidthFor} appReleaseVersion={APP_RELEASE_VERSION} isReleaseBuild={IS_RELEASE_BUILD} runCommand={actions.runCommand} showDialog={actions.showDialog} closeDialog={actions.closeDialog} goBack={actions.goBack} setDialogDraft={setDialogDraft} setDialogError={setDialogError} setNameDraft={setNameDraft} configureControl={actions.configureControl} dismissControlSetup={actions.dismissControlSetup} loadControlStatus={actions.loadControlStatus} saveAdvancedConfig={actions.saveAdvancedConfig} setAccessibilityFlashing={actions.setAccessibilityFlashing} createRoom={actions.createRoom} joinRoom={actions.joinRoom} leaveRoom={actions.leaveRoom} loadRoomInvite={actions.loadRoomInvite} loadRooms={actions.loadRooms} copyInvite={actions.copyInvite} leaveGroup={actions.leaveGroup} loadGroupDetails={actions.loadGroupDetails} mutePeer={actions.mutePeer} unmutePeer={actions.unmutePeer} sendFriendRequest={actions.sendFriendRequest} respondToFriendRequest={actions.respondToFriendRequest} cancelFriendRequest={actions.cancelFriendRequest} unfriendPeer={actions.unfriendPeer} loadFriendRequests={actions.loadFriendRequests} loadBlockedPeers={actions.loadBlockedPeers} blockPeer={actions.blockPeer} unblockPeer={actions.unblockPeer} blockSenderFromRequest={actions.blockSenderFromRequest} reStun={actions.reStun} loadDebugInfo={actions.loadDebugInfo} loadFiles={actions.loadFiles} loadFilesDir={actions.loadFilesDir} setFilesDir={actions.setFilesDir} sendFile={actions.sendFile} downloadFile={actions.downloadFile} defaultDownloadPath={actions.defaultDownloadPath} testNotificationDelivery={actions.testNotificationDelivery} disableNotifications={actions.disableNotifications} confirmNotificationDelivery={actions.confirmNotificationDelivery} toggleNotificationEvent={actions.toggleNotificationEvent} saveDisplayName={actions.saveDisplayName} checkForUpdatesFromAbout={actions.checkForUpdatesFromAbout} installUpdate={() => void actions.installUpdate(dialog.kind === "update" ? dialog.release : undefined!)} />}
      {!dialog && <box style={{ position: "absolute", right: 1, bottom: 0 }}>
        <text><span fg="#66dd88">● </span><span fg="#bbbbbb">MeshTalk </span><span fg="#888888">{APP_RELEASE_VERSION}</span></text>
      </box>}
    </box>
  )
}
