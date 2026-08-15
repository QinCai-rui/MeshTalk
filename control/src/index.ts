import type { ServerWebSocket } from "bun"

type ClientData = {
  rooms: Set<string>
  signals: Map<string, string>
  windowStartedAt: number
  controlMessagesInWindow: number
  signalsInWindow: number
}

type ControlMessage = {
  type?: unknown
  room_id?: unknown
  payload?: unknown
}

const PORT = Number(process.env.PORT ?? 8787)
const MAX_ROOM_MEMBERS = 64
const MAX_ROOMS_PER_CLIENT = 32
const MAX_SIGNAL_LENGTH = 8 * 1024
const MAX_CONTROL_MESSAGES_PER_MINUTE = 96
const MAX_SIGNALS_PER_MINUTE = 64
const MAX_CONNECTIONS = 10_000
const MAX_ROOMS = 10_000
const MAX_RETAINED_BYTES = 64 * 1024 * 1024
const ROOM_ID = /^[a-f0-9]{32}$/

const rooms = new Map<string, Set<ServerWebSocket<ClientData>>>()
let connections = 0
let retainedBytes = 0

function send(socket: ServerWebSocket<ClientData>, value: object): void {
  socket.send(JSON.stringify(value))
}

function broadcastRoom(roomId: string, value: object, except?: ServerWebSocket<ClientData>): void {
  for (const member of rooms.get(roomId) ?? []) {
    if (member !== except) send(member, value)
  }
}

function refreshRoom(roomId: string): void {
  const members = rooms.get(roomId)
  if (!members) return
  broadcastRoom(roomId, { type: "refresh", room_id: roomId, member_count: members.size })
}

function leaveRoom(socket: ServerWebSocket<ClientData>, roomId: string): void {
  const members = rooms.get(roomId)
  if (!members) return
  members.delete(socket)
  socket.data.rooms.delete(roomId)
  retainedBytes -= socket.data.signals.get(roomId)?.length ?? 0
  socket.data.signals.delete(roomId)
  if (!members.size) {
    rooms.delete(roomId)
    return
  }
  refreshRoom(roomId)
}

function joinRoom(socket: ServerWebSocket<ClientData>, roomId: string): void {
  if (!ROOM_ID.test(roomId)) throw new Error("Invalid room ID")
  if (socket.data.rooms.has(roomId)) return
  if (socket.data.rooms.size >= MAX_ROOMS_PER_CLIENT) throw new Error("Too many joined rooms")
  let members = rooms.get(roomId)
  if (!members) {
    if (rooms.size >= MAX_ROOMS) throw new Error("Control service room limit reached")
    members = new Set()
    rooms.set(roomId, members)
  }
  if (members.size >= MAX_ROOM_MEMBERS) throw new Error("Room is full")
  for (const member of members) {
    const payload = member.data.signals.get(roomId)
    if (payload) send(socket, { type: "signal", room_id: roomId, payload })
  }
  members.add(socket)
  socket.data.rooms.add(roomId)
  send(socket, { type: "joined", room_id: roomId, member_count: members.size })
  refreshRoom(roomId)
}

function signalRoom(socket: ServerWebSocket<ClientData>, roomId: string, payload: string): void {
  if (!socket.data.rooms.has(roomId)) throw new Error("Join the room before signaling")
  if (!payload || payload.length > MAX_SIGNAL_LENGTH) throw new Error("Invalid signal payload")
  const previousLength = socket.data.signals.get(roomId)?.length ?? 0
  if (retainedBytes - previousLength + payload.length > MAX_RETAINED_BYTES) {
    throw new Error("Control service storage limit reached")
  }
  retainedBytes += payload.length - previousLength
  socket.data.signals.set(roomId, payload)
  broadcastRoom(roomId, { type: "signal", room_id: roomId, payload }, socket)
}

function checkRateLimit(socket: ServerWebSocket<ClientData>, messageType: unknown): void {
  const now = Date.now()
  if (now - socket.data.windowStartedAt >= 60_000) {
    socket.data.windowStartedAt = now
    socket.data.controlMessagesInWindow = 0
    socket.data.signalsInWindow = 0
  }
  if (messageType === "signal") socket.data.signalsInWindow += 1
  else socket.data.controlMessagesInWindow += 1
  if (
    socket.data.signalsInWindow > MAX_SIGNALS_PER_MINUTE
    || socket.data.controlMessagesInWindow > MAX_CONTROL_MESSAGES_PER_MINUTE
  ) {
    throw new Error("Message rate limit exceeded")
  }
}

export function startControlServer(port = PORT) {
  return Bun.serve<ClientData>({
    port,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", rooms: rooms.size, connections })
      }
      if (url.pathname !== "/v1/rendezvous") return new Response("Not found", { status: 404 })
      if (connections >= MAX_CONNECTIONS) return new Response("Control service is full", { status: 503 })
      const upgraded = server.upgrade(request, {
        data: {
          rooms: new Set(),
          signals: new Map(),
          windowStartedAt: Date.now(),
          controlMessagesInWindow: 0,
          signalsInWindow: 0,
        },
      })
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      maxPayloadLength: 256 * 1024,
      idleTimeout: 60,
      open() {
        connections += 1
      },
      message(socket, raw) {
        try {
          const message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ControlMessage
          checkRateLimit(socket, message.type)
          if (message.type === "join" && typeof message.room_id === "string") {
            joinRoom(socket, message.room_id)
          } else if (message.type === "leave" && typeof message.room_id === "string") {
            leaveRoom(socket, message.room_id)
          } else if (
            message.type === "signal" && typeof message.room_id === "string" && typeof message.payload === "string"
          ) {
            signalRoom(socket, message.room_id, message.payload)
          } else {
            throw new Error("Invalid control message")
          }
        } catch (error) {
          send(socket, { type: "error", error: error instanceof Error ? error.message : "Invalid request" })
          socket.close(1008, "Invalid control message")
        }
      },
      close(socket) {
        for (const roomId of [...socket.data.rooms]) leaveRoom(socket, roomId)
        connections = Math.max(0, connections - 1)
      },
    },
  })
}

if (import.meta.main) {
  const server = startControlServer()
  console.log(`MeshTalk control server listening on http://${server.hostname}:${server.port}`)
}
