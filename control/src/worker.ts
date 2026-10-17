// Cloudflare Workers deployment of the MeshTalk control service.
//
// This is a second runtime for the same wire protocol as ./index.ts (the Bun
// server used for local development and Docker). Both import their limits and
// wire-format patterns from ./config, and the messages they send are identical,
// so clients cannot tell the two apart.
//
// Cloudflare gives Workers no memory shared between requests or isolates, but a
// single WebSocket connection can join several rooms and the relay routes by
// peer ID across those rooms. That state has to live in one place, so a single
// ControlRoom Durable Object owns every connection. This is deliberately one
// coordination atom rather than one object per room: splitting rooms across
// objects would break cross-room relay and room membership for a connection.
//
// No Durable Object storage is used. Rooms, signals, and registration are
// connection-scoped like the Bun server's in-memory Maps, and are lost when the
// object restarts (for example on deploy), which is the same behaviour as
// restarting the Bun process. The standard WebSocket API is used rather than
// hibernation specifically because that in-memory state must survive between
// messages.

import { DurableObject } from "cloudflare:workers"
import {
  HEX_32,
  HEX_64,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  MAX_CONTROL_MESSAGES_PER_MINUTE,
  MAX_PEER_FETCHES_PER_MINUTE,
  MAX_RELAY_FRAME_LENGTH,
  MAX_RELAY_FRAMES_PER_SECOND,
  MAX_RELAY_PEERS_PER_DEVICE,
  MAX_RETAINED_BYTES,
  MAX_ROOMS,
  MAX_ROOMS_PER_CLIENT,
  MAX_ROOM_MEMBERS,
  MAX_SIGNALS_PER_MINUTE,
  MAX_SIGNAL_LENGTH,
  PEER_ID,
  RELAY_BURST_BYTES,
  RELAY_BYTES_PER_SECOND,
  RELAY_PEER_IDLE_MS,
  ROOM_AUTH,
  ROOM_ID,
} from "./config"

type ClientData = {
  ip: string
  rooms: Set<string>
  signals: Map<string, string>
  windowStartedAt: number
  controlMessagesInWindow: number
  signalsInWindow: number
  peerFetchesInWindow: number
  relayWindowStartedAt: number
  relayFramesInWindow: number
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
  members: Set<WebSocket>
}

type DeviceLimit = {
  tokens: number
  updatedAt: number
  relayPeers: Map<string, number>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toHex(bytes: Uint8Array): string {
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function canonical(value: object): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(value, Object.keys(value as object).sort()))
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
}

async function verifyEd25519(signingPublicKeyHex: string, signatureHex: string, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
  // SPKI DER prefix for an Ed25519 public key, followed by the raw 32-byte key.
  const spki = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...fromHex(signingPublicKeyHex)])
  const key = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"])
  return crypto.subtle.verify("Ed25519", key, fromHex(signatureHex), message)
}

export class ControlRoom extends DurableObject {
  private readonly rooms = new Map<string, RoomState>()
  private readonly connectionsByIp = new Map<string, number>()
  private readonly rateLimitsByIp = new Map<string, RateLimit>()
  private readonly socketsByPeerId = new Map<string, WebSocket>()
  private readonly deviceLimits = new Map<string, DeviceLimit>()
  private readonly clients = new Map<WebSocket, ClientData>()
  private connections = 0
  private retainedBytes = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: { CONTROL_RELAY_ENABLED?: string }) {
    super(ctx, env)
  }

  private get relayEnabled(): boolean {
    return (this.env as { CONTROL_RELAY_ENABLED?: string } | undefined)?.CONTROL_RELAY_ENABLED !== "false"
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", rooms: this.rooms.size, connections: this.connections })
    }
    if (url.pathname !== "/v1/rendezvous") return new Response("Not found", { status: 404 })
    if (this.connections >= MAX_CONNECTIONS) return new Response("Control service is full", { status: 503 })

    // Workers always populate cf-connecting-ip with the real client address, so
    // there is no equivalent of the Bun server's trusted-proxy toggle here.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
    if ((this.connectionsByIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      return new Response("Too many connections from this IP", { status: 429 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    server.accept()

    const data: ClientData = {
      ip,
      rooms: new Set(),
      signals: new Map(),
      windowStartedAt: Date.now(),
      controlMessagesInWindow: 0,
      signalsInWindow: 0,
      peerFetchesInWindow: 0,
      relayWindowStartedAt: Date.now(),
      relayFramesInWindow: 0,
      challengeId: toBase64Url(randomBytes(16)),
      challenge: toHex(randomBytes(32)),
      challengeExpiresAt: Math.floor(Date.now() / 1000) + 60,
    }
    this.clients.set(server, data)
    this.connections += 1
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) ?? 0) + 1)

    server.addEventListener("message", (event) => {
      this.enqueue(() => this.handleMessage(server, event.data))
    })
    server.addEventListener("error", () => this.enqueue(() => this.handleClose(server)))
    server.addEventListener("close", (event) => {
      // Acknowledge the close handshake before tearing down room state.
      try { server.close(event.code, event.reason) } catch {}
      this.enqueue(() => this.handleClose(server))
    })

    send(server, {
      type: "device_challenge",
      challenge_id: data.challengeId,
      nonce: data.challenge,
      expires_at: data.challengeExpiresAt,
      v: 1,
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  // Serialize handlers so the awaits in device registration cannot interleave
  // with another message and corrupt room or device state.
  private enqueue(task: () => Promise<void> | void): void {
    this.queue = this.queue.then(task).catch(() => {})
  }

  private async handleMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const data = this.clients.get(socket)
    if (!data) return
    let message: ControlMessage
    try {
      message = JSON.parse(typeof raw === "string" ? raw : decoder.decode(raw)) as ControlMessage
    } catch (error) {
      send(socket, { type: "error", error: error instanceof Error ? error.message : "Invalid request" })
      socket.close(1008, "Invalid control message")
      return
    }
    try {
      if (message.type === "device_register") {
        this.checkRateLimit(socket, data, message.type)
        await this.registerDevice(socket, data, message)
        return
      }
      if (!data.peerId) throw new Error("Device registration required")
      if (message.type === "relay" && typeof message.recipient_id === "string" && typeof message.payload === "string") {
        this.checkRelayRateLimit(data)
        this.relayDatagram(socket, data, message.recipient_id, message.payload)
        return
      }
      this.checkRateLimit(socket, data, message.type)
      if (message.type === "join" && typeof message.room_id === "string" && typeof message.room_auth === "string") {
        this.joinRoom(socket, data, message.room_id, message.room_auth)
      } else if (message.type === "leave" && typeof message.room_id === "string") {
        this.leaveRoom(socket, data, message.room_id)
      } else if (message.type === "signal" && typeof message.room_id === "string" && typeof message.payload === "string") {
        this.signalRoom(socket, data, message.room_id, message.payload)
      } else if (message.type === "get_peers" && typeof message.room_id === "string") {
        this.fetchPeers(socket, data, message.room_id)
      } else throw new Error("Invalid control message")
    } catch (error) {
      send(socket, { type: "error", error: error instanceof Error ? error.message : "Invalid request" })
      socket.close(1008, "Invalid control message")
    }
  }

  private handleClose(socket: WebSocket): void {
    const data = this.clients.get(socket)
    if (!data) return
    for (const roomId of [...data.rooms]) this.leaveRoom(socket, data, roomId)
    if (data.peerId && this.socketsByPeerId.get(data.peerId) === socket) {
      this.socketsByPeerId.delete(data.peerId)
      this.deviceLimits.delete(data.peerId)
    }
    this.clients.delete(socket)
    this.connections = Math.max(0, this.connections - 1)
    const count = (this.connectionsByIp.get(data.ip) ?? 1) - 1
    if (count > 0) this.connectionsByIp.set(data.ip, count)
    else this.connectionsByIp.delete(data.ip)
  }

  private async registerDevice(socket: WebSocket, data: ClientData, message: ControlMessage): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    if (
      typeof message.challenge_id !== "string" || message.challenge_id !== data.challengeId
      || typeof message.nonce !== "string" || message.nonce !== data.challenge || typeof message.issued_at !== "number"
      || Math.abs(now - message.issued_at) > 30 || typeof message.peer_id !== "string" || !PEER_ID.test(message.peer_id)
      || typeof message.signing_public_key !== "string" || !HEX_32.test(message.signing_public_key)
      || typeof message.signature !== "string" || !HEX_64.test(message.signature)
    ) throw new Error("Invalid device registration")
    const key = fromHex(message.signing_public_key)
    if (await sha256Hex(key) !== message.peer_id) throw new Error("Device identity mismatch")
    const signed = {
      challenge_id: message.challenge_id,
      issued_at: message.issued_at,
      kind: "meshtalk-device-register-v1",
      nonce: message.nonce,
      peer_id: message.peer_id,
      signing_public_key: message.signing_public_key,
      v: 1,
    }
    if (!await verifyEd25519(message.signing_public_key, message.signature, canonical(signed))) {
      throw new Error("Invalid device signature")
    }
    const previous = this.socketsByPeerId.get(message.peer_id)
    if (previous && previous !== socket) previous.close(4000, "Replaced by a newer device session")
    data.peerId = message.peer_id
    this.socketsByPeerId.set(message.peer_id, socket)
    if (!this.deviceLimits.has(message.peer_id)) {
      this.deviceLimits.set(message.peer_id, { tokens: RELAY_BURST_BYTES, updatedAt: Date.now(), relayPeers: new Map() })
    }
    send(socket, { type: "device_registered", peer_id: message.peer_id, relay_enabled: this.relayEnabled, v: 1 })
  }

  private broadcastRoom(roomId: string, value: object, except?: WebSocket): void {
    for (const member of this.rooms.get(roomId)?.members ?? []) {
      if (member !== except) send(member, value)
    }
  }

  private refreshRoom(roomId: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    this.broadcastRoom(roomId, { type: "refresh", room_id: roomId, member_count: room.members.size })
  }

  private leaveRoom(socket: WebSocket, data: ClientData, roomId: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    room.members.delete(socket)
    data.rooms.delete(roomId)
    this.retainedBytes -= data.signals.get(roomId)?.length ?? 0
    data.signals.delete(roomId)
    if (!room.members.size) {
      this.rooms.delete(roomId)
      return
    }
    this.refreshRoom(roomId)
  }

  private joinRoom(socket: WebSocket, data: ClientData, roomId: string, roomAuth: string): void {
    if (!ROOM_ID.test(roomId) || !ROOM_AUTH.test(roomAuth)) throw new Error("Invalid room authorization")
    if (data.rooms.has(roomId)) return
    if (data.rooms.size >= MAX_ROOMS_PER_CLIENT) throw new Error("Too many joined rooms")
    let room = this.rooms.get(roomId)
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) throw new Error("Control service room limit reached")
      room = { auth: roomAuth, members: new Set() }
      this.rooms.set(roomId, room)
    }
    if (!timingSafeEqual(fromHex(room.auth), fromHex(roomAuth))) throw new Error("Room authorization failed")
    if (room.members.size >= MAX_ROOM_MEMBERS) throw new Error("Room is full")
    for (const member of room.members) {
      const payload = this.clients.get(member)?.signals.get(roomId)
      if (payload) send(socket, { type: "signal", room_id: roomId, payload })
    }
    room.members.add(socket)
    data.rooms.add(roomId)
    send(socket, { type: "joined", room_id: roomId, member_count: room.members.size })
    this.refreshRoom(roomId)
  }

  private signalRoom(socket: WebSocket, data: ClientData, roomId: string, payload: string): void {
    if (!data.rooms.has(roomId)) throw new Error("Join the room before signaling")
    if (!payload || payload.length > MAX_SIGNAL_LENGTH) throw new Error("Invalid signal payload")
    const previousLength = data.signals.get(roomId)?.length ?? 0
    if (this.retainedBytes - previousLength + payload.length > MAX_RETAINED_BYTES) throw new Error("Control service storage limit reached")
    this.retainedBytes += payload.length - previousLength
    data.signals.set(roomId, payload)
    this.broadcastRoom(roomId, { type: "signal", room_id: roomId, payload }, socket)
  }

  private fetchPeers(socket: WebSocket, data: ClientData, roomId: string): void {
    if (!data.rooms.has(roomId)) throw new Error("Join the room before fetching peers")
    const room = this.rooms.get(roomId)
    if (!room) return
    const payloads: string[] = []
    for (const member of room.members) {
      const payload = this.clients.get(member)?.signals.get(roomId)
      if (payload) payloads.push(payload)
    }
    send(socket, { type: "peers", room_id: roomId, payloads })
  }

  private checkRateLimit(socket: WebSocket, data: ClientData, messageType: unknown): void {
    const now = Date.now()
    if (now - data.windowStartedAt >= 60_000) {
      data.windowStartedAt = now
      data.controlMessagesInWindow = 0
      data.signalsInWindow = 0
      data.peerFetchesInWindow = 0
    }
    if (messageType === "signal") data.signalsInWindow += 1
    else if (messageType === "get_peers") data.peerFetchesInWindow += 1
    else data.controlMessagesInWindow += 1
    if (data.signalsInWindow > MAX_SIGNALS_PER_MINUTE || data.controlMessagesInWindow > MAX_CONTROL_MESSAGES_PER_MINUTE || data.peerFetchesInWindow > MAX_PEER_FETCHES_PER_MINUTE) throw new Error("Message rate limit exceeded")
    let ipLimit = this.rateLimitsByIp.get(data.ip)
    if (!ipLimit || now - ipLimit.windowStartedAt >= 60_000) {
      ipLimit = { windowStartedAt: now, controlMessagesInWindow: 0, signalsInWindow: 0, peerFetchesInWindow: 0 }
      this.rateLimitsByIp.set(data.ip, ipLimit)
    }
    if (messageType === "signal") ipLimit.signalsInWindow += 1
    else if (messageType === "get_peers") ipLimit.peerFetchesInWindow += 1
    else ipLimit.controlMessagesInWindow += 1
    if (ipLimit.signalsInWindow > MAX_SIGNALS_PER_MINUTE || ipLimit.controlMessagesInWindow > MAX_CONTROL_MESSAGES_PER_MINUTE || ipLimit.peerFetchesInWindow > MAX_PEER_FETCHES_PER_MINUTE) throw new Error("IP message rate limit exceeded")
  }

  private checkRelayRateLimit(data: ClientData): void {
    const now = Date.now()
    if (now - data.relayWindowStartedAt >= 1_000) {
      data.relayWindowStartedAt = now
      data.relayFramesInWindow = 0
    }
    data.relayFramesInWindow += 1
    if (data.relayFramesInWindow > MAX_RELAY_FRAMES_PER_SECOND) throw new Error("Relay frame rate limit exceeded")
  }

  private peersShareRoom(socket: WebSocket, data: ClientData, recipientId: string): boolean {
    if (!data.peerId || data.peerId === recipientId) return false
    for (const roomId of data.rooms) {
      for (const member of this.rooms.get(roomId)?.members ?? []) {
        if (this.clients.get(member)?.peerId === recipientId) return true
      }
    }
    return false
  }

  private reserveRelayBandwidth(peerId: string, recipientId: string, bytes: number): boolean {
    const now = Date.now()
    const limits = [peerId, recipientId].map((id) => {
      const limit = this.deviceLimits.get(id)
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

  private relayDatagram(socket: WebSocket, data: ClientData, recipientId: string, payload: string): void {
    if (!this.relayEnabled) throw new Error("MeshTalk Relay is disabled")
    if (!data.peerId || !PEER_ID.test(recipientId)) throw new Error("Invalid relay frame")
    let frame: Uint8Array
    try {
      frame = fromBase64(payload)
    } catch {
      throw new Error("Invalid relay frame")
    }
    if (!frame.length || frame.length > MAX_RELAY_FRAME_LENGTH || toBase64(frame) !== payload) throw new Error("Invalid relay frame")
    if (!this.peersShareRoom(socket, data, recipientId)) {
      send(socket, { type: "relay_dropped", recipient_id: recipientId, reason: "unauthorized", v: 1 })
      return
    }
    const recipient = this.socketsByPeerId.get(recipientId)
    if (!recipient) {
      send(socket, { type: "relay_dropped", recipient_id: recipientId, reason: "offline", v: 1 })
      return
    }
    if (!this.reserveRelayBandwidth(data.peerId, recipientId, frame.length)) {
      console.warn(`DERP relay quota exceeded for ${data.peerId}`)
      send(socket, { type: "relay_dropped", recipient_id: recipientId, reason: "quota", v: 1 })
      return
    }
    send(recipient, { type: "relay", peer_id: data.peerId, payload, v: 1 })
  }
}

function send(socket: WebSocket, value: object): void {
  socket.send(JSON.stringify(value))
}

export default {
  async fetch(request: Request, env: { CONTROL: { idFromName(name: string): unknown, get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return env.CONTROL.get(env.CONTROL.idFromName("global")).fetch(request)
    }
    if (url.pathname !== "/v1/rendezvous") return new Response("Not found", { status: 404 })
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 })
    }
    return env.CONTROL.get(env.CONTROL.idFromName("global")).fetch(request)
  },
}
