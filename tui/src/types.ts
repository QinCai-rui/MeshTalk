export type Peer = {
  peer_id: string
  display_name: string
  is_online: number
  last_seen: number
  last_interaction: number
  unread_count: number
  presence?: "active" | "away" | "offline"
  is_friend?: boolean
  is_blocked?: boolean
  friend_request?: "incoming" | "outgoing" | "both" | null
  active_transport?: "lan_tcp" | "remote_udp" | "remote_derp"
  active_endpoint?: string
  endpoints: { transport: "lan_tcp" | "remote_udp" | "remote_derp"; endpoint: string; active: boolean }[]
  delivery_warnings?: ("offline" | "not_friend" | "rendezvous_out_of_sync" | "limited")[]
  capabilities?: string[]
  remote_capabilities?: string[]
  peer_missing_capabilities?: string[]
  local_missing_capabilities?: string[]
  capability_gap?: boolean
}

export type GroupDelivery = { recipient_id: string; display_name: string; status: string; updated_at: number }
export type Message = {
  message_id: string; sender_id: string; recipient_id?: string; group_id?: string; content: string
  created_at: number; kind?: string; deliveries?: GroupDelivery[]; delivered?: number; blocked?: number
  queued?: number; failed?: number; received_at?: number; reply_to_message_id?: string | null
}
export type UnreadMessageState = { conversationKey: string; receivedAt: number; visibleAt?: number }
export type Group = { group_id: string; name: string; member_count: number; unread_count: number }
export type GroupMember = { peer_id?: string; member_id?: string; display_name: string; is_online?: boolean; show_in_sidebar?: boolean; is_limited?: boolean }
export type Conversation = { kind: "peer" | "group"; id: string }
export type TypingPeer = { displayName: string; createdAt: number; expiresAt: number; isTyping: boolean }
export type FriendRequest = { request_id: string; sender_id: string; sender_name: string; recipient_id?: string; recipient_name?: string; note?: string | null; created_at: number; direction: "incoming" | "outgoing"; status?: string }
export type BlockedPeer = { peer_id: string; display_name: string; created_at: number }
export type RoomStatus = { room_id: string; members: number; group_id?: string | null; name?: string | null }
export type ControlStatus = { url?: string; connected: boolean; setup_dismissed: boolean; stun_server: string; reconnect_attempts: number; public_endpoint?: unknown[] }
export type ImageProtocol = "auto" | "kitty" | "sixel" | "blocks"
export type SplashPreference = "card" | "boot-log" | "off"
export type AdvancedConfig = { control_url?: string | null; control_pinned_ips: string[]; stun_server: string; stun_pinned_ips: string[]; image_protocol: ImageProtocol; splash_style: SplashPreference; splash_duration_ms?: number; splash_phase_ms?: number; splash_welcome_ms?: number }
export type DebugInfo = { public_endpoint?: [string, number] | null; stun_server: string; local_tcp_port: number; rooms: RoomStatus[]; peers: Peer[] }
export type FileTransfer = { file_id: string; filename: string; file_size: number; sender_id: string; recipient_id: string; group_id?: string | null; direction: string; status: string; file_path?: string | null; created_at: number; completed_at?: number | null; received_chunks?: number; total_chunks?: number }
export type ConversationItem = { type: "message"; createdAt: number; message: Message } | { type: "file"; createdAt: number; file: FileTransfer; allFiles: FileTransfer[] }
export type ReplyTarget = { id: string; senderId: string; label: string; groupId?: string; kind: "message" | "file" }

export type Dialog =
  | { kind: "settings" } | { kind: "control"; firstRun?: boolean } | { kind: "control-custom"; firstRun?: boolean }
  | { kind: "control-status"; control: ControlStatus } | { kind: "advanced"; config: AdvancedConfig }
  | { kind: "advanced-image-protocol"; config: AdvancedConfig } | { kind: "advanced-ip-pinning"; config: AdvancedConfig } | { kind: "advanced-control"; config: AdvancedConfig } | { kind: "advanced-stun"; config: AdvancedConfig }
  | { kind: "customisation" } | { kind: "customisation-splash"; splashStyle: SplashPreference }
  | { kind: "advanced-control-ip" } | { kind: "advanced-stun-ip" } | { kind: "rooms"; rooms: RoomStatus[] }
  | { kind: "room-create" } | { kind: "room-join" } | { kind: "room-created"; roomId: string; invite: string; copied: boolean; created?: boolean }
  | { kind: "room-detail"; room: RoomStatus } | { kind: "group-detail"; group: Group; members: GroupMember[] }
  | { kind: "rename"; firstRun?: boolean } | { kind: "mute-timeout"; peerId: string; displayName: string }
  | { kind: "unmute-confirm"; peerId: string; displayName: string } | { kind: "add-friend"; peerId: string; displayName: string }
  | { kind: "remove-friend"; peerId: string; displayName: string } | { kind: "friend-requests"; requests: FriendRequest[] }
  | { kind: "friend-request-incoming"; request: FriendRequest } | { kind: "friends" } | { kind: "blocked"; blocked: BlockedPeer[] }
  | { kind: "block-peer-pick" } | { kind: "block-peer"; peerId: string; displayName: string }
  | { kind: "cancel-friend-confirm"; requestId: string; displayName: string } | { kind: "notifications" }
  | { kind: "notification-enable"; firstRun?: boolean }
  | { kind: "notification-confirm"; delivery: Exclude<import("./notifications").NotificationDelivery, "disabled">; firstRun?: boolean }
  | { kind: "notification-fallback"; firstRun?: boolean }
  | { kind: "notification-settings" } | { kind: "notification-peer" } | { kind: "accessibility" }
  | { kind: "debug" } | { kind: "debug-endpoints" } | { kind: "debug-peer"; peerId: string; displayName: string }
  | { kind: "file-send" } | { kind: "file-list"; files: FileTransfer[] } | { kind: "file-download"; fileId: string; filename: string; filePath: string }
  | { kind: "image-view"; filePath: string; filename: string; version?: number | null; returnTo?: "files" }
  | { kind: "delivery-details"; deliveries: GroupDelivery[] }
  | { kind: "files-dir"; filesDir: string; env?: string; configured?: string; dataDir?: string } | { kind: "group-file-send" }
  | { kind: "update"; release: import("../../common/updater").Release; installed?: boolean; installDir?: string; progress?: import("../../common/updater").UpdateProgress }
  | { kind: "update-directory"; release: import("../../common/updater").Release }
  | { kind: "update-token"; release?: import("../../common/updater").Release; destination?: string }
  | { kind: "about"; checking?: boolean; checked?: boolean }
