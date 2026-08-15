import { createCliRenderer, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { IPCClient, type IPCEvent } from "../../common/ipc-client"

const MIN_COMPOSER_HEIGHT = 3
const MAX_COMPOSER_HEIGHT = 8

type Peer = {
  peer_id: string
  display_name: string
  is_online: number
  last_seen: number
  unread_count: number
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

function ChatApp() {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
  const [ipc] = useState(() => new IPCClient())
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
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const composerRef = useRef<TextareaRenderable>(null)
  const backendDisconnected = useRef(false)

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
      await refreshPeers()
      setStatus("Connected. Ctrl+Up/Down: select  PgUp/PgDn: scroll  Ctrl+N: rename  Ctrl+C: quit")
    }).catch((error) => {
      if (!backendDisconnected.current) {
        setStatus(`Backend error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return () => ipc.close()
  }, [])

  useEffect(() => {
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = ipc.onDisconnect(() => {
      backendDisconnected.current = true
      setStatus("Backend connection lost. Closing LanChat...")
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
      setStatus("Message delivered.")
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
    setDraftLength((drafts[selectedPeerId] ?? "").length)
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
      setComposerHeight(Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, composer.virtualLineCount)))
    }
  }, [selectedPeerId, width])

  useKeyboard((key) => {
    if (key.name === "escape" && editingName) {
      setEditingName(false)
      setNameDraft(identity?.display_name ?? "")
      setStatus("Name edit cancelled.")
      return
    }
    if (key.ctrl && key.name === "n") {
      setNameDraft(identity?.display_name ?? "")
      setEditingName(true)
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
      setStatus("Message is empty.")
      return
    }
    if (!recipientId || !identity || !selected?.is_online) {
      setStatus("Select an online peer before sending.")
      return
    }
    if (new TextEncoder().encode(content).length > 64 * 1024) {
      setStatus("Message exceeds the 64 KiB limit.")
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
      setStatus("Message sent. Waiting for delivery confirmation.")
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
      setStatus("Display name updated and shared with connected peers.")
    } catch (error) {
      if (!backendDisconnected.current) {
        setStatus(`Name error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const selected = peers.find((peer) => peer.peer_id === selectedPeerId)
  const onlineCount = peers.filter((peer) => peer.is_online).length
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
        <box title={`Peers: ${onlineCount} online`} style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", padding: 1 }}>
          {!peers.length && <text fg="#888888">No peers discovered</text>}
          <scrollbox
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
            contentOptions={{ flexDirection: "column" }}
            verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}
          >
            {peers.map((peer) => (
              <box
                key={peer.peer_id}
                onMouseDown={() => {
                  setSelectedPeerId(peer.peer_id)
                  setScrollFocused(false)
                }}
                style={{ width: "100%", backgroundColor: peer.peer_id === selectedPeerId ? "#25354d" : undefined }}
              >
                <text truncate fg={peer.is_online ? "#66dd88" : "#888888"}>
                  {peer.peer_id === selectedPeerId ? "> " : "  "}{compact ? peer.display_name.slice(0, 10) : peer.display_name} {peer.is_online ? "online" : "offline"}{peer.unread_count ? ` (${peer.unread_count} new)` : ""}
                </text>
              </box>
            ))}
          </scrollbox>
        </box>
      </box>

      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", gap: 1 }}>
        <box
          title={selected ? `Chat: ${selected.display_name} (${selected.is_online ? "online" : "offline"})` : "Chat"}
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

        <box title={selected?.is_online ? (compact ? "Message" : "Message: Enter sends, Alt+Enter adds a line") : "Message: peer offline"} style={{ border: true, borderColor: !scrollFocused && !editingName && selected?.is_online ? "#6ea8fe" : undefined, padding: 1 }}>
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
              setDraftLength(content.length)
              setComposerHeight(Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, composer?.virtualLineCount ?? 0)))
              if (selectedPeerId) setDrafts((current) => ({ ...current, [selectedPeerId]: content }))
            }}
            onSubmit={() => void send()}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", meta: true, action: "newline" },
            ]}
            height={composerHeight}
            wrapMode="word"
            selectionBg="#365b85"
          />
          <text fg={draftLength > 64 * 1024 ? "#ff7777" : "#888888"}>
            {isSending ? "Sending..." : `${draftLength.toLocaleString()} / 65,536 bytes`}
          </text>
        </box>
        <text fg={status.includes("error") || status.includes("lost") || status.includes("exceeds") ? "#ff7777" : "#888888"}>{status}</text>
      </box>
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
createRoot(renderer).render(<ChatApp />)
