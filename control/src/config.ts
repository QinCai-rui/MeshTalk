// Protocol limits and wire-format patterns shared by both control-service
// runtimes: the Bun server in ./index.ts (local development and Docker) and the
// Cloudflare Workers/Durable Object port in ./worker.ts. Keeping them here means
// a limit change cannot silently apply to only one deployment.

export const MAX_ROOM_MEMBERS = 64
export const MAX_ROOMS_PER_CLIENT = 32
export const MAX_SIGNAL_LENGTH = 8 * 1024
export const MAX_CONTROL_MESSAGES_PER_MINUTE = 96
export const MAX_SIGNALS_PER_MINUTE = 64
export const MAX_PEER_FETCHES_PER_MINUTE = 30
export const MAX_RELAY_FRAMES_PER_SECOND = 500
export const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024
// Worker admission includes the running message until its handler releases it.
export const MAX_PENDING_MESSAGES = 256
export const MAX_PENDING_MESSAGE_BYTES = 4 * 1024 * 1024
export const MAX_PENDING_MESSAGES_PER_CLIENT = 16
export const MAX_PENDING_MESSAGE_BYTES_PER_CLIENT = 256 * 1024
export const MAX_PENDING_MESSAGES_PER_IP = 32
export const MAX_PENDING_MESSAGE_BYTES_PER_IP = 512 * 1024
export const MAX_CONNECTIONS = 10_000
export const MAX_CONNECTIONS_PER_IP = 32
export const MAX_ROOMS = 10_000
export const MAX_RETAINED_BYTES = 64 * 1024 * 1024
export const MAX_RELAY_FRAME_LENGTH = 1200
export const MAX_RELAY_PEERS_PER_DEVICE = 8
// Peer slots belong to the sender. Receive bytes have a separate token bucket.
export const RELAY_PEER_IDLE_MS = 60_000
export const RELAY_BYTES_PER_SECOND = 1024 * 1024
export const RELAY_BURST_BYTES = 4 * 1024 * 1024

export const ROOM_ID = /^[a-f0-9]{32}$/
export const ROOM_AUTH = /^[a-f0-9]{64}$/
export const PEER_ID = /^[a-f0-9]{64}$/
export const HEX_32 = /^[a-f0-9]{64}$/
export const HEX_64 = /^[a-f0-9]{128}$/
