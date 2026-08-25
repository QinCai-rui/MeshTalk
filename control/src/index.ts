import type { ServerWebSocket } from "bun"
import { createHash, createHmac, createPublicKey, randomBytes, verify } from "crypto"

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
  payload?: unknown
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
const ROOM_ID = /^[a-f0-9]{32}$/
const PEER_ID = /^[a-f0-9]{64}$/
const HEX_32 = /^[a-f0-9]{64}$/
const HEX_64 = /^[a-f0-9]{128}$/
const TURN_ENABLED = process.env.CONTROL_TURN_ENABLED === "true"
const TURN_URIS = (process.env.CONTROL_TURN_URIS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
const TURN_SHARED_SECRET = process.env.CONTROL_TURN_SHARED_SECRET ?? ""
const TURN_TTL_SECONDS = Number(process.env.CONTROL_TURN_TTL_SECONDS ?? 600)

const rooms = new Map<string, Set<ServerWebSocket<ClientData>>>()
let connections = 0
let retainedBytes = 0
const connectionsByIp = new Map<string, number>()
const rateLimitsByIp = new Map<string, RateLimit>()

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
  socket.data.peerId = message.peer_id
  send(socket, { type: "device_registered", peer_id: message.peer_id, v: 1 })
}

function issueTurnCredentials(socket: ServerWebSocket<ClientData>): void {
  if (!socket.data.peerId) throw new Error("Device registration required")
  if (!TURN_ENABLED || !TURN_SHARED_SECRET || !TURN_URIS.length) throw new Error("TURN is not configured")
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS
  const username = `${expiry}:${socket.data.peerId}`
  send(socket, { type: "turn_credentials", uris: TURN_URIS, username, credential: createHmac("sha1", TURN_SHARED_SECRET).update(username).digest("base64"), ttl: TURN_TTL_SECONDS, v: 1 })
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

function fetchPeers(socket: ServerWebSocket<ClientData>, roomId: string): void {
  if (!socket.data.rooms.has(roomId)) throw new Error("Join the room before fetching peers")
  const members = rooms.get(roomId)
  if (!members) return
  const payloads: string[] = []
  for (const member of members) {
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
  if (
    socket.data.signalsInWindow > MAX_SIGNALS_PER_MINUTE
    || socket.data.controlMessagesInWindow > MAX_CONTROL_MESSAGES_PER_MINUTE
    || socket.data.peerFetchesInWindow > MAX_PEER_FETCHES_PER_MINUTE
  ) {
    throw new Error("Message rate limit exceeded")
  }
  let ipLimit = rateLimitsByIp.get(socket.data.ip)
  if (!ipLimit || now - ipLimit.windowStartedAt >= 60_000) {
    ipLimit = { windowStartedAt: now, controlMessagesInWindow: 0, signalsInWindow: 0, peerFetchesInWindow: 0 }
    rateLimitsByIp.set(socket.data.ip, ipLimit)
  }
  if (messageType === "signal") ipLimit.signalsInWindow += 1
  else if (messageType === "get_peers") ipLimit.peerFetchesInWindow += 1
  else ipLimit.controlMessagesInWindow += 1
  if (
    ipLimit.signalsInWindow > MAX_SIGNALS_PER_MINUTE
    || ipLimit.controlMessagesInWindow > MAX_CONTROL_MESSAGES_PER_MINUTE
    || ipLimit.peerFetchesInWindow > MAX_PEER_FETCHES_PER_MINUTE
  ) {
    throw new Error("IP message rate limit exceeded")
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
      const ip = server.requestIP(request)?.address ?? "unknown"
      if ((connectionsByIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
        return new Response("Too many connections from this IP", { status: 429 })
      }
      const upgraded = server.upgrade(request, {
        data: {
          ip,
          rooms: new Set(),
          signals: new Map(),
          windowStartedAt: Date.now(),
          controlMessagesInWindow: 0,
          signalsInWindow: 0,
          peerFetchesInWindow: 0,
          challengeId: randomBytes(16).toString("base64url"),
          challenge: randomBytes(32).toString("hex"),
          challengeExpiresAt: Math.floor(Date.now() / 1000) + 60,
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
        let isTurnCredentialsRequest = false
        try {
          const message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ControlMessage
          isTurnCredentialsRequest = message.type === "turn_credentials"
          if (message.type === "device_register") {
            checkRateLimit(socket, message.type)
            registerDevice(socket, message)
            return
          }
          if (message.type === "turn_credentials") {
            checkRateLimit(socket, message.type)
            issueTurnCredentials(socket)
            return
          }
          if (TURN_ENABLED && !socket.data.peerId) throw new Error("Device registration required")
          checkRateLimit(socket, message.type)
          if (message.type === "join" && typeof message.room_id === "string") {
            joinRoom(socket, message.room_id)
          } else if (message.type === "leave" && typeof message.room_id === "string") {
            leaveRoom(socket, message.room_id)
          } else if (
            message.type === "signal" && typeof message.room_id === "string" && typeof message.payload === "string"
          ) {
            signalRoom(socket, message.room_id, message.payload)
          } else if (message.type === "get_peers" && typeof message.room_id === "string") {
            fetchPeers(socket, message.room_id)
          } else {
            throw new Error("Invalid control message")
          }
        } catch (error) {
          send(socket, { type: "error", error: error instanceof Error ? error.message : "Invalid request" })
          if (isTurnCredentialsRequest) return
          socket.close(1008, "Invalid control message")
        }
      },
      close(socket) {
        for (const roomId of [...socket.data.rooms]) leaveRoom(socket, roomId)
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
