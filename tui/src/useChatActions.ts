import type { IPCClient } from "../../common/ipc-client"
import type { Release } from "../../common/updater"
import { checkForUpdate, GitHubAuthenticationError, installRelease, isReleaseInstallDir, releaseInstallDir, requestUpdateRestart, saveGithubToken, UPDATE_RESTART_EXIT_CODE } from "../../common/updater"
import type { AdvancedConfig, BlockedPeer, ControlStatus, DebugInfo, Dialog, FileTransfer, FriendRequest, Group, GroupDelivery, GroupMember, Message, Peer, RoomStatus } from "./types"
import type { NotificationDelivery, NotificationEvent, NotificationPreferences } from "./notifications"
import { resolve } from "path"
import { existsSync, statSync } from "fs"
import { groupFromResponse } from "./utils"
import { runCommand as navigationRunCommand } from "./navigation"
import { sendTestNotification } from "./notifications"
import { DEFAULT_STATUS, groupDeliveryLabel, MAX_MESSAGE_BYTES, MIN_COMPOSER_HEIGHT } from "./utils"
import { goBack as navigateBack } from "./navigation"

declare const APP_VERSION: string
declare const MESHTALK_RELEASE: boolean

const PUBLIC_CONTROL_URL = "wss://meshtalk-control.qincai.xyz/v1/rendezvous"

type ChatActionsDeps = {
  ipc: IPCClient
  clipboardRef: { current: any }
  renderer: any
  backendDisconnectedRef: { current: boolean }

  peers: Peer[]
  setPeers: React.Dispatch<React.SetStateAction<Peer[]>>
  groups: Group[]
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>
  groupMembers: Record<string, GroupMember[]>
  setGroupMembers: React.Dispatch<React.SetStateAction<Record<string, GroupMember[]>>>
  identity: { peer_id: string; display_name: string } | undefined
  setIdentity: React.Dispatch<React.SetStateAction<{ peer_id: string; display_name: string } | undefined>>
  selection: { kind: "peer" | "group"; id: string } | undefined
  setSelection: React.Dispatch<React.SetStateAction<{ kind: "peer" | "group"; id: string } | undefined>>
  selectedPeerId: string | undefined
  selectedGroupId: string | undefined
  messages: Message[]
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  drafts: Record<string, string>
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  draftLength: number
  setDraftLength: (n: number) => void
  composerHeight: number
  setComposerHeight: (n: number) => void
  isSending: boolean
  setIsSending: (b: boolean) => void
  nameDraft: string
  setNameDraft: (s: string) => void
  editingName: boolean
  setEditingName: (b: boolean) => void
  scrollFocused: boolean
  setScrollFocused: (b: boolean) => void
  deliveredMessageIds: Set<string>
  setDeliveredMessageIds: React.Dispatch<React.SetStateAction<Set<string>>>
  status: string
  setStatus: (s: string) => void
  copyToast: boolean
  setCopyToast: (b: boolean) => void
  mutedPeers: Record<string, number>
  setMutedPeers: React.Dispatch<React.SetStateAction<Record<string, number>>>
  notificationPreferences: NotificationPreferences | null
  setNotificationPreferences: React.Dispatch<React.SetStateAction<NotificationPreferences | null>>
  notificationTestDelivery: Exclude<NotificationDelivery, "disabled"> | null
  setNotificationTestDelivery: React.Dispatch<React.SetStateAction<Exclude<NotificationDelivery, "disabled"> | null>>
  flashingEnabled: boolean
  setFlashingEnabled: (b: boolean) => void
  controlStatus: { connected: boolean; reconnect_attempts: number; control_url?: string | null }
  setControlStatus: React.Dispatch<React.SetStateAction<{ connected: boolean; reconnect_attempts: number; control_url?: string | null }>>
  debugInfo: DebugInfo | null
  setDebugInfo: React.Dispatch<React.SetStateAction<DebugInfo | null>>
  fileTransfers: FileTransfer[]
  setFileTransfers: React.Dispatch<React.SetStateAction<FileTransfer[]>>
  dialog: Dialog | null
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>
  setDialogDraft: (s: string) => void
  setDialogError: (s: string) => void
  setDialogBusy: (b: boolean) => void

  statusResetRef: { current: ReturnType<typeof setTimeout> | undefined }
  copyToastResetRef: { current: ReturnType<typeof setTimeout> | undefined }
  dialogActionRef: { current: number }
  dialogBusyRef: { current: boolean }
  filePickerOpenRef: { current: boolean }
  composerRef: { current: { plainText: string; selectAll: () => void; deleteSelection: () => void } | null }
  selectionKey: string | undefined
}

export function useChatActions(deps: ChatActionsDeps) {
  const { ipc, clipboardRef, renderer, backendDisconnectedRef } = deps
  const { peers, setPeers, groups, setGroups, groupMembers, setGroupMembers, identity, setIdentity } = deps
  const { selection, setSelection, selectedPeerId, selectedGroupId, messages, setMessages, drafts, setDrafts } = deps
  const { draftLength, setDraftLength, composerHeight, setComposerHeight, isSending, setIsSending } = deps
  const { nameDraft, setNameDraft, editingName, setEditingName, scrollFocused, setScrollFocused } = deps
  const { deliveredMessageIds, setDeliveredMessageIds, status, setStatus, copyToast, setCopyToast } = deps
  const { mutedPeers, setMutedPeers, notificationPreferences, setNotificationPreferences } = deps
  const { notificationTestDelivery, setNotificationTestDelivery } = deps
  const { flashingEnabled, setFlashingEnabled, controlStatus, setControlStatus } = deps
  const { debugInfo, setDebugInfo, fileTransfers, setFileTransfers } = deps
  const { dialog, setDialog, setDialogDraft, setDialogError, setDialogBusy } = deps
  const { statusResetRef, copyToastResetRef, dialogActionRef, dialogBusyRef, filePickerOpenRef, composerRef, selectionKey } = deps

  function showStatus(message: string) {
    if (statusResetRef.current) clearTimeout(statusResetRef.current)
    setStatus(message)
    statusResetRef.current = setTimeout(() => setStatus(DEFAULT_STATUS), 2_000)
  }

  function showCopyToast() {
    if (copyToastResetRef.current) clearTimeout(copyToastResetRef.current)
    setCopyToast(true)
    copyToastResetRef.current = setTimeout(() => setCopyToast(false), 2_000)
  }

  async function refreshPeers() {
    const response = await ipc.send("peers")
    if (response.error) throw new Error(response.error)
    const next = (response.peers as Peer[]).sort((a, b) => b.is_online - a.is_online || a.display_name.localeCompare(b.display_name))
    setPeers(next)
    setSelection((current) => current && (current.kind === "group" || next.some((p) => p.peer_id === current.id))
      ? current
      : next[0] ? { kind: "peer", id: next[0].peer_id } : groups[0] ? { kind: "group", id: groups[0].group_id } : undefined)
  }

  async function refreshGroups() {
    const response = await ipc.send("groups")
    if (response.error) throw new Error(response.error)
    const next = (response.groups as Group[]).sort((a, b) => a.name.localeCompare(b.name))
    setGroups(next)
    setSelection((current) => {
      if (!current) return peers[0] ? { kind: "peer", id: peers[0].peer_id } : next[0] ? { kind: "group", id: next[0].group_id } : undefined
      if (current?.kind !== "group" || next.some((g) => g.group_id === current.id)) return current
      return peers[0] ? { kind: "peer", id: peers[0].peer_id } : next[0] ? { kind: "group", id: next[0].group_id } : undefined
    })
  }

  async function refreshGroupMembers(groupId: string | undefined = selectedGroupId) {
    if (!groupId) return
    const response = await ipc.send("group_members", { group_id: groupId })
    if (response.error) throw new Error(response.error)
    setGroupMembers((current) => ({ ...current, [groupId]: response.members as GroupMember[] }))
  }

  async function refreshFiles() {
    try {
      const response = await ipc.send("files")
      if (!response.error) setFileTransfers(response.files as FileTransfer[])
    } catch {}
  }

  function closeDialog() {
    dialogActionRef.current++
    dialogBusyRef.current = false
    setDialog(null)
    setDialogDraft("")
    setDialogError("")
    setDialogBusy(false)
  }

  function showDialog(next: Dialog) {
    dialogActionRef.current++
    dialogBusyRef.current = false
    setDialog(next)
    setDialogDraft("")
    setDialogError("")
    setDialogBusy(false)
  }

  function beginDialogAction(): number | null {
    if (dialogBusyRef.current) return null
    dialogBusyRef.current = true
    const action = ++dialogActionRef.current
    setDialogBusy(true)
    setDialogError("")
    return action
  }

  function finishDialogAction(action: number) {
    if (dialogActionRef.current !== action) return
    dialogBusyRef.current = false
    setDialogBusy(false)
  }

  function failDialogAction(action: number, error: unknown) {
    if (dialogActionRef.current !== action) return
    setDialogError(error instanceof Error ? error.message : String(error))
    finishDialogAction(action)
  }

  function goBack() {
    navigateBack({
      dialog,
      selection,
      fileTransfers,
      closeDialog,
      showDialog,
      loadAdvancedConfig,
      loadRooms,
      loadFriendRequests,
      loadBlockedPeers,
    })
  }

  async function installUpdate(release: Release, destination?: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const installDir = destination?.trim() ? resolve(destination.trim()) : releaseInstallDir()
      if (!installDir) throw new Error("Unable to locate the standalone MeshTalk installation.")
      if (!isReleaseInstallDir(installDir)) throw new Error("Update directory must contain the current MeshTalk release binaries.")
      await installRelease(release, installDir, (progress) => {
        if (dialogActionRef.current === action) setDialog((current) => current?.kind === "update" ? { ...current, progress } : current)
      })
      if (dialogActionRef.current !== action) return
      setDialog({ kind: "update", release, installed: true, installDir })
      showStatus(`MeshTalk ${release.version} is ready. Restart to use the update.`)
    } catch (error) {
      if (error instanceof GitHubAuthenticationError && dialogActionRef.current === action) {
        setDialog({ kind: "update-token", release, destination })
        setDialogError("")
      } else failDialogAction(action, error)
    } finally {
      finishDialogAction(action)
    }
  }

  function saveUpdateToken(release: Release | undefined, destination: string | undefined, token: string) {
    if (!token.trim()) {
      setDialogError("Enter a GitHub token to continue.")
      return
    }
    saveGithubToken(token.trim())
    if (release) {
      setDialog({ kind: "update", release, progress: { current: 1, total: 6, step: "Retrying authenticated download" } })
      void installUpdate(release, destination)
    } else void checkForUpdatesFromAbout()
  }

  function restartUpdate(installDir: string) {
    requestUpdateRestart(installDir)
    renderer.destroy()
    process.exit(UPDATE_RESTART_EXIT_CODE)
  }

  async function checkForUpdatesFromAbout() {
    const IS_RELEASE_BUILD = typeof MESHTALK_RELEASE !== "undefined" && MESHTALK_RELEASE
    const APP_RELEASE_VERSION = typeof APP_VERSION !== "undefined" && APP_VERSION ? APP_VERSION : "dev"
    if (!IS_RELEASE_BUILD) { setDialog({ kind: "about", checked: true }); return }
    const action = beginDialogAction()
    if (action === null) return
    setDialog({ kind: "about", checking: true })
    try {
      const release = await checkForUpdate(APP_RELEASE_VERSION)
      if (dialogActionRef.current !== action) return
      setDialog(release ? { kind: "update", release } : { kind: "about", checked: true })
    } catch (error) {
      if (error instanceof GitHubAuthenticationError && dialogActionRef.current === action) {
        setDialog({ kind: "update-token" })
        setDialogError("")
      } else failDialogAction(action, error)
    }
    finally { finishDialogAction(action) }
  }

  async function loadControlStatus() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("control")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "control-status", control: response as ControlStatus })
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function loadRooms() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("rooms")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "rooms", rooms: response.rooms as RoomStatus[] })
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function configureControl(url: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("control", { url })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus(`Control server set to ${response.url}.`)
      showDialog({ kind: "control-status", control: response as ControlStatus })
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function dismissControlSetup() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("control", { dismiss_setup: true })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current === action) closeDialog()
    } catch (error) { failDialogAction(action, error) }
  }

  async function loadAdvancedConfig() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("advanced_config")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "advanced", config: response as AdvancedConfig })
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function saveAdvancedConfig(params: Record<string, unknown>, message: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("advanced_config", params)
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "advanced", config: response as AdvancedConfig })
      showStatus(message)
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function createRoom(name: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_create", { name: name.trim() })
      if (response.error) throw new Error(response.error)
      const invite = response.invite as string
      let copied = false
      try { const result = await clipboardRef.current?.writeText(invite, { destination: "best-available" }); copied = result?.host.status === "written" || result?.terminal.status === "attempted" } catch {}
      if (dialogActionRef.current !== action) return
      const group = groupFromResponse(response)
      const groupId = group?.group_id ?? response.room_id as string
      showDialog({ kind: "room-created", roomId: groupId, invite, copied, created: true })
      if (group) { setGroups((c) => [...c.filter((i) => i.group_id !== group.group_id), group].sort((a, b) => a.name.localeCompare(b.name))); setSelection({ kind: "group", id: group.group_id }) }
      else void refreshGroups()
      showStatus(`Group ${group?.name ?? name.trim()} created.`)
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function joinRoom(invite: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_join", { invite: invite.trim() })
      if (response.error) throw new Error(response.error)
      const rooms = await ipc.send("rooms")
      if (rooms.error) throw new Error(rooms.error)
      if (dialogActionRef.current !== action) return
      const group = groupFromResponse(response)
      showStatus(`Joined room ${(group?.group_id ?? response.room_id as string).slice(0, 12)}.`)
      showDialog({ kind: "rooms", rooms: rooms.rooms as RoomStatus[] })
      if (group) { setGroups((c) => [...c.filter((i) => i.group_id !== group.group_id), group].sort((a, b) => a.name.localeCompare(b.name))); setSelection({ kind: "group", id: group.group_id }); showStatus(`Joined ${group.name}.`) }
      else void refreshGroups()
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function leaveRoom(roomId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_leave", { room_id: roomId })
      if (response.error) throw new Error(response.error)
      const rooms = await ipc.send("rooms")
      if (rooms.error) throw new Error(rooms.error)
      if (dialogActionRef.current !== action) return
      showStatus(`Left room ${roomId.slice(0, 12)}.`)
      showDialog({ kind: "rooms", rooms: rooms.rooms as RoomStatus[] })
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function loadRoomInvite(roomId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("room_invite", { room_id: roomId })
      if (response.error) throw new Error(response.error)
      const invite = response.invite as string
      let copied = false
      try { const result = await clipboardRef.current?.writeText(invite, { destination: "best-available" }); copied = result?.host.status === "written" || result?.terminal.status === "attempted" } catch {}
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "room-created", roomId, invite, copied })
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function loadGroupDetails(group: Group) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("group_members", { group_id: group.group_id })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      const members = response.members as GroupMember[]
      setGroupMembers((c) => ({ ...c, [group.group_id]: members }))
      showDialog({ kind: "group-detail", group, members })
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function leaveGroup(group: Group) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("group_leave", { group_id: group.group_id })
      if (response.error) throw new Error(response.error)
      const remaining = groups.filter((i) => i.group_id !== group.group_id)
      setGroups(remaining)
      if (selectedGroupId === group.group_id) setSelection(peers[0] ? { kind: "peer", id: peers[0].peer_id } : remaining[0] ? { kind: "group", id: remaining[0].group_id } : undefined)
      showStatus(`Left ${group.name}.`)
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function copyInvite(invite: string) {
    try {
      const result = await clipboardRef.current?.writeText(invite, { destination: "best-available" })
      if (result?.host.status !== "written" && result?.terminal.status !== "attempted") throw new Error("No clipboard is available. Select and copy the invite text manually.")
      setDialog((c) => c?.kind === "room-created" ? { ...c, copied: true } : c)
      showCopyToast()
    } catch (error) { setDialogError(error instanceof Error ? error.message : String(error)) }
  }

  async function mutePeer(peerId: string, timeout: number) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("mute", { peer_id: peerId, timeout })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      const mutedResp = await ipc.send("muted_peers")
      if (!mutedResp.error) setMutedPeers(mutedResp.muted_peers as Record<string, number>)
      const until = response.until as number
      const label = until <= 0 ? "permanently" : `until ${new Date(until * 1000).toLocaleTimeString()}`
      const peer = peers.find((p) => p.peer_id === peerId)
      showStatus(`Muted ${peer?.display_name ?? peerId} ${label}.`)
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function unmutePeer(peerId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("unmute", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      const mutedResp = await ipc.send("muted_peers")
      if (!mutedResp.error) setMutedPeers(mutedResp.muted_peers as Record<string, number>)
      const peer = peers.find((p) => p.peer_id === peerId)
      showStatus(`Unmuted ${peer?.display_name ?? peerId}.`)
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function loadFriendRequests() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_requests")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "friend-requests", requests: response.requests as FriendRequest[] })
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function sendFriendRequest(peerId: string, note: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_send", { peer_id: peerId, note })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus("Friend request sent. You can chat once they accept.")
      await refreshPeers()
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function respondToFriendRequest(request: FriendRequest, accept: boolean) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_respond", { request_id: request.request_id, accept })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus(accept ? `You and ${request.sender_name} are now friends.` : `Declined ${request.sender_name}'s friend request.`)
      await refreshPeers()
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function cancelFriendRequest(requestId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("friend_cancel", { request_id: requestId })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus("Friend request cancelled.")
      await refreshPeers()
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function unfriendPeer(peerId: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("unfriend", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      const peer = peers.find((p) => p.peer_id === peerId)
      showStatus(`Removed ${peer?.display_name ?? peerId} as a friend.`)
      await refreshPeers()
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function loadBlockedPeers() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("blocked_peers")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "blocked", blocked: response.blocked as BlockedPeer[] })
    } catch (error) { failDialogAction(action, error); return }
    finally { finishDialogAction(action) }
  }

  async function blockPeer(peerId: string, displayName: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("block_peer", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus(`Blocked ${displayName}. Their friend requests are now ignored.`)
      await refreshPeers()
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function unblockPeer(peerId: string, displayName: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("unblock_peer", { peer_id: peerId })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus(`Unblocked ${displayName}. They can send friend requests again.`)
      await refreshPeers()
      finishDialogAction(action)
      void loadBlockedPeers()
    } catch (error) { failDialogAction(action, error) }
  }

  async function blockSenderFromRequest(request: FriendRequest) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("block_peer", { peer_id: request.sender_id })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus(`Blocked ${request.sender_name}. Their friend requests are now ignored.`)
      await refreshPeers()
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function reStun() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("debug_re_stun")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      const endpoint = response.public_endpoint as [string, number] | null
      showStatus(endpoint ? `STUN complete. Endpoint: ${endpoint[0]}:${endpoint[1]}` : "STUN failed. No public endpoint discovered.")
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function loadDebugInfo() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("debug_info")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      setDebugInfo(response as unknown as DebugInfo)
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function loadFiles() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("files")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      const files = response.files as FileTransfer[]
      setFileTransfers(files)
      showDialog({ kind: "file-list", files })
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function sendFile(filePath: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const trimmed = filePath.trim()
      if (!trimmed) throw new Error("File path is empty")
      const home = process.env.HOME || process.env.USERPROFILE || ""
      const expanded = home && (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) ? home + trimmed.slice(1) : trimmed
      const absolutePath = resolve(expanded)
      if (selection?.kind === "peer") {
        const response = await ipc.send("file_send", { recipient_id: selection.id, file_path: absolutePath })
        if (response.error) throw new Error(response.error)
        showStatus(`File transfer started: ${absolutePath} -> ${selection.id.slice(0, 8)}`)
      } else if (selection?.kind === "group") {
        const response = await ipc.send("group_file_send", { group_id: selection.id, file_path: absolutePath })
        if (response.error) throw new Error(response.error)
        showStatus(`Group file transfer started: ${absolutePath}`)
      } else { throw new Error("Select a peer or group first") }
      if (dialogActionRef.current !== action) return
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function openFilePicker() {
    if (filePickerOpenRef.current) return
    if (!selection) { showStatus("Select a peer or group before sending a file."); return }
    if (process.platform === "linux" && !Bun.which("zenity")) { showStatus("No native file picker found. Enter a path in the upload screen."); showDialog({ kind: "file-send" }); return }
    filePickerOpenRef.current = true
    try {
      const command = process.platform === "darwin"
        ? ["osascript", "-e", 'POSIX path of (choose file with prompt "Select a file to send")']
        : process.platform === "win32"
          ? ["powershell.exe", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }"]
          : ["zenity", "--file-selection", "--title=Select a file to send"]
      const pickerProcess = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const [exitCode, output] = await Promise.all([pickerProcess.exited, new Response(pickerProcess.stdout).text()])
      const filePath = output.trim()
      if (exitCode === 0 && filePath) await sendFile(filePath)
    } catch (error) { showStatus(`Could not open file picker: ${error instanceof Error ? error.message : String(error)}`) }
    finally { filePickerOpenRef.current = false }
  }

  function defaultDownloadPath(filename: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || ""
    const dl = home ? `${home}/Downloads/${filename}` : filename
    return dl.replace(/\\/g, "/")
  }

  async function downloadFile(fileId: string, destPath: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const trimmed = destPath.trim()
      if (!trimmed) throw new Error("Destination path required")
      const response = await ipc.send("file_download", { file_id: fileId, dest_path: trimmed })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus(`Saved ${response.dest_path as string}`)
      closeDialog()
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function loadFilesDir() {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("files_dir")
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "files-dir", filesDir: response.files_dir as string, env: response.env as string | undefined, configured: response.configured as string | undefined, dataDir: response.data_dir as string | undefined })
      setDialogDraft(response.files_dir as string)
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function setFilesDir(path: string) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const trimmed = path.trim()
      if (!trimmed) throw new Error("Path required")
      const response = await ipc.send("files_dir", { path: trimmed })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      showStatus(`Files storage set to ${response.files_dir as string}. New files will go there.`)
      showDialog({ kind: "files-dir", filesDir: response.files_dir as string, env: response.env as string | undefined, configured: response.configured as string | undefined, dataDir: response.data_dir as string | undefined })
      setDialogDraft(response.files_dir as string)
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function saveDisplayName(value?: string) {
    const v = value ?? nameDraft
    const action = dialog?.kind === "rename" ? beginDialogAction() : undefined
    if (action === null) return
    try {
      const response = await ipc.send("set_display_name", { display_name: v })
      if (response.error) throw new Error(response.error)
      if (action !== undefined && dialogActionRef.current !== action) return
      const displayName = response.display_name as string
      setIdentity((c) => c ? { ...c, display_name: displayName } : c)
      setNameDraft(displayName)
      setEditingName(false)
      if (action !== undefined && dialog?.kind === "rename" && dialog.firstRun) {
        const control = await ipc.send("control")
        if (control.error) throw new Error(control.error)
        if (dialogActionRef.current !== action) return
        if (control.url) showDialog({ kind: "control-status", control: control as ControlStatus })
        else if (!control.setup_dismissed) showDialog({ kind: "control", firstRun: true })
        else closeDialog()
      } else if (action !== undefined) closeDialog()
      showStatus("Display name updated and shared with connected peers.")
    } catch (error) {
      if (!backendDisconnectedRef.current) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`Name error: ${message}`)
        if (action !== undefined) failDialogAction(action, error)
      }
    } finally { if (action !== undefined) finishDialogAction(action) }
  }

  async function setAccessibilityFlashing(enabled: boolean) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      const response = await ipc.send("accessibility", { flashing_enabled: enabled })
      if (response.error) throw new Error(response.error)
      if (dialogActionRef.current !== action) return
      setFlashingEnabled(response.flashing_enabled as boolean)
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  function notificationEventEnabled(event: NotificationEvent): boolean {
    return Boolean(notificationPreferences?.events[event])
  }

  async function saveNotificationPreferences(changes: { setup_dismissed?: boolean; delivery?: NotificationDelivery; events?: Partial<Record<NotificationEvent, boolean>> }) {
    const response = await ipc.send("notifications", changes)
    if (response.error) throw new Error(response.error)
    setNotificationPreferences(response as NotificationPreferences)
    return response as NotificationPreferences
  }

  async function testNotificationDelivery(delivery: Exclude<NotificationDelivery, "disabled">, firstRun = false) {
    const action = beginDialogAction()
    if (action === null) return
    setNotificationTestDelivery(delivery)
    try {
      const sent = await sendTestNotification(delivery, renderer)
      if (dialogActionRef.current !== action) return
      if (sent) showDialog({ kind: "notification-confirm", delivery, firstRun })
      else if (delivery === "terminal") showDialog({ kind: "notification-fallback", firstRun })
      else throw new Error("Could not start a native notification. Check that desktop notifications are available.")
    } catch (error) { failDialogAction(action, error) }
    finally { setNotificationTestDelivery(null); finishDialogAction(action) }
  }

  async function confirmNotificationDelivery(delivery: Exclude<NotificationDelivery, "disabled">, firstRun = false) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      await saveNotificationPreferences({ setup_dismissed: true, delivery })
      if (dialogActionRef.current !== action) return
      showStatus(`Desktop notifications will use ${delivery === "terminal" ? "your terminal" : "your operating system"}.`)
      if (firstRun) closeDialog(); else showDialog({ kind: "notifications" })
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function disableNotifications(firstRun = false) {
    const action = beginDialogAction()
    if (action === null) return
    try {
      await saveNotificationPreferences({ setup_dismissed: true, delivery: "disabled" })
      if (dialogActionRef.current !== action) return
      if (firstRun) closeDialog(); else showDialog({ kind: "notifications" })
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function toggleNotificationEvent(event: NotificationEvent) {
    if (!notificationPreferences) return
    const action = beginDialogAction()
    if (action === null) return
    try {
      await saveNotificationPreferences({ events: { [event]: !notificationEventEnabled(event) } })
      if (dialogActionRef.current !== action) return
      showDialog({ kind: "notifications" })
    } catch (error) { failDialogAction(action, error) }
    finally { finishDialogAction(action) }
  }

  async function removeSelectedPeer() {
    const peer = peers.find((item) => item.peer_id === selectedPeerId)
    if (!peer) return
    if (peer.is_online) { showStatus("Disconnect from this peer before removing it."); return }
    try {
      const response = await ipc.send("remove_peer", { peer_id: peer.peer_id })
      if (response.error) throw new Error(response.error)
      const remaining = peers.filter((item) => item.peer_id !== peer.peer_id)
      setPeers(remaining)
      setSelection(remaining[0] ? { kind: "peer", id: remaining[0].peer_id } : groups[0] ? { kind: "group", id: groups[0].group_id } : undefined)
      showStatus(`Removed ${peer.display_name} from the peer list.`)
    } catch (error) { if (!backendDisconnectedRef.current) setStatus(`Remove error: ${error instanceof Error ? error.message : String(error)}`) }
  }

  async function send() {
    const composer = composerRef.current
    const content = composer?.plainText.trim() ?? ""
    if (!content) { showStatus("Message is empty."); return }
    if (!selection || !selectionKey || !identity) { showStatus("Select a peer or group before sending."); return }
    if (new TextEncoder().encode(content).length > MAX_MESSAGE_BYTES) { showStatus("Message exceeds the 30 KiB limit."); return }
    setIsSending(true)
    try {
      const response = selection.kind === "peer"
        ? await ipc.send("send", { recipient_id: selection.id, content })
        : await ipc.send("group_send", { group_id: selection.id, content })
      if (response.error) throw new Error(response.error)
      const queued = Boolean(response.queued)
      setMessages((c) => [...c, {
        message_id: response.message_id as string, sender_id: identity.peer_id,
        ...(selection.kind === "peer" ? { recipient_id: selection.id } : { group_id: selection.id, deliveries: response.deliveries as GroupDelivery[] }),
        content, created_at: Date.now() / 1000, delivered: 0, queued: queued ? 1 : 0,
      }])
      if (composer && composer === composerRef.current) { composer.selectAll(); composer.deleteSelection() }
      setDrafts((c) => ({ ...c, [selectionKey]: "" }))
      setDraftLength(0)
      setComposerHeight(MIN_COMPOSER_HEIGHT)
      showStatus(selection.kind === "group" ? `Group message sent: ${groupDeliveryLabel(response.deliveries as GroupDelivery[])}.`
        : queued ? "Message stored and queued. It will send when the peer is online."
          : "Message sent. Waiting for delivery confirmation.")
    } catch (error) {
      if (!backendDisconnectedRef.current) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes("No known public key")) showStatus(`You must connect to ${peers.find((p) => p.peer_id === selection.id)?.display_name ?? "this peer"} at least once before offline messages can be queued.`)
        else setStatus(`Send error: ${msg}`)
      }
    } finally { setIsSending(false) }
  }

  function runCommand(command: string) {
    navigationRunCommand(command, {
      groups, groupMembers, identity, mutedPeers, peers, selectedGroupId, selectedPeerId, selection,
      showDialog, showStatus, setDialogDraft, setDialogError, setNameDraft,
      setRenameDialog: () => showDialog({ kind: "rename" }),
      loadAdvancedConfig, loadDebugInfo, loadFiles, loadFriendRequests, loadGroupDetails, loadRooms,
    })
  }

  return {
    showStatus, showCopyToast,
    refreshPeers, refreshGroups, refreshGroupMembers, refreshFiles,
    closeDialog, showDialog, goBack,
    installUpdate, saveUpdateToken, restartUpdate, checkForUpdatesFromAbout,
    loadControlStatus, configureControl, dismissControlSetup,
    loadAdvancedConfig, saveAdvancedConfig,
    loadRooms, createRoom, joinRoom, leaveRoom, loadRoomInvite,
    loadGroupDetails, leaveGroup, copyInvite,
    mutePeer, unmutePeer,
    loadFriendRequests, sendFriendRequest, respondToFriendRequest, cancelFriendRequest, unfriendPeer,
    loadBlockedPeers, blockPeer, unblockPeer, blockSenderFromRequest,
    reStun, loadDebugInfo, loadFiles,
    sendFile, openFilePicker, defaultDownloadPath, downloadFile, loadFilesDir, setFilesDir,
    saveDisplayName, setAccessibilityFlashing,
    testNotificationDelivery, confirmNotificationDelivery, disableNotifications, toggleNotificationEvent,
    removeSelectedPeer, send, runCommand,
  }
}
