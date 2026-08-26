import type { ServerWebSocket } from "bun"
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "crypto"

type ClientData = {
  ip: string
  rooms: Set<string>
  signals: Map<string, string>
  windowStartedAt: number
  controlMessagesInWindow: number
  signalsInWindow: number
  peerFetchesInWindow: number
  challengeId: string
  challenge: string
  challengeExpiresAt: number
  peerId?: string
}

type ControlMessage = {
  type?: unknown
  room_id?: unknown
  room_auth?: unknown
  payload?: unknown
  recipient_id?: unknown
  challenge_id?: unknown
  nonce?: unknown
  issued_at?: unknown
  peer_id?: unknown
  signing_public_key?: unknown
  signature?: unknown
}

type RateLimit = {
  windowStartedAt: number
  controlMessagesInWindow: number
  signalsInWindow: number
  peerFetchesInWindow: number
}

type RoomState = {
  auth: string
  members: Set<ServerWebSocket<ClientData>>
}

type DeviceLimit = {
  tokens: number
  updatedAt: number
  relayPeers: Map<string, number>
}

const PORT = Number(process.env.PORT ?? 8787)
const MAX_ROOM_MEMBERS = 64
const MAX_ROOMS_PER_CLIENT = 32
const MAX_SIGNAL_LENGTH = 8 * 1024
const MAX_CONTROL_MESSAGES_PER_MINUTE = 96
const MAX_SIGNALS_PER_MINUTE = 64
const MAX_PEER_FETCHES_PER_MINUTE = 30
const MAX_CONNECTIONS = 10_000
const MAX_CONNECTIONS_PER_IP = 32
const MAX_ROOMS = 10_000
const MAX_RETAINED_BYTES = 64 * 1024 * 1024
const MAX_RELAY_FRAME_LENGTH = 1200
const MAX_RELAY_PEERS_PER_DEVICE = 8
const RELAY_PEER_IDLE_MS = 60_000
const RELAY_BYTES_PER_SECOND = 1024 * 1024
const RELAY_BURST_BYTES = 4 * 1024 * 1024
const RELAY_ENABLED = process.env.CONTROL_RELAY_ENABLED !== "false"
const ROOM_ID = /^[a-f0-9]{32}$/
const ROOM_AUTH = /^[a-f0-9]{64}$/
const PEER_ID = /^[a-f0-9]{64}$/
const HEX_32 = /^[a-f0-9]{64}$/
const HEX_64 = /^[a-f0-9]{128}$/

const rooms = new Map<string, RoomState>()
let connections = 0
let retainedBytes = 0
const connectionsByIp = new Map<string, number>()
const rateLimitsByIp = new Map<string, RateLimit>()
const socketsByPeerId = new Map<string, ServerWebSocket<ClientData>>()
const deviceLimits = new Map<string, DeviceLimit>()

function send(socket: ServerWebSocket<ClientData>, value: object): void {
  socket.send(JSON.stringify(value))
}

function canonical(value: object): Buffer {
  return Buffer.from(JSON.stringify(value, Object.keys(value as object).sort()))
}

function registerDevice(socket: ServerWebSocket<ClientData>, message: ControlMessage): void {
  const now = Math.floor(Date.now() / 1000)
  if (
    typeof message.challenge_id !== "string" || message.challenge_id !== socket.data.challengeId
    || typeof message.nonce !== "string" || message.nonce !== socket.data.challenge || typeof message.issued_at !== "number"
    || Math.abs(now - message.issued_at) > 30 || typeof message.peer_id !== "string" || !PEER_ID.test(message.peer_id)
    || typeof message.signing_public_key !== "string" || !HEX_32.test(message.signing_public_key)
    || typeof message.signature !== "string" || !HEX_64.test(message.signature)
  ) throw new Error("Invalid device registration")
  const key = Buffer.from(message.signing_public_key, "hex")
  if (createHash("sha256").update(key).digest("hex") !== message.peer_id) throw new Error("Device identity mismatch")
  const signed = { challenge_id: message.challenge_id, issued_at: message.issued_at, kind: "meshtalk-device-register-v1", nonce: message.nonce, peer_id: message.peer_id, signing_public_key: message.signing_public_key, v: 1 }
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key])
  if (!verify(null, canonical(signed), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(message.signature, "hex"))) throw new Error("Invalid device signature")
  const previous = socketsByPeerId.get(message.peer_id)
  if (previous && previous !== socket) previous.close(4000, "Replaced by a newer device session")
  socket.data.peerId = message.peer_id
  socketsByPeerId.set(message.peer_id, socket)
  if (!deviceLimits.has(message.peer_id)) {
    deviceLimits.set(message.peer_id, { tokens: RELAY_BURST_BYTES, updatedAt: Date.now(), relayPeers: new Map() })
  }
  send(socket, { type: "device_registered", peer_id: message.peer_id, relay_enabled: RELAY_ENABLED, v: 1 })
}

function broadcastRoom(roomId: string, value: object, except?: ServerWebSocket<ClientData>): void {
  for (const member of rooms.get(roomId)?.members ?? []) {
    if (member !== except) send(member, value)
  }
}

function refreshRoom(roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  broadcastRoom(roomId, { type: "refresh", room_id: roomId, member_count: room.members.size })
}

function leaveRoom(socket: ServerWebSocket<ClientData>, roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  room.members.delete(socket)
  socket.data.rooms.delete(roomId)
  retainedBytes -= socket.data.signals.get(roomId)?.length ?? 0
  socket.data.signals.delete(roomId)
  if (!room.members.size) {
    rooms.delete(roomId)
    return
  }
  refreshRoom(roomId)
}

function joinRoom(socket: ServerWebSocket<ClientData>, roomId: string, roomAuth: string): void {
  if (!ROOM_ID.test(roomId) || !ROOM_AUTH.test(roomAuth)) throw new Error("Invalid room authorization")
  if (socket.data.rooms.has(roomId)) return
  if (socket.data.rooms.size >= MAX_ROOMS_PER_CLIENT) throw new Error("Too many joined rooms")
  let room = rooms.get(roomId)
  if (!room) {
    if (rooms.size >= MAX_ROOMS) throw new Error("Control service room limit reached")
    room = { auth: roomAuth, members: new Set() }
    rooms.set(roomId, room)
  }
  if (!timingSafeEqual(Buffer.from(room.auth, "hex"), Buffer.from(roomAuth, "hex"))) {
    throw new Error("Room authorization failed")
  }
  if (room.members.size >= MAX_ROOM_MEMBERS) throw new Error("Room is full")
  for (const member of room.members) {
    const payload = member.data.signals.get(roomId)
    if (payload) send(socket, { type: "signal", room_id: roomId, payload })
  }
  room.members.add(socket)
  socket.data.rooms.add(roomId)
  send(socket, { type: "joined", room_id: roomId, member_count: room.members.size })
  refreshRoom(roomId)
}

function signalRoom(socket: ServerWebSocket<ClientData>, roomId: string, payload: string): void {
  if (!socket.data.rooms.has(roomId)) throw new Error("Join the room before signaling")
  if (!payload || payload.length > MAX_SIGNAL_LENGTH) throw new Error("Invalid signal payload")
  const previousLength = socket.data.signals.get(roomId)?.length ?? 0
  if (retainedBytes - previousLength + payload.length > MAX_RETAINED_BYTES) throw new Error("Control service storage limit reached")
  retainedBytes += payload.length - previousLength
  socket.data.signals.set(roomId, payload)
  broadcastRoom(roomId, { type: "signal", room_id: roomId, payload }, socket)
}

function fetchPeers(socket: ServerWebSocket<ClientData>, roomId: string): void {
  if (!socket.data.rooms.has(roomId)) throw new Error("Join the room before fetching peers")
  const room = rooms.get(roomId)
  if (!room) return
  const payloads: string[] = []
  for (const member of room.members) {
    const payload = member.data.signals.get(roomId)
    if (payload) payloads.push(payload)
  }
  send(socket, { type: "peers", room_id: roomId, payloads })
}

function checkRateLimit(socket: ServerWebSocket<ClientData>, messageType: unknown): void {
  const now = Date.now()
  if (now - socket.data.windowStartedAt >= 60_000) {
    socket.data.windowStartedAt = now
    socket.data.controlMessagesInWindow = 0
    socket.data.signalsInWindow = 0
    socket.data.peerFetchesInWindow = 0
  }
  if (messageType === "signal") socket.data.signalsInWindow += 1
  else if (messageType === "get_peers") socket.data.peerFetchesInWindow += 1
  else socket.data.controlMessagesInWindow += 1
  if (socket.data.signalsInWindow > MAX_SIGNALS_PER_MINUTE || socket.data.controlMessagesInWindow > MAX_CONTROL_MESSAGES_PER_MINUTE || socket.data.peerFetchesInWindow > MAX_PEER_FETCHES_PER_MINUTE) throw new Error("Message rate limit exceeded")
  let ipLimit = rateLimitsByIp.get(socket.data.ip)
  if (!ipLimit || now - ipLimit.windowStartedAt >= 60_000) {
    ipLimit = { windowStartedAt: now, controlMessagesInWindow: 0, signalsInWindow: 0, peerFetchesInWindow: 0 }
    rateLimitsByIp.set(socket.data.ip, ipLimit)
  }
  if (messageType === "signal") ipLimit.signalsInWindow += 1
  else if (messageType === "get_peers") ipLimit.peerFetchesInWindow += 1
  else ipLimit.controlMessagesInWindow += 1
  if (ipLimit.signalsInWindow > MAX_SIGNALS_PER_MINUTE || ipLimit.controlMessagesInWindow > MAX_CONTROL_MESSAGES_PER_MINUTE || ipLimit.peerFetchesInWindow > MAX_PEER_FETCHES_PER_MINUTE) throw new Error("IP message rate limit exceeded")
}

function peersShareRoom(socket: ServerWebSocket<ClientData>, recipientId: string): boolean {
  if (!socket.data.peerId || socket.data.peerId === recipientId) return false
  for (const roomId of socket.data.rooms) {
    if ([...(rooms.get(roomId)?.members ?? [])].some((member) => member.data.peerId === recipientId)) return true
  }
  return false
}

function reserveRelayBandwidth(peerId: string, recipientId: string, bytes: number): boolean {
  const now = Date.now()
  const limits = [peerId, recipientId].map((id) => {
    const limit = deviceLimits.get(id)
    if (!limit) throw new Error("Relay device is not registered")
    limit.tokens = Math.min(RELAY_BURST_BYTES, limit.tokens + (now - limit.updatedAt) * RELAY_BYTES_PER_SECOND / 1000)
    limit.updatedAt = now
    for (const [remoteId, seenAt] of limit.relayPeers) if (now - seenAt > RELAY_PEER_IDLE_MS) limit.relayPeers.delete(remoteId)
    return limit
  })
  if (limits.some((limit) => limit.tokens < bytes)) return false
  if (
    (!limits[0].relayPeers.has(recipientId) && limits[0].relayPeers.size >= MAX_RELAY_PEERS_PER_DEVICE)
    || (!limits[1].relayPeers.has(peerId) && limits[1].relayPeers.size >= MAX_RELAY_PEERS_PER_DEVICE)
  ) return false
  limits[0].relayPeers.set(recipientId, now)
  limits[1].relayPeers.set(peerId, now)
  for (const limit of limits) limit.tokens -= bytes
  return true
}

function relayDatagram(socket: ServerWebSocket<ClientData>, recipientId: string, payload: string): void {
  if (!RELAY_ENABLED) throw new Error("MeshTalk Relay is disabled")
  if (!socket.data.peerId || !PEER_ID.test(recipientId)) throw new Error("Invalid relay frame")
  const frame = Buffer.from(payload, "base64")
  if (!frame.length || frame.length > MAX_RELAY_FRAME_LENGTH || frame.toString("base64") !== payload) throw new Error("Invalid relay frame")
  if (!peersShareRoom(socket, recipientId)) throw new Error("Relay recipient is not an authorized room member")
  const recipient = socketsByPeerId.get(recipientId)
  if (!recipient) {
    send(socket, { type: "relay_dropped", recipient_id: recipientId, reason: "offline", v: 1 })
    return
  }
  if (!reserveRelayBandwidth(socket.data.peerId, recipientId, frame.length)) {
    console.warn(`DERP relay quota exceeded for ${socket.data.peerId}`)
    send(socket, { type: "relay_dropped", recipient_id: recipientId, reason: "quota", v: 1 })
    return
  }
  send(recipient, { type: "relay", peer_id: socket.data.peerId, payload, v: 1 })
}

export function startControlServer(port = PORT) {
  return Bun.serve<ClientData>({
    port,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ status: "ok", rooms: rooms.size, connections })
      if (url.pathname !== "/v1/rendezvous") return new Response("Not found", { status: 404 })
      if (connections >= MAX_CONNECTIONS) return new Response("Control service is full", { status: 503 })
      const ip = request.headers.get("cf-connecting-ip") ?? server.requestIP(request)?.address ?? "unknown"
      if ((connectionsByIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) return new Response("Too many connections from this IP", { status: 429 })
      const upgraded = server.upgrade(request, {
        data: {
          ip, rooms: new Set(), signals: new Map(), windowStartedAt: Date.now(), controlMessagesInWindow: 0,
          signalsInWindow: 0, peerFetchesInWindow: 0, challengeId: randomBytes(16).toString("base64url"),
          challenge: randomBytes(32).toString("hex"), challengeExpiresAt: Math.floor(Date.now() / 1000) + 60,
        },
      })
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      maxPayloadLength: 256 * 1024,
      idleTimeout: 60,
      open(socket) {
        connections += 1
        connectionsByIp.set(socket.data.ip, (connectionsByIp.get(socket.data.ip) ?? 0) + 1)
        send(socket, { type: "device_challenge", challenge_id: socket.data.challengeId, nonce: socket.data.challenge, expires_at: socket.data.challengeExpiresAt, v: 1 })
      },
      message(socket, raw) {
        try {
          const message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ControlMessage
          if (message.type === "device_register") {
            checkRateLimit(socket, message.type)
            registerDevice(socket, message)
            return
          }
          if (!socket.data.peerId) throw new Error("Device registration required")
          if (message.type === "relay" && typeof message.recipient_id === "string" && typeof message.payload === "string") {
            relayDatagram(socket, message.recipient_id, message.payload)
            return
          }
          checkRateLimit(socket, message.type)
          if (message.type === "join" && typeof message.room_id === "string" && typeof message.room_auth === "string") joinRoom(socket, message.room_id, message.room_auth)
          else if (message.type === "leave" && typeof message.room_id === "string") leaveRoom(socket, message.room_id)
          else if (message.type === "signal" && typeof message.room_id === "string" && typeof message.payload === "string") signalRoom(socket, message.room_id, message.payload)
          else if (message.type === "get_peers" && typeof message.room_id === "string") fetchPeers(socket, message.room_id)
          else throw new Error("Invalid control message")
        } catch (error) {
          send(socket, { type: "error", error: error instanceof Error ? error.message : "Invalid request" })
          socket.close(1008, "Invalid control message")
        }
      },
      close(socket) {
        for (const roomId of [...socket.data.rooms]) leaveRoom(socket, roomId)
        if (socket.data.peerId && socketsByPeerId.get(socket.data.peerId) === socket) {
          socketsByPeerId.delete(socket.data.peerId)
          deviceLimits.delete(socket.data.peerId)
        }
        connections = Math.max(0, connections - 1)
        const count = (connectionsByIp.get(socket.data.ip) ?? 1) - 1
        if (count > 0) connectionsByIp.set(socket.data.ip, count)
        else connectionsByIp.delete(socket.data.ip)
      },
    },
  })
}

if (import.meta.main) {
  const server = startControlServer()
  console.log(`MeshTalk control server listening on http://${server.hostname}:${server.port}`)
}
