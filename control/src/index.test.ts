import { afterEach, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "crypto"
import type { Server } from "bun"
import { startControlServer } from "./index"

let server: Server<unknown> | undefined
const sockets: WebSocket[] = []
const roomId = "0123456789abcdef0123456789abcdef"
const roomAuth = "a".repeat(64)

afterEach(() => {
  for (const socket of sockets) socket.close()
  sockets.length = 0
  server?.stop(true)
  server = undefined
})

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    sockets.push(socket)
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true })
  })
}

function waitFor(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for control message")), 1000)
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (!predicate(message)) return
      clearTimeout(timeout)
      socket.removeEventListener("message", listener)
      resolve(message)
    }
    socket.addEventListener("message", listener)
  })
}

async function register(socket: WebSocket): Promise<string> {
  const challenge = await waitFor(socket, (message) => message.type === "device_challenge")
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const signingPublicKey = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32)
  const peerId = createHash("sha256").update(signingPublicKey).digest("hex")
  const signed = {
    challenge_id: challenge.challenge_id, issued_at: Math.floor(Date.now() / 1000),
    kind: "meshtalk-device-register-v1", nonce: challenge.nonce, peer_id: peerId,
    signing_public_key: signingPublicKey.toString("hex"), v: 1,
  }
  const signature = sign(null, Buffer.from(JSON.stringify(signed, Object.keys(signed).sort())), privateKey).toString("hex")
  const registered = waitFor(socket, (message) => message.type === "device_registered")
  socket.send(JSON.stringify({ type: "device_register", ...signed, signature }))
  expect((await registered).peer_id).toBe(peerId)
  return peerId
}

async function join(socket: WebSocket, auth = roomAuth): Promise<void> {
  const joined = waitFor(socket, (message) => message.type === "joined")
  socket.send(JSON.stringify({ type: "join", room_id: roomId, room_auth: auth }))
  await joined
}

describe("authenticated DERP control service", () => {
  test("retains encrypted cards only for devices with the room capability", async () => {
    server = startControlServer(0)
    const url = `ws://127.0.0.1:${server.port}/v1/rendezvous`
    const first = await open(url)
    await register(first)
    await join(first)
    first.send(JSON.stringify({ type: "signal", room_id: roomId, payload: "opaque-encrypted-card" }))

    const second = await open(url)
    await register(second)
    const signal = waitFor(second, (message) => message.type === "signal")
    await join(second)
    expect(await signal).toEqual({ type: "signal", room_id: roomId, payload: "opaque-encrypted-card" })
  })

  test("rejects a room join with a different invite-derived capability", async () => {
    server = startControlServer(0)
    const url = `ws://127.0.0.1:${server.port}/v1/rendezvous`
    const first = await open(url)
    await register(first)
    await join(first)
    const second = await open(url)
    await register(second)
    const rejected = waitFor(second, (message) => message.type === "error")
    second.send(JSON.stringify({ type: "join", room_id: roomId, room_auth: "b".repeat(64) }))
    expect((await rejected).error).toBe("Room authorization failed")
  })

  test("forwards bounded DERP frames only to an authorized peer ID", async () => {
    server = startControlServer(0)
    const url = `ws://127.0.0.1:${server.port}/v1/rendezvous`
    const first = await open(url)
    const firstId = await register(first)
    await join(first)
    const second = await open(url)
    const secondId = await register(second)
    await join(second)
    const frame = Buffer.from("encrypted-meshtalk-datagram").toString("base64")
    const relayed = waitFor(second, (message) => message.type === "relay")
    first.send(JSON.stringify({ type: "relay", recipient_id: secondId, payload: frame }))
    expect(await relayed).toEqual({ type: "relay", peer_id: firstId, payload: frame, v: 1 })
  })

  test("rejects arbitrary relay destinations and oversized frames", async () => {
    server = startControlServer(0)
    const url = `ws://127.0.0.1:${server.port}/v1/rendezvous`
    const socket = await open(url)
    await register(socket)
    await join(socket)
    const rejected = waitFor(socket, (message) => message.type === "error")
    socket.send(JSON.stringify({ type: "relay", recipient_id: "f".repeat(64), payload: Buffer.alloc(1201).toString("base64") }))
    expect((await rejected).error).toBe("Invalid relay frame")
  })

  test("limits a device to eight active MeshTalk Relay peers", async () => {
    server = startControlServer(0)
    const url = `ws://127.0.0.1:${server.port}/v1/rendezvous`
    const sender = await open(url)
    await register(sender)
    await join(sender)
    const recipients: string[] = []
    for (let index = 0; index < 9; index += 1) {
      const recipient = await open(url)
      recipients.push(await register(recipient))
      await join(recipient)
    }
    const dropped = waitFor(sender, (message) => message.type === "relay_dropped" && message.reason === "quota")
    for (const recipientId of recipients) {
      sender.send(JSON.stringify({ type: "relay", recipient_id: recipientId, payload: "AA==" }))
    }
    expect((await dropped).recipient_id).toBe(recipients[8])
  })

  test("closes with code 1008 for malformed JSON", async () => {
    server = startControlServer(0)
    const socket = await open(`ws://127.0.0.1:${server.port}/v1/rendezvous`)
    await waitFor(socket, (message) => message.type === "device_challenge")
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }))
    socket.send("invalid-json{")
    expect(await closePromise).toEqual({ code: 1008, reason: "Invalid control message" })
  })
})
