import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import { IPCClient, type IPCEvent } from "../../common/ipc-client"

type Peer = { peer_id: string; display_name: string; is_online: number }
type Message = {
  message_id: string
  sender_id: string
  recipient_id: string
  content: string
  created_at: number
  delivered?: number
}

function ChatApp() {
  const [ipc] = useState(() => new IPCClient())
  const [peers, setPeers] = useState<Peer[]>([])
  const [identity, setIdentity] = useState<{ peer_id: string; display_name: string }>()
  const [selectedPeerId, setSelectedPeerId] = useState<string>()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState("")
  const [status, setStatus] = useState("Connecting to backend...")

  async function refreshPeers() {
    const response = await ipc.send("peers")
    if (response.error) throw new Error(response.error)
    const next = response.peers as Peer[]
    setPeers(next)
    setSelectedPeerId((current) => current && next.some((peer) => peer.peer_id === current) ? current : next[0]?.peer_id)
  }

  useEffect(() => {
    ipc.connect().then(async () => {
      const response = await ipc.send("identity")
      if (response.error) throw new Error(response.error)
      setIdentity({ peer_id: response.peer_id as string, display_name: response.display_name as string })
      await refreshPeers()
      setStatus("Ctrl+Up/Down: select peer  Ctrl+C: quit")
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
    if (event.event !== "message" || event.sender_id !== selectedPeerId) return
    setMessages((current) => [...current, {
      message_id: event.message_id as string,
      sender_id: event.sender_id as string,
      recipient_id: "",
      content: event.content as string,
      created_at: event.created_at as number,
    }])
  }), [ipc, selectedPeerId])

  useEffect(() => {
    if (!selectedPeerId) {
      setMessages([])
      return
    }
    ipc.send("messages", { peer_id: selectedPeerId }).then((response) => {
      if (response.error) throw new Error(response.error)
      setMessages(response.messages as Message[])
    }).catch((error) => setStatus(`History error: ${error instanceof Error ? error.message : String(error)}`))
  }, [selectedPeerId])

  useKeyboard((key) => {
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
    } catch (error) {
      setStatus(`Send error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const selected = peers.find((peer) => peer.peer_id === selectedPeerId)
  return (
    <box style={{ flexDirection: "row", width: "100%", height: "100%", padding: 1, gap: 1 }}>
      <box title="Peers" style={{ border: true, width: 30, flexDirection: "column", padding: 1 }}>
        {!peers.length && <text fg="#888888">No peers discovered</text>}
        {peers.map((peer) => (
          <box key={peer.peer_id} onMouseDown={() => setSelectedPeerId(peer.peer_id)}>
            <text fg={peer.is_online ? "#66dd88" : "#888888"}>
              {peer.peer_id === selectedPeerId ? "> " : "  "}{peer.display_name} {peer.is_online ? "*" : "-"}
            </text>
          </box>
        ))}
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", gap: 1 }}>
        <box title={selected ? `Chat: ${selected.display_name}` : "Chat"} style={{ border: true, flexGrow: 1, flexDirection: "column", padding: 1 }}>
          {!selected && <text fg="#888888">Waiting for a connected peer.</text>}
          {messages.map((message) => (
            <text key={message.message_id}>
              <span fg={message.sender_id === identity?.peer_id ? "#65a9ff" : "#66dd88"}>
                {message.sender_id === identity?.peer_id ? "You" : selected?.display_name}:
              </span>{" "}{message.content}
            </text>
          ))}
        </box>

        <box title="Message" style={{ border: true, padding: 1 }}>
          <input
            value={draft}
            placeholder={selected?.is_online ? "Type a message and press Enter" : "Select an online peer"}
            focused={Boolean(selected?.is_online)}
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
