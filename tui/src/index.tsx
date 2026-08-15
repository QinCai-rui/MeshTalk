import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import { IPCClient, type IPCEvent } from "../../common/ipc-client"

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
  const [ipc] = useState(() => new IPCClient())
  const [peers, setPeers] = useState<Peer[]>([])
  const [identity, setIdentity] = useState<{ peer_id: string; display_name: string }>()
  const [selectedPeerId, setSelectedPeerId] = useState<string>()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState("")
  const [nameDraft, setNameDraft] = useState("")
  const [editingName, setEditingName] = useState(false)
  const [deliveredMessageIds, setDeliveredMessageIds] = useState<Set<string>>(() => new Set())
  const [status, setStatus] = useState("Connecting to backend...")

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
      setStatus("Connected. Ctrl+Up/Down: select  Ctrl+N: rename  Ctrl+C: quit")
    }).catch((error) => setStatus(`Backend error: ${error instanceof Error ? error.message : String(error)}`))
    return () => ipc.close()
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      void refreshPeers().catch((error) => setStatus(`Peer refresh error: ${String(error)}`))
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
      return
    }
    setPeers((current) => current.map((peer) =>
      peer.peer_id === selectedPeerId ? { ...peer, unread_count: 0 } : peer
    ))
    ipc.send("messages", { peer_id: selectedPeerId }).then((response) => {
      if (response.error) throw new Error(response.error)
      setMessages(response.messages as Message[])
    }).catch((error) => setStatus(`History error: ${error instanceof Error ? error.message : String(error)}`))
  }, [selectedPeerId])

  useKeyboard((key) => {
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
  })

  async function send() {
    const content = draft.trim()
    if (!content || !selectedPeerId || !identity) return
    try {
      const response = await ipc.send("send", { recipient_id: selectedPeerId, content })
      if (response.error) throw new Error(response.error)
      setMessages((current) => [...current, {
        message_id: response.message_id as string,
        sender_id: identity.peer_id,
        recipient_id: selectedPeerId,
        content,
        created_at: Date.now() / 1000,
        delivered: 0,
      }])
      setDraft("")
      setStatus("Message sent. Waiting for delivery confirmation.")
    } catch (error) {
      setStatus(`Send error: ${error instanceof Error ? error.message : String(error)}`)
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
      setStatus(`Name error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const selected = peers.find((peer) => peer.peer_id === selectedPeerId)
  const onlineCount = peers.filter((peer) => peer.is_online).length
  return (
    <box style={{ flexDirection: "row", width: "100%", height: "100%", padding: 1, gap: 1 }}>
      <box title={`You: ${identity?.display_name ?? "..."}`} style={{ border: true, width: 32, flexDirection: "column", padding: 1, gap: 1 }}>
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
        <box title={`Peers: ${onlineCount} online`} style={{ border: true, flexGrow: 1, flexDirection: "column", padding: 1 }}>
        {!peers.length && <text fg="#888888">No peers discovered</text>}
        {peers.map((peer) => (
          <box
            key={peer.peer_id}
            onMouseDown={() => setSelectedPeerId(peer.peer_id)}
            style={{ width: "100%", backgroundColor: peer.peer_id === selectedPeerId ? "#25354d" : undefined }}
          >
            <text fg={peer.is_online ? "#66dd88" : "#888888"}>
              {peer.peer_id === selectedPeerId ? "> " : "  "}{peer.display_name} {peer.is_online ? "online" : "offline"}{peer.unread_count ? ` (${peer.unread_count} new)` : ""}
            </text>
          </box>
        ))}
        </box>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", gap: 1 }}>
        <box title={selected ? `Chat: ${selected.display_name} (${selected.is_online ? "online" : "offline"})` : "Chat"} style={{ border: true, flexGrow: 1, flexDirection: "column" }}>
          {!selected && <text fg="#888888">Waiting for a connected peer.</text>}
          {selected && !messages.length && <text fg="#888888">No messages yet. Say hello.</text>}
          <scrollbox style={{ flexGrow: 1, padding: 1, flexDirection: "column" }} stickyScroll stickyStart="bottom" viewportCulling={false}>
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
                  <text>{message.content}</text>
                </box>
              )
            })}
          </scrollbox>
        </box>

        <box title={selected?.is_online ? "Message" : "Message: peer offline"} style={{ border: true, padding: 1 }}>
          <input
            value={draft}
            placeholder={selected?.is_online ? "Type a message and press Enter" : "Select an online peer"}
            focused={Boolean(selected?.is_online) && !editingName}
            onInput={setDraft}
            onSubmit={() => void send()}
            maxLength={65536}
          />
        </box>
        <text fg="#888888">{status}</text>
      </box>
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true })
createRoot(renderer).render(<ChatApp />)
