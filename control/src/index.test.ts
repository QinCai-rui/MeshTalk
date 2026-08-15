import { afterEach, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { startControlServer } from "./index"

let server: Server<unknown> | undefined
const sockets: WebSocket[] = []

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

describe("opaque control service", () => {
  test("retains and forwards a room's encrypted blob without interpreting it", async () => {
    server = startControlServer(0)
    const url = `ws://127.0.0.1:${server.port}/v1/rendezvous`
    const roomId = "0123456789abcdef0123456789abcdef"
    const first = await open(url)
    const joined = waitFor(first, (message) => message.type === "joined")
    first.send(JSON.stringify({ type: "join", room_id: roomId }))
    await joined
    first.send(JSON.stringify({ type: "signal", room_id: roomId, payload: "opaque-encrypted-card" }))

    const second = await open(url)
    const signal = waitFor(second, (message) => message.type === "signal")
    second.send(JSON.stringify({ type: "join", room_id: roomId }))

    expect(await signal).toEqual({ type: "signal", room_id: roomId, payload: "opaque-encrypted-card" })
    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((response) => response.json())
    expect(health).toEqual({ status: "ok", rooms: 1 })
  })
})
