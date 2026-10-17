import type { Row } from "./api"

// Browser-only, in-memory sample data. No backend, files, identity, or network access.
export function createDemoClient() {
  const now = Math.floor(Date.now() / 1000)
  const identity: Row = { peer_id: "demo-self", display_name: "Alex Morgan", setup_dismissed: true, dnd_enabled: false, flashing_enabled: true }
  const peers: Row[] = [
    { peer_id: "alice", display_name: "Alice Chen", is_online: true, presence: "active", is_friend: true, last_interaction: now - 60, unread_count: 0, active_transport: "tcp" },
    { peer_id: "sam", display_name: "Sam Rivera", is_online: true, presence: "away", is_friend: true, last_interaction: now - 900, unread_count: 2 },
    { peer_id: "jules", display_name: "Jules Park", is_online: false, is_friend: true, last_interaction: now - 3600, unread_count: 0 },
    { peer_id: "noah", display_name: "Noah Patel", is_online: true, presence: "active", is_friend: false, last_interaction: now - 5000, unread_count: 0, friend_request: "incoming" },
  ]
  const groups: Row[] = [{ group_id: "weekend", name: "Weekend plans", member_count: 4, unread_count: 1, last_interaction: now - 120 }]
  const rooms: Row[] = [{ room_id: "weekend", group_id: "weekend", name: "Weekend plans", members: 4 }]
  const messages: Record<string, Row[]> = {
    alice: [
      { message_id: "alice-1", sender_id: "alice", content: "Hey! I found a spot for Saturday. It's right by the lake.", created_at: now - 1500 },
      { message_id: "alice-2", sender_id: "alice", content: "There's a trail nearby too, if the weather holds up.", created_at: now - 1480 },
      { message_id: "alice-3", sender_id: identity.peer_id, content: "That sounds perfect. Shall we meet around 10?", created_at: now - 1300 },
      { message_id: "alice-4", sender_id: "alice", content: "10 works! I'll bring coffee.", created_at: now - 300 },
      { message_id: "alice-5", sender_id: identity.peer_id, content: "Deal. I'll put it in the group so everyone knows.", created_at: now - 60 },
    ],
    sam: [{ message_id: "sam-1", sender_id: "sam", content: "I can bring the camera this weekend.", created_at: now - 900 }],
    jules: [{ message_id: "jules-1", sender_id: "jules", content: "See you Saturday!", created_at: now - 3600 }],
    weekend: [{ message_id: "group-1", sender_id: "sam", content: "Anyone up for a walk by the lake on Saturday?", created_at: now - 120 }],
  }
  const preferences: Row = { version: "Design demo", close_mode: "tray", autostart: false, update_channel: "stable" }
  const control: Row = { url: "wss://meshtalk-control.qincai.xyz/v1/rendezvous", connected: true, public_endpoint: ["203.0.113.8", 24891], reconnect_attempts: 0, stun_server: "stun.example.org:3478" }
  const analytics: Row = { analytics_level: "off" }
  const notifications: Row = { delivery: "native", events: { messages: true, friend_requests: true, file_offers: true, file_completed: false } }
  const advanced: Row = { control_pinned_ips: [], stun_pinned_ips: [], stun_server: control.stun_server }
  const requests: Row[] = [{ request_id: "noah-request", sender_id: "noah", sender_name: "Noah Patel", direction: "incoming", note: "I'm on the same local network. Want to connect?" }]
  const blocked: Row[] = []
  const muted: Row = { muted_peers: {}, muted_groups: {} }
  let drafts: Row = {}
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emit = () => { listeners.get("backend-event")?.forEach(listener => listener({ event: "demo-update" })) }

  async function request(action: string, params: Row) {
    switch (action) {
      case "identity": return { ...identity }
      case "peers": return { peers: peers.map(peer => ({ ...peer })) }
      case "groups": return { groups: groups.map(group => ({ ...group })) }
      case "friend_requests": return { requests: [...requests] }
      case "blocked_peers": return { blocked: [...blocked] }
      case "muted_peers": return structuredClone(muted)
      case "rooms": return { rooms: [...rooms] }
      case "desktop_drafts": if (params.drafts) drafts = { ...params.drafts }; return { drafts }
      case "messages":
      case "group_messages": {
        const id = params.peer_id ?? params.group_id
        const row = peers.find(peer => peer.peer_id === id) ?? groups.find(group => group.group_id === id)
        if (row) row.unread_count = 0
        return { messages: [...(messages[id] ?? [])] }
      }
      case "group_members": return { members: [identity, ...peers.slice(0, 3)] }
      case "files": return { files: [] }
      case "files_dir": return { files_dir: "Sample download folder" }
      case "tui_presence":
      case "typing": return {}
      case "control": Object.assign(control, params); control.connected = Boolean(control.url); return { ...control }
      case "analytics": if (params.level) analytics.analytics_level = params.level; return { ...analytics }
      case "notifications": if (params.delivery) notifications.delivery = params.delivery; Object.assign(notifications.events, params.events); return structuredClone(notifications)
      case "advanced_config": {
        for (const service of ["control", "stun"]) {
          if (params[`clear_${service}_pinned_ip`]) advanced[`${service}_pinned_ips`] = []
          if (params[`auto_${service}_pinned_ip`]) advanced[`${service}_pinned_ips`] = ["203.0.113.8"]
          if (params[`${service}_pinned_ip`]) advanced[`${service}_pinned_ips`] = params[`${service}_pinned_ip`].split(",").map((ip: string) => ip.trim())
        }
        return structuredClone(advanced)
      }
      case "set_display_name": identity.display_name = params.display_name; emit(); return {}
      case "dnd": identity.dnd_enabled = params.enabled; emit(); return {}
      case "accessibility": identity.flashing_enabled = params.flashing_enabled; return {}
      case "send":
      case "group_send": {
        const id = params.recipient_id ?? params.group_id
        const message = { message_id: crypto.randomUUID(), sender_id: identity.peer_id, content: params.content, created_at: Date.now() / 1000, reply_to_message_id: params.reply_to_message_id }
        ;(messages[id] ??= []).push(message)
        emit(); return { message_id: message.message_id }
      }
      case "history_page": return { messages: [...(messages[params.peer_id ?? params.group_id] ?? [])], next_before: null }
      case "search_messages": return { results: Object.entries(messages).filter(([id]) => !(params.peer_id ?? params.group_id) || id === (params.peer_id ?? params.group_id)).flatMap(([id, rows]) => rows.filter(row => row.content.toLowerCase().includes((params.query ?? "").toLowerCase())).map(row => ({ ...row, kind: id === "weekend" || groups.some(group => group.group_id === id) ? "group" : "peer", conversation_id: id }))), next_offset: null }
      case "room_invite": return { invite: "meshtalk://demo-invite-not-valid" }
      case "room_create": {
        const id = crypto.randomUUID(); groups.push({ group_id: id, name: params.name, member_count: 1, unread_count: 0 }); rooms.push({ room_id: id, group_id: id, name: params.name, members: 1 }); emit(); return { group_id: id, invite: "meshtalk://demo-invite-not-valid" }
      }
      case "room_join": throw new Error("This is a sample-data demo. Real invites are only available in the desktop app.")
      case "group_leave":
      case "room_leave": {
        const id = params.group_id ?? params.room_id
        const roomIndex = rooms.findIndex(room => room.room_id === id); if (roomIndex >= 0) rooms.splice(roomIndex, 1)
        const groupIndex = groups.findIndex(group => group.group_id === id); if (groupIndex >= 0) groups.splice(groupIndex, 1)
        emit(); return {}
      }
      case "mute":
      case "unmute": {
        const list = params.group_id ? muted.muted_groups : muted.muted_peers
        const id = params.group_id ?? params.peer_id
        if (action === "unmute") delete list[id]; else list[id] = params.timeout ? Date.now() / 1000 + params.timeout : 0
        emit(); return {}
      }
      case "friend_respond":
      case "friend_cancel": {
        const index = requests.findIndex(row => row.request_id === params.request_id)
        const peer = peers.find(peer => peer.peer_id === requests[index]?.sender_id)
        if (peer) { peer.is_friend = Boolean(params.accept); delete peer.friend_request }
        if (index >= 0) requests.splice(index, 1)
        emit(); return {}
      }
      case "friend_send":
      case "unfriend":
      case "block_peer":
      case "unblock_peer": {
        const peer = peers.find(peer => peer.peer_id === params.peer_id)
        if (peer) {
          if (action === "friend_send") peer.friend_request = "outgoing"
          if (action === "unfriend") peer.is_friend = false
          if (action === "block_peer") { peer.is_blocked = true; if (!blocked.some(row => row.peer_id === peer.peer_id)) blocked.push({ ...peer }) }
          if (action === "unblock_peer") { peer.is_blocked = false; const index = blocked.findIndex(row => row.peer_id === peer.peer_id); if (index >= 0) blocked.splice(index, 1) }
        }
        emit(); return {}
      }
      case "delete_message": for (const rows of Object.values(messages)) { const index = rows.findIndex(row => row.message_id === params.message_id); if (index >= 0) rows.splice(index, 1) }; emit(); return {}
      case "debug_info": return { demo: true, connection: { mode: control.url ? "local_and_remote" : "local_only", public_endpoint: control.public_endpoint }, peers: peers.length }
      case "debug_re_stun": return {}
      default: throw new Error(`The ${action} action is not available in the design demo.`)
    }
  }

  return {
    listen(event: string, handler: (payload: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
      return () => { listeners.get(event)?.delete(handler) }
    },
    async invoke(command: string, args: Row = {}) {
      if (command === "request") return request(args.action, args.params ?? {})
      if (command === "preferences") { if (args.closeMode) preferences.close_mode = args.closeMode; if (args.autostart !== undefined) preferences.autostart = args.autostart; if (args.updateChannel) preferences.update_channel = args.updateChannel; return { ...preferences } }
      if (command === "updater_available") return false
      if (command === "check_update") return { available: false }
      if (["connect_backend", "unread_badge", "notify", "discard_attachments"].includes(command)) return {}
      throw new Error("This is a sample-data demo. Native desktop actions are unavailable.")
    },
  }
}
