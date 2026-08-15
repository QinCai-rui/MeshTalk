import { createClipboard, createCliRenderer, createHostClipboard, createRendererClipboardAdapter, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { IPCClient, type IPCEvent } from "../../common/ipc-client"

const MIN_COMPOSER_HEIGHT = 3
const MAX_COMPOSER_HEIGHT = 5
const MAX_MESSAGE_BYTES = 30 * 1024
const DEFAULT_STATUS = "Ctrl+Up/Down: select  Ctrl+D: remove offline  Ctrl+N: rename  Ctrl+C: quit"

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
  active_transport?: "lan_tcp" | "remote_udp"
  active_endpoint?: string
  endpoints: { transport: "lan_tcp" | "remote_udp"; endpoint: string; active: boolean }[]
}
type Message = {
  message_id: string
  sender_id: string
  recipient_id: string
  content: string
  created_at: number
  delivered?: number
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function transportName(transport?: Peer["active_transport"]): string {
  return transport === "lan_tcp" ? "LAN TCP" : transport === "remote_udp" ? "Remote UDP" : "No endpoint"
}

function peerPresence(peer: Peer): "active" | "away" | "offline" {
  return peer.presence ?? (peer.is_online ? "away" : "offline")
}

function ChatApp() {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
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
  const [status, setStatus] = useState("Connecting to backend...")
  const [copyToast, setCopyToast] = useState(false)
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const composerRef = useRef<TextareaRenderable>(null)
  const backendDisconnected = useRef(false)
  const statusReset = useRef<ReturnType<typeof setTimeout>>()
  const copyToastReset = useRef<ReturnType<typeof setTimeout>>()
  const clipboard = useRef<ReturnType<typeof createClipboard> | null>(null)

  function showStatus(message: string) {
    if (statusReset.current) clearTimeout(statusReset.current)
    setStatus(message)
    statusReset.current = setTimeout(() => setStatus(DEFAULT_STATUS), 5_000)
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
    if (event.event !== "message") return
    const senderId = event.sender_id as string
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
  }), [ipc, selectedPeerId])

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

  useKeyboard((key) => {
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

  async function saveDisplayName() {
    try {
      const response = await ipc.send("set_display_name", { display_name: nameDraft })
      if (response.error) throw new Error(response.error)
      const displayName = response.display_name as string
      setIdentity((current) => current ? { ...current, display_name: displayName } : current)
      setNameDraft(displayName)
      setEditingName(false)
      showStatus("Display name updated and shared with connected peers.")
    } catch (error) {
      if (!backendDisconnected.current) {
        setStatus(`Name error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const selected = peers.find((peer) => peer.peer_id === selectedPeerId)
  const activeCount = peers.filter((peer) => peerPresence(peer) === "active").length
  const sidebarWidth = width < 72 ? 22 : 32
  const compact = width < 72
  return (
    <box style={{ flexDirection: "row", width: "100%", height: "100%", minWidth: 0, padding: 1, gap: 1 }}>
      <box title={`You: ${identity?.display_name ?? "..."}`} style={{ border: true, width: sidebarWidth, flexShrink: 0, flexDirection: "column", padding: 1, gap: 1 }}>
        <box onMouseDown={() => setEditingName(true)}>
          {editingName ? (
            <input
              value={nameDraft}
              focused
              placeholder="Display name"
              onInput={setNameDraft}
              onSubmit={() => void saveDisplayName()}
              maxLength={48}
            />
          ) : (
            <>
              <text fg="#888888">Ctrl+N or click here to rename</text>
              <text fg="#888888">{identity?.peer_id.slice(0, 12)}</text>
            </>
          )}
        </box>
        <box title={`Peers: ${activeCount} active`} bottomTitle="Ctrl+D removes offline" style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", padding: 1 }}>
          {!peers.length && <text fg="#888888">No peers discovered</text>}
          <scrollbox
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
            contentOptions={{ flexDirection: "column" }}
            verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
          >
            {peers.map((peer) => {
              const presence = peerPresence(peer)
              return <box
                key={peer.peer_id}
                onMouseDown={() => {
                  setSelectedPeerId(peer.peer_id)
                  setScrollFocused(false)
                }}
                style={{ width: "100%", flexDirection: "column", backgroundColor: peer.peer_id === selectedPeerId ? "#25354d" : undefined }}
              >
                <text truncate fg={presence === "active" ? "#66dd88" : presence === "away" ? "#e0a34a" : "#888888"}>
                  {peer.peer_id === selectedPeerId ? "> " : "  "}{compact ? peer.display_name.slice(0, 10) : peer.display_name} {presence}{peer.unread_count ? ` (${peer.unread_count} new)` : ""}
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
          title={selected ? `Chat: ${selected.display_name} (${peerPresence(selected) === "offline" ? "offline" : `${peerPresence(selected)}: ${transportName(selected.active_transport)} ${selected.active_endpoint ?? ""}`})` : "Chat"}
          bottomTitle={compact ? "PgUp/PgDn scroll" : "PgUp/PgDn scroll  End latest  Drag text to select"}
          style={{ border: true, borderColor: scrollFocused ? "#6ea8fe" : undefined, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}
        >
          {!selected && <text fg="#888888">Waiting for a connected peer.</text>}
          {selected && !messages.length && <text fg="#888888">No messages yet. Say hello.</text>}
          {selected && !selected.is_online && <text fg="#e0a34a">This peer is offline. Messages cannot be sent until it reconnects.</text>}
          <scrollbox
            ref={scrollboxRef}
            focused={scrollFocused}
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
            {messages.map((message) => {
              const isLocal = message.sender_id === identity?.peer_id
              const delivered = Boolean(message.delivered) || deliveredMessageIds.has(message.message_id)
              return (
                <box key={message.message_id} style={{ flexDirection: "column", marginBottom: 1 }}>
                  <text>
                    <span fg="#888888">{formatTime(message.created_at)} </span>
                    <span fg={isLocal ? "#65a9ff" : "#66dd88"}>{isLocal ? "You" : selected?.display_name}</span>
                    {isLocal && <span fg="#888888"> {delivered ? "delivered" : "sent"}</span>}
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
          style={{ border: true, borderColor: draftLength > MAX_MESSAGE_BYTES ? "#ff7777" : !scrollFocused && !editingName && selected?.is_online ? "#6ea8fe" : undefined, flexShrink: 0, flexDirection: "column", overflow: "hidden", padding: 1 }}
        >
          <textarea
            key={selectedPeerId ?? "no-peer"}
            ref={composerRef}
            initialValue={selectedPeerId ? drafts[selectedPeerId] ?? "" : ""}
            placeholder={selected?.is_online ? "Write a message" : "Select an online peer"}
            focused={Boolean(selected?.is_online) && !editingName && !scrollFocused && !isSending}
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
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
createRoot(renderer).render(<ChatApp />)
