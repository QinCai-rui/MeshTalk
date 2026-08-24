import type { Conversation, Dialog, FileTransfer, Group, GroupMember, Peer } from "./types"

type NavigationDependencies = {
  dialog: Dialog | null
  selection: Conversation | undefined
  fileTransfers: FileTransfer[]
  closeDialog: () => void
  showDialog: (dialog: Dialog) => void
  loadAdvancedConfig: () => Promise<void>
  loadRooms: () => Promise<void>
  loadFriendRequests: () => Promise<void>
  loadBlockedPeers: () => Promise<void>
}

export function goBack({ dialog, selection, fileTransfers, closeDialog, showDialog, loadAdvancedConfig, loadRooms, loadFriendRequests, loadBlockedPeers }: NavigationDependencies) {
  if (!dialog || dialog.kind === "commands" || dialog.kind === "update" || (dialog.kind === "control" && dialog.firstRun) || (dialog.kind === "rename" && dialog.firstRun)) {
    closeDialog()
  } else if (dialog.kind === "control-custom") {
    showDialog({ kind: "control", firstRun: dialog.firstRun })
  } else if (dialog.kind === "control-status") {
    showDialog({ kind: "control" })
  } else if (dialog.kind === "advanced-control-ip" || dialog.kind === "advanced-stun-ip" || dialog.kind === "advanced-control" || dialog.kind === "advanced-stun") {
    void loadAdvancedConfig()
  } else if (dialog.kind === "update-directory") {
    showDialog({ kind: "update", release: dialog.release })
  } else if (dialog.kind === "advanced" || dialog.kind === "about") {
    showDialog({ kind: "commands" })
  } else if (["room-create", "room-join", "room-created", "room-detail"].includes(dialog.kind)) {
    showDialog({ kind: "rooms", rooms: [] })
    void loadRooms()
  } else if (dialog.kind === "group-detail") {
    closeDialog()
  } else if (dialog.kind === "mute-timeout" || dialog.kind === "unmute-confirm") {
    showDialog({ kind: "notifications" })
  } else if (dialog.kind === "friend-request-incoming") {
    showDialog({ kind: "friend-requests", requests: [] })
    void loadFriendRequests()
  } else if (dialog.kind === "friend-requests" || dialog.kind === "add-friend" || dialog.kind === "remove-friend") {
    showDialog({ kind: "friends" })
  } else if (dialog.kind === "friends" || dialog.kind === "notifications") {
    showDialog({ kind: "commands" })
  } else if (dialog.kind === "notification-enable" || dialog.kind === "notification-confirm" || dialog.kind === "notification-fallback") {
    if (dialog.firstRun) closeDialog()
    else showDialog({ kind: "notification-settings" })
  } else if (dialog.kind === "notification-settings" || dialog.kind === "notification-peer") {
    showDialog({ kind: "notifications" })
  } else if (dialog.kind === "blocked") {
    showDialog({ kind: "friends" })
  } else if (dialog.kind === "block-peer-pick" || dialog.kind === "block-peer") {
    showDialog({ kind: "blocked", blocked: [] })
    void loadBlockedPeers()
  } else if (dialog.kind === "cancel-friend-confirm") {
    showDialog({ kind: "friend-requests", requests: [] })
    void loadFriendRequests()
  } else if (dialog.kind === "debug-peer") {
    showDialog({ kind: "debug-endpoints" })
  } else if (dialog.kind === "debug-endpoints") {
    showDialog({ kind: "debug" })
  } else if (dialog.kind === "debug" || dialog.kind === "file-send" || dialog.kind === "group-file-send" || dialog.kind === "file-list") {
    showDialog({ kind: "commands" })
  } else if (dialog.kind === "file-download" || dialog.kind === "files-dir") {
    showDialog({ kind: "file-list", files: fileTransfers })
  } else {
    showDialog({ kind: "commands" })
  }
}

type CommandDependencies = {
  groups: Group[]
  groupMembers: Record<string, GroupMember[]>
  identity: { peer_id: string; display_name: string } | undefined
  mutedPeers: Record<string, number>
  peers: Peer[]
  selectedGroupId: string | undefined
  selectedPeerId: string | undefined
  selection: Conversation | undefined
  showDialog: (dialog: Dialog) => void
  showStatus: (message: string) => void
  setDialogDraft: (value: string) => void
  setDialogError: (value: string) => void
  setNameDraft: (value: string) => void
  setRenameDialog: () => void
  loadAdvancedConfig: () => Promise<void>
  loadDebugInfo: () => Promise<void>
  loadFiles: () => Promise<void>
  loadFriendRequests: () => Promise<void>
  loadGroupDetails: (group: Group) => Promise<void>
  loadRooms: () => Promise<void>
}

export function runCommand(command: string, dependencies: CommandDependencies) {
  const { groups, groupMembers, identity, mutedPeers, peers, selectedGroupId, selectedPeerId, selection, showDialog, showStatus, setDialogDraft, setDialogError, setNameDraft, setRenameDialog, loadAdvancedConfig, loadDebugInfo, loadFiles, loadFriendRequests, loadGroupDetails, loadRooms } = dependencies
  if (command === "control") showDialog({ kind: "control" })
  else if (command === "rooms") { showDialog({ kind: "rooms", rooms: [] }); void loadRooms() }
  else if (command === "group-details") {
    const group = groups.find((item) => item.group_id === selectedGroupId)
    if (!group) { showStatus("Select a group first."); return }
    showDialog({ kind: "group-detail", group, members: groupMembers[group.group_id] ?? [] })
    void loadGroupDetails(group)
  } else if (command === "friends") showDialog({ kind: "friends" })
  else if (command === "notifications") showDialog({ kind: "notifications" })
  else if (command === "accessibility") showDialog({ kind: "accessibility" })
  else if (command === "advanced") void loadAdvancedConfig()
  else if (command === "rename") { const displayName = identity?.display_name ?? ""; setNameDraft(displayName); setDialogDraft(displayName); setDialogError(""); setRenameDialog() }
  else if (command === "mute" || command === "unmute") {
    const peer = peers.find((peer) => peer.peer_id === selectedPeerId)
    if (!peer) { showStatus(`Select a peer to ${command}.`); return }
    if (command === "mute" && peer.peer_id === identity?.peer_id) { showStatus("You cannot mute yourself."); return }
    if (command === "mute" && !peer.is_online) { showStatus(`${peer.display_name} is not online.`); return }
    if (command === "mute" && mutedPeers[peer.peer_id]) { showStatus(`${peer.display_name} is already muted.`); return }
    if (command === "unmute" && !mutedPeers[peer.peer_id]) { showStatus(`${peer.display_name} is not muted.`); return }
    showDialog(command === "mute" ? { kind: "mute-timeout", peerId: peer.peer_id, displayName: peer.display_name } : { kind: "unmute-confirm", peerId: peer.peer_id, displayName: peer.display_name })
  } else if (command === "add-friend" || command === "remove-friend") {
    const peer = peers.find((peer) => peer.peer_id === selectedPeerId)
    if (!peer) { showStatus(command === "add-friend" ? "Select a peer to add as a friend." : "Select a friend to remove."); return }
    if (command === "add-friend" && peer.is_friend) { showStatus(`${peer.display_name} is already your friend.`); return }
    if (command === "add-friend" && peer.is_blocked) { showStatus(`${peer.display_name} is blocked. Unblock them in Commands > Friends > Block.`); return }
    if (command === "add-friend" && (peer.friend_request === "outgoing" || peer.friend_request === "both")) { showStatus(`Friend request to ${peer.display_name} is already pending.`); return }
    if (command === "remove-friend" && !peer.is_friend) { showStatus(`${peer.display_name} is not your friend.`); return }
    if (command === "add-friend") setDialogDraft("")
    showDialog(command === "add-friend" ? { kind: "add-friend", peerId: peer.peer_id, displayName: peer.display_name } : { kind: "remove-friend", peerId: peer.peer_id, displayName: peer.display_name })
  } else if (command === "friend-requests") void loadFriendRequests()
  else if (command === "debug") { showDialog({ kind: "debug" }); void loadDebugInfo() }
  else if (command === "send-file") { if (!selection) { showStatus("Select a peer or group before sending a file."); return }; showDialog({ kind: "file-send" }) }
  else if (command === "files") { showDialog({ kind: "file-list", files: [] }); void loadFiles() }
  else if (command === "about") showDialog({ kind: "about" })
}
