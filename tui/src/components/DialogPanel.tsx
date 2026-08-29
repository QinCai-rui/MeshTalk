import type { Dialog, AdvancedConfig, BlockedPeer, ControlStatus, DebugInfo, FileTransfer, FriendRequest, Group, GroupDelivery, ImageProtocol, RoomStatus } from "../types"
import type { NotificationDelivery, NotificationEvent, NotificationPreferences } from "../notifications"
import type { GroupMember, Peer } from "../types"
import type { Release } from "../../../common/updater"
import { MouseSelect } from "./MouseSelect"
import { MarqueeText } from "./MarqueeText"
import { NotificationDialogs } from "./dialogs/NotificationDialogs"
import { AboutDialog, CommandsDialog, UpdateDestinationDialog, UpdateDialog, UpdateTokenDialog } from "./dialogs/CommandDialogs"
import { isImageFile, peerPresence } from "../utils"
import { ImageAttachment, isLocalFileMissing } from "./ImageAttachment"

const PUBLIC_CONTROL_URL = "wss://meshtalk-control.qincai.xyz/v1/rendezvous"

type DialogPanelProps = {
  dialog: Dialog
  dialogBusy: boolean
  dialogError: string
  dialogHeight: number
  dialogWidth: number
  dialogDraft: string
  controlStatus: { connected: boolean; reconnect_attempts: number; control_url?: string | null }
  debugInfo: DebugInfo | null
  flashingEnabled: boolean
  imageProtocol: ImageProtocol
  groups: Group[]
  identity: { peer_id: string; display_name: string } | undefined
  mutedPeers: Record<string, number>
  notificationPreferences: NotificationPreferences | null
  notificationTestDelivery: Exclude<NotificationDelivery, "disabled"> | null
  peers: Peer[]
  selected: Peer | undefined
  selectedGroupId: string | undefined
  selection: { kind: "peer" | "group"; id: string } | undefined
  dialogWidthFor: (kind: Dialog["kind"]) => number
  appReleaseVersion: string
  isReleaseBuild: boolean

  runCommand: (command: string) => void
  showDialog: (dialog: Dialog) => void
  closeDialog: () => void
  goBack: () => void
  setDialogDraft: (value: string) => void
  setDialogError: (value: string) => void
  setNameDraft: (value: string) => void

  configureControl: (url: string) => void
  dismissControlSetup: () => void
  loadControlStatus: () => void
  saveAdvancedConfig: (params: Record<string, unknown>, message: string) => void
  setAccessibilityFlashing: (enabled: boolean) => void

  createRoom: (name: string) => void
  joinRoom: (invite: string) => void
  leaveRoom: (roomId: string) => void
  loadRoomInvite: (roomId: string) => void
  loadRooms: () => void
  copyInvite: (invite: string) => void
  leaveGroup: (group: Group) => void
  loadGroupDetails: (group: Group) => void

  mutePeer: (peerId: string, timeout: number) => void
  unmutePeer: (peerId: string) => void
  sendFriendRequest: (peerId: string, note: string) => void
  respondToFriendRequest: (request: FriendRequest, accept: boolean) => void
  cancelFriendRequest: (requestId: string) => void
  unfriendPeer: (peerId: string) => void
  loadFriendRequests: () => void
  loadBlockedPeers: () => void
  blockPeer: (peerId: string, displayName: string) => void
  unblockPeer: (peerId: string, displayName: string) => void
  blockSenderFromRequest: (request: FriendRequest) => void

  reStun: () => void
  loadDebugInfo: () => void
  loadFiles: () => void
  loadFilesDir: () => void
  setFilesDir: (path: string) => void
  sendFile: (filePath: string) => void
  downloadFile: (fileId: string, destPath: string) => void
  defaultDownloadPath: (filename: string) => string

  testNotificationDelivery: (delivery: Exclude<NotificationDelivery, "disabled">, firstRun?: boolean) => void
  disableNotifications: (firstRun?: boolean) => void
  confirmNotificationDelivery: (delivery: Exclude<NotificationDelivery, "disabled">, firstRun?: boolean) => void
  toggleNotificationEvent: (event: NotificationEvent) => void

  saveDisplayName: (value?: string) => void
  checkForUpdatesFromAbout: () => void
  installUpdate: (release: Release, destination?: string) => void
  saveUpdateToken: (release: Release | undefined, destination: string | undefined, token: string) => void
  restartUpdate: (installDir: string) => void
}

export function DialogPanel(props: DialogPanelProps) {
  const { dialog, dialogBusy, dialogError, dialogHeight, dialogWidth, dialogDraft, controlStatus, debugInfo, flashingEnabled, imageProtocol, groups, identity, mutedPeers, notificationPreferences, notificationTestDelivery, peers, selected, selectedGroupId, selection, dialogWidthFor, appReleaseVersion, isReleaseBuild } = props
  const { runCommand, showDialog, closeDialog, goBack, setDialogDraft, setDialogError, setNameDraft } = props
  const { configureControl, dismissControlSetup, loadControlStatus, saveAdvancedConfig, setAccessibilityFlashing } = props
  const { createRoom, joinRoom, leaveRoom, loadRoomInvite, loadRooms, copyInvite, leaveGroup, loadGroupDetails } = props
  const { mutePeer, unmutePeer, sendFriendRequest, respondToFriendRequest, cancelFriendRequest, unfriendPeer, loadFriendRequests, loadBlockedPeers, blockPeer, unblockPeer, blockSenderFromRequest } = props
  const { reStun, loadDebugInfo, loadFiles, loadFilesDir, setFilesDir, sendFile, downloadFile, defaultDownloadPath } = props
  const { testNotificationDelivery, disableNotifications, confirmNotificationDelivery, toggleNotificationEvent } = props
  const { saveDisplayName, checkForUpdatesFromAbout, installUpdate, saveUpdateToken, restartUpdate } = props

  if (!dialog) return null

  return <box style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", backgroundColor: "#080b1099", alignItems: "center", justifyContent: "center" }}>
    <box
      title={dialog.kind === "commands" ? "Commands"
        : dialog.kind.startsWith("control") ? "Control server"
        : dialog.kind.startsWith("advanced") ? "Advanced Configuration"
        : dialog.kind === "rename" ? "Display name"
        : dialog.kind === "mute-timeout" ? "Mute peer"
        : dialog.kind === "unmute-confirm" ? "Unmute peer"
        : dialog.kind === "add-friend" ? "Add friend"
        : dialog.kind === "remove-friend" ? "Remove friend"
        : dialog.kind === "friend-requests" ? "Friend requests"
        : dialog.kind === "friend-request-incoming" ? "Friend request"
        : dialog.kind === "friends" ? "Friends"
         : dialog.kind === "notifications" ? "Notifications"
        : dialog.kind.startsWith("notification-") ? "Desktop alerts"
        : dialog.kind === "notification-settings" ? "Desktop alerts"
        : dialog.kind === "notification-peer" ? "Selected peer alerts"
        : dialog.kind === "accessibility" ? "Accessibility"
        : dialog.kind === "blocked" ? "Blocked friends"
        : dialog.kind === "block-peer-pick" ? "Block a peer"
        : dialog.kind === "block-peer" ? "Block friend requests"
        : dialog.kind === "cancel-friend-confirm" ? "Cancel friend request"
        : dialog.kind === "debug-peer" ? "Peer details"
        : dialog.kind === "debug-endpoints" ? "Endpoints"
        : dialog.kind === "debug" ? "Debug"
        : dialog.kind === "update" ? "Update available"
        : dialog.kind === "update-directory" ? "Update destination"
        : dialog.kind === "update-token" ? "GitHub access required"
        : dialog.kind === "about" ? "About MeshTalk"
        : dialog.kind === "group-detail" ? "Group details"
        : dialog.kind === "file-send" ? "Upload file"
        : dialog.kind === "file-list" ? "Files"
        : dialog.kind === "file-download" ? "Save file"
         : dialog.kind === "files-dir" ? "File storage"
         : dialog.kind === "image-view" ? "Image preview"
         : dialog.kind === "delivery-details" ? "Delivery details"
         : "Private rooms"}
      bottomTitle={dialogBusy ? "Working..." : "Esc back  Ctrl+P Commands"}
      style={{ width: dialogWidthFor(dialog.kind), height: dialogHeight, border: true, borderColor: dialog.kind === "about" ? "#9b8cff" : dialog.kind === "update" ? "#e0a34a" : "#6ea8fe", backgroundColor: "#111923", padding: 1, flexDirection: "column", gap: 1, overflow: "hidden" }}
    >
      {dialog.kind === "commands" && <CommandsDialog dialogHeight={dialogHeight} groups={groups} peers={peers} selectedGroup={groups.find((group) => group.group_id === selectedGroupId)} selection={selection} runCommand={runCommand} />}
      {dialog.kind === "about" && <AboutDialog appReleaseVersion={appReleaseVersion} dialog={dialog} dialogError={dialogError} dialogHeight={dialogHeight} dialogWidth={dialogWidth} isReleaseBuild={isReleaseBuild} checkForUpdates={checkForUpdatesFromAbout} goBack={goBack} />}
      {dialog.kind === "update" && <UpdateDialog appReleaseVersion={appReleaseVersion} dialog={dialog} dialogError={dialogError} dialogHeight={dialogHeight} dialogWidth={dialogWidth} closeDialog={closeDialog} installing={dialogBusy} installUpdate={installUpdate} restartUpdate={restartUpdate} chooseUpdateDestination={(release) => { setDialogError(""); setDialogDraft(""); showDialog({ kind: "update-directory", release }) }} />}
      {dialog.kind === "update-directory" && <UpdateDestinationDialog dialog={dialog} dialogError={dialogError} dialogWidth={dialogWidth} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} installUpdate={installUpdate} />}
      {dialog.kind === "update-token" && <UpdateTokenDialog dialog={dialog} dialogError={dialogError} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} saveUpdateToken={saveUpdateToken} />}
      {dialog.kind === "control" && <ControlDialogContent dialog={dialog} dialogHeight={dialogHeight} configureControl={configureControl} dismissControlSetup={dismissControlSetup} loadControlStatus={loadControlStatus} showDialog={showDialog} />}
      {dialog.kind === "control-custom" && <ControlCustomDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} configureControl={configureControl} />}
      {dialog.kind === "control-status" && <ControlStatusDialogContent dialog={dialog} showDialog={showDialog} />}
      {dialog.kind === "advanced" && <AdvancedDialogContent dialog={dialog} dialogHeight={dialogHeight} showDialog={showDialog} />}
      {dialog.kind === "advanced-image-protocol" && <ImageProtocolDialogContent dialog={dialog} dialogHeight={dialogHeight} saveAdvancedConfig={saveAdvancedConfig} showDialog={showDialog} />}
      {dialog.kind === "advanced-ip-pinning" && <IpPinningDialogContent dialog={dialog} dialogHeight={dialogHeight} showDialog={showDialog} />}
      {dialog.kind === "advanced-control" && <AdvancedControlDialogContent dialog={dialog} dialogHeight={dialogHeight} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} showDialog={showDialog} />}
      {dialog.kind === "advanced-stun" && <AdvancedStunDialogContent dialog={dialog} dialogHeight={dialogHeight} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} showDialog={showDialog} />}
      {dialog.kind === "advanced-control-ip" && <AdvancedControlIpDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} />}
      {dialog.kind === "advanced-stun-ip" && <AdvancedStunIpDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} />}
      {dialog.kind === "rooms" && <RoomsDialogContent dialog={dialog} dialogHeight={dialogHeight} loadRooms={loadRooms} showDialog={showDialog} />}
      {dialog.kind === "room-create" && <RoomCreateDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} createRoom={createRoom} />}
      {dialog.kind === "room-join" && <RoomJoinDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} joinRoom={joinRoom} />}
      {dialog.kind === "room-created" && <RoomCreatedDialogContent dialog={dialog} copyInvite={copyInvite} loadRooms={loadRooms} />}
      {dialog.kind === "room-detail" && <RoomDetailDialogContent dialog={dialog} groups={groups} leaveGroup={leaveGroup} leaveRoom={leaveRoom} loadRoomInvite={loadRoomInvite} loadRooms={loadRooms} />}
       {dialog.kind === "group-detail" && <GroupDetailDialogContent dialog={dialog} identity={identity} peers={peers} closeDialog={closeDialog} leaveGroup={leaveGroup} />}
      {dialog.kind === "rename" && <RenameDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} setNameDraft={setNameDraft} saveDisplayName={saveDisplayName} />}
      {dialog.kind === "mute-timeout" && <MuteTimeoutDialogContent dialog={dialog} dialogHeight={dialogHeight} mutePeer={mutePeer} />}
      {dialog.kind === "unmute-confirm" && <UnmuteConfirmDialogContent dialog={dialog} unmutePeer={unmutePeer} showDialog={showDialog} />}
      {dialog.kind === "add-friend" && <AddFriendDialogContent dialog={dialog} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} sendFriendRequest={sendFriendRequest} />}
      {dialog.kind === "remove-friend" && <RemoveFriendDialogContent dialog={dialog} unfriendPeer={unfriendPeer} showDialog={showDialog} />}
      {dialog.kind === "friend-requests" && <FriendRequestsDialogContent dialog={dialog} dialogHeight={dialogHeight} showDialog={showDialog} />}
      {dialog.kind === "friend-request-incoming" && <FriendRequestIncomingDialogContent dialog={dialog} blockSenderFromRequest={blockSenderFromRequest} respondToFriendRequest={respondToFriendRequest} />}
      {dialog.kind === "friends" && <FriendsDialogContent dialogHeight={dialogHeight} loadBlockedPeers={loadBlockedPeers} runCommand={runCommand} showDialog={showDialog} />}
      {["notification-enable", "notification-confirm", "notification-fallback", "notifications", "notification-settings", "notification-peer"].includes(dialog.kind) && <NotificationDialogs dialog={dialog as Extract<Dialog, { kind: "notification-enable" | "notification-confirm" | "notification-fallback" | "notifications" | "notification-settings" | "notification-peer" }>} dialogBusy={dialogBusy} dialogError={dialogError} dialogHeight={dialogHeight} dialogWidth={dialogWidth} identity={identity} mutedPeers={mutedPeers} notificationPreferences={notificationPreferences} notificationTestDelivery={notificationTestDelivery} peers={peers} selectedPeerId={selected?.peer_id} showDialog={showDialog} testNotificationDelivery={testNotificationDelivery} disableNotifications={disableNotifications} confirmNotificationDelivery={confirmNotificationDelivery} toggleNotificationEvent={toggleNotificationEvent} runCommand={runCommand} />}
      {dialog.kind === "accessibility" && <AccessibilityDialogContent dialogHeight={dialogHeight} flashingEnabled={flashingEnabled} setAccessibilityFlashing={setAccessibilityFlashing} showDialog={showDialog} />}
      {dialog.kind === "blocked" && <BlockedDialogContent dialog={dialog} dialogHeight={dialogHeight} loadBlockedPeers={loadBlockedPeers} showDialog={showDialog} unblockPeer={unblockPeer} />}
      {dialog.kind === "block-peer-pick" && <BlockPeerPickDialogContent dialogWidth={dialogWidth} dialogHeight={dialogHeight} peers={peers} identity={identity} loadBlockedPeers={loadBlockedPeers} showDialog={showDialog} />}
      {dialog.kind === "block-peer" && <BlockPeerDialogContent dialog={dialog} blockPeer={blockPeer} loadBlockedPeers={loadBlockedPeers} showDialog={showDialog} />}
      {dialog.kind === "cancel-friend-confirm" && <CancelFriendConfirmDialogContent dialog={dialog} cancelFriendRequest={cancelFriendRequest} loadFriendRequests={loadFriendRequests} showDialog={showDialog} />}
      {dialog.kind === "debug" && <DebugDialogContent dialog={dialog} controlStatus={controlStatus} debugInfo={debugInfo} dialogHeight={dialogHeight} reStun={reStun} loadDebugInfo={loadDebugInfo} showDialog={showDialog} />}
      {dialog.kind === "debug-endpoints" && <DebugEndpointsDialogContent debugInfo={debugInfo} showDialog={showDialog} />}
      {dialog.kind === "debug-peer" && <DebugPeerDialogContent dialog={dialog} debugInfo={debugInfo} showDialog={showDialog} />}
      {dialog.kind === "file-send" && <FileSendDialogContent dialog={dialog} dialogWidth={dialogWidth} selection={selection} peers={peers} groups={groups} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} sendFile={sendFile} />}
      {dialog.kind === "file-list" && <FileListDialogContent dialog={dialog} dialogHeight={dialogHeight} dialogWidth={dialogWidth} imageProtocol={imageProtocol} loadFiles={loadFiles} loadFilesDir={loadFilesDir} setDialogDraft={setDialogDraft} showDialog={showDialog} defaultDownloadPath={defaultDownloadPath} />}
      {dialog.kind === "files-dir" && <FilesDirDialogContent dialog={dialog} dialogWidth={dialogWidth} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} setFilesDir={setFilesDir} loadFiles={loadFiles} />}
      {dialog.kind === "file-download" && <FileDownloadDialogContent dialog={dialog} dialogWidth={dialogWidth} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} downloadFile={downloadFile} defaultDownloadPath={defaultDownloadPath} />}
      {dialog.kind === "image-view" && <ImageViewerDialogContent dialog={dialog} dialogWidth={dialogWidthFor(dialog.kind)} dialogHeight={dialogHeight} imageProtocol={imageProtocol} />}
      {dialog.kind === "delivery-details" && <DeliveryDetailsDialogContent dialog={dialog} />}
    </box>
    <box style={{ position: "absolute", right: 1, bottom: 0 }}>
      <text><span fg="#66dd88">● </span><span fg="#bbbbbb">MeshTalk </span><span fg="#888888">{appReleaseVersion}</span></text>
    </box>
  </box>
}

function ImageViewerDialogContent({ dialog, dialogWidth, dialogHeight, imageProtocol }: { dialog: Extract<Dialog, { kind: "image-view" }>; dialogWidth: number; dialogHeight: number; imageProtocol: ImageProtocol }) {
  return (
    <>
      <text wrapMode="none"><span fg="#66dd88">{dialog.filename}</span></text>
      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, alignItems: "center", justifyContent: "center" }}>
        <ImageAttachment filePath={dialog.filePath} filename={dialog.filename} protocol={imageProtocol} expectedImage fullSize lazy={false} maxWidth={Math.max(1, dialogWidth - 4)} maxHeight={Math.max(1, dialogHeight - 5)} />
      </box>
      <text fg="#888888">Esc returns.</text>
    </>
  )
}

function DeliveryDetailsDialogContent({ dialog }: { dialog: Extract<Dialog, { kind: "delivery-details" }> }) {
  const statusOrder = ["delivered", "sent", "queued", "pending", "unavailable"]
  const statusColor: Record<string, string> = { delivered: "#66dd88", sent: "#7aa2d6", queued: "#e0a34a", pending: "#888888", unavailable: "#ff7777" }
  const grouped = statusOrder.map((status) => [status, dialog.deliveries.filter((delivery) => delivery.status === status)] as const).filter(([, deliveries]) => deliveries.length)
  return <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}>
    {!dialog.deliveries.length ? <text fg="#888888">No delivery details are available yet.</text> : null}
    {grouped.map(([status, deliveries]) => <box key={status} style={{ flexDirection: "column", marginBottom: 1 }}>
      <text fg={statusColor[status]}><b>{status[0].toUpperCase() + status.slice(1)} ({deliveries.length})</b></text>
      {deliveries.map((delivery: GroupDelivery) => <text key={delivery.recipient_id}>  {delivery.display_name}</text>)}
    </box>)}
  </scrollbox>
}

function ControlDialogContent({ dialog, dialogHeight, configureControl, dismissControlSetup, loadControlStatus, showDialog }: { dialog: Extract<Dialog, { kind: "control" }>; dialogHeight: number; configureControl: (url: string) => void; dismissControlSetup: () => void; loadControlStatus: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      {dialog.firstRun && <MarqueeText width={50} fg="#e0a34a" text="Set up remote discovery to connect outside your LAN. You can skip this for LAN-only chat." />}
      <MouseSelect focused height={Math.max(6, dialogHeight - 4)} options={[
        { name: "Use MeshTalk public server", description: "wss://meshtalk-control.qincai.xyz/v1/rendezvous", value: "public" },
        { name: "Use a custom server", description: "Enter another secure WebSocket URL", value: "custom" },
        { name: "View connection status", description: "See the current URL, connection, STUN, and endpoint", value: "status" },
        ...(dialog.firstRun ? [{ name: "Continue with LAN only", description: "You can configure this later with Ctrl+P", value: "skip" }] : []),
      ]} onSelect={(_, option) => {
        if (option?.value === "public") configureControl(PUBLIC_CONTROL_URL)
        else if (option?.value === "custom") showDialog({ kind: "control-custom", firstRun: dialog.firstRun })
        else if (option?.value === "status") loadControlStatus()
        else if (option?.value === "skip") dismissControlSetup()
      }} wrapSelection showDescription />
    </>
  )
}

function ControlCustomDialogContent({ dialogDraft, setDialogDraft, configureControl }: { dialogDraft: string; setDialogDraft: (v: string) => void; configureControl: (url: string) => void }) {
  return (
    <>
      <text>Enter a `wss://` URL. Plain `ws://` is accepted only for localhost.</text>
      <input focused value={dialogDraft} placeholder="wss://control.example/v1/rendezvous" onInput={setDialogDraft} onSubmit={(value) => void configureControl(typeof value === "string" ? value : dialogDraft)} maxLength={2048} />
      <text fg="#888888">Enter saves the server.</text>
    </>
  )
}

function ControlStatusDialogContent({ dialog, showDialog }: { dialog: Extract<Dialog, { kind: "control-status" }>; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text><span fg="#888888">Server: </span>{dialog.control.url ?? "Not configured"}</text>
      <text><span fg="#888888">Connection: </span><span fg={dialog.control.connected ? "#66dd88" : "#e0a34a"}>{dialog.control.connected ? "Connected" : "Disconnected"}</span></text>
      <text><span fg="#888888">STUN: </span>{dialog.control.stun_server}</text>
      <text><span fg="#888888">Public endpoint: </span>{dialog.control.public_endpoint?.join(":") ?? "Not discovered"}</text>
      <MouseSelect focused height={5} options={[
        { name: "Change server", description: "Choose the public server or enter a custom URL", value: "change" },
         { name: "Back to Commands", description: "Return to Commands", value: "back" },
      ]} onSelect={(_, option) => option?.value === "change" ? showDialog({ kind: "control" }) : showDialog({ kind: "commands" })} />
    </>
  )
}

function AdvancedDialogContent({ dialog, dialogHeight, showDialog }: { dialog: Extract<Dialog, { kind: "advanced" }>; dialogHeight: number; showDialog: (d: Dialog) => void }) {
  return (
    <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
      { name: "Image protocol", description: `Current: ${dialog.config.image_protocol} (auto prefers Kitty, then Sixel, then blocks)`, value: "image-protocol" },
      { name: "IP Pinning", description: "Pin control or STUN server addresses to bypass DNS", value: "ip-pinning" },
         { name: "Back to Commands", description: "Return to Commands", value: "back" },
    ]} onSelect={(_, option) => {
        if (option?.value === "image-protocol") showDialog({ kind: "advanced-image-protocol", config: dialog.config })
       else if (option?.value === "ip-pinning") showDialog({ kind: "advanced-ip-pinning", config: dialog.config })
      else if (option?.value === "back") showDialog({ kind: "commands" })
    }} wrapSelection showDescription />
  )
}

function ImageProtocolDialogContent({ dialog, dialogHeight, saveAdvancedConfig, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-image-protocol" }>; dialogHeight: number; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void; showDialog: (d: Dialog) => void }) {
  return <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
    { name: "Auto-detect", description: "Prefer Kitty, then Sixel, then portable blocks; use blocks in tmux", value: "auto" },
    { name: "Kitty", description: "Force high-quality Kitty graphics where your terminal supports it", value: "kitty" },
    { name: "Sixel", description: "Force Sixel graphics; falls back to blocks without pixel geometry", value: "sixel" },
    { name: "Blocks", description: "Force portable Unicode blocks", value: "blocks" },
    { name: "Back", description: "Return to Advanced Configuration", value: "back" },
  ]} onSelect={(_, option) => {
    if (!option) return
    if (option.value === "back") showDialog({ kind: "advanced", config: dialog.config })
    else void saveAdvancedConfig({ image_protocol: option.value }, `Image protocol set to ${option.value}.`)
  }} wrapSelection showDescription />
}

function IpPinningDialogContent({ dialog, dialogHeight, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-ip-pinning" }>; dialogHeight: number; showDialog: (d: Dialog) => void }) {
  return <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
    { name: "Control server", description: dialog.config.control_pinned_ips.length ? `Pinned: ${dialog.config.control_pinned_ips.join(", ")}` : "No IP pin", value: "control" },
    { name: "STUN server", description: dialog.config.stun_pinned_ips.length ? `Pinned: ${dialog.config.stun_pinned_ips.join(", ")}` : "No IP pin", value: "stun" },
    { name: "Back", description: "Return to Advanced Configuration", value: "back" },
  ]} onSelect={(_, option) => {
    if (option?.value === "control") showDialog({ kind: "advanced-control", config: dialog.config })
    else if (option?.value === "stun") showDialog({ kind: "advanced-stun", config: dialog.config })
    else if (option?.value === "back") showDialog({ kind: "advanced", config: dialog.config })
  }} wrapSelection showDescription />
}

function AdvancedControlDialogContent({ dialog, dialogHeight, setDialogDraft, saveAdvancedConfig, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-control" }>; dialogHeight: number; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
      { name: "Manual IP address", description: "Enter one or more comma-separated IPv4 or IPv6 addresses", value: "manual" },
      { name: "Auto: resolve and pin", description: "Query A and AAAA records, then save the results as pins", value: "auto" },
      ...(dialog.config.control_pinned_ips.length ? [{ name: "Remove IP pin", description: `Pinned: ${dialog.config.control_pinned_ips.join(", ")}`, value: "clear" }] : []),
      { name: "Back", description: "Return to Advanced Configuration", value: "back" },
    ]} onSelect={(_, option) => {
      if (option?.value === "manual") { setDialogDraft(dialog.config.control_pinned_ips.join(", ")); showDialog({ kind: "advanced-control-ip" }) }
      else if (option?.value === "auto") void saveAdvancedConfig({ auto_control_pinned_ip: true }, "Control server addresses resolved and pinned.")
      else if (option?.value === "clear") void saveAdvancedConfig({ clear_control_pinned_ip: true }, "Control server IP pin cleared.")
      else if (option?.value === "back") showDialog({ kind: "advanced", config: dialog.config })
    }} wrapSelection showDescription />
  )
}

function AdvancedStunDialogContent({ dialog, dialogHeight, setDialogDraft, saveAdvancedConfig, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-stun" }>; dialogHeight: number; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
      { name: "Manual IP address", description: "Enter one or more comma-separated IPv4 addresses", value: "manual" },
      { name: "Auto: resolve and pin", description: "Query A records, then save the results as pins", value: "auto" },
      ...(dialog.config.stun_pinned_ips.length ? [{ name: "Remove IP pin", description: `Pinned: ${dialog.config.stun_pinned_ips.join(", ")}`, value: "clear" }] : []),
      { name: "Back", description: "Return to Advanced Configuration", value: "back" },
    ]} onSelect={(_, option) => {
      if (option?.value === "manual") { setDialogDraft(dialog.config.stun_pinned_ips.join(", ")); showDialog({ kind: "advanced-stun-ip" }) }
      else if (option?.value === "auto") void saveAdvancedConfig({ auto_stun_pinned_ip: true }, "STUN server addresses resolved and pinned.")
      else if (option?.value === "clear") void saveAdvancedConfig({ clear_stun_pinned_ip: true }, "STUN server IP pin cleared.")
      else if (option?.value === "back") showDialog({ kind: "advanced", config: dialog.config })
    }} wrapSelection showDescription />
  )
}

function AdvancedControlIpDialogContent({ dialogDraft, setDialogDraft, saveAdvancedConfig }: { dialogDraft: string; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void }) {
  return (
    <>
      <text>Enter comma-separated IPv4 or IPv6 addresses for the control server.</text>
      <input focused value={dialogDraft} placeholder="104.21.6.171, 172.67.135.15, 2606:4700:3032::6815:6ab, 2606:4700:3037::ac43:870f" onInput={setDialogDraft} onSubmit={(value) => void saveAdvancedConfig({ control_pinned_ip: typeof value === "string" ? value : dialogDraft }, "Control server IPs pinned.")} maxLength={1024} />
      <text fg="#888888">Enter saves the IP pin.</text>
    </>
  )
}

function AdvancedStunIpDialogContent({ dialogDraft, setDialogDraft, saveAdvancedConfig }: { dialogDraft: string; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void }) {
  return (
    <>
      <text>Enter comma-separated IPv4 addresses for the STUN server.</text>
      <input focused value={dialogDraft} placeholder="203.0.113.10, 203.0.113.11" onInput={setDialogDraft} onSubmit={(value) => void saveAdvancedConfig({ stun_pinned_ip: typeof value === "string" ? value : dialogDraft }, "STUN server IPs pinned.")} maxLength={1024} />
      <text fg="#888888">Enter saves the IP pin.</text>
    </>
  )
}

function RoomsDialogContent({ dialog, dialogHeight, loadRooms, showDialog }: { dialog: Extract<Dialog, { kind: "rooms" }>; dialogHeight: number; loadRooms: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
        { name: "Create a private room", description: "Generate a secret invite and copy it", value: "create" },
        { name: "Join with an invite", description: "Paste a room or group invite", value: "join" },
        ...dialog.rooms.map((room) => ({
          name: room.name ?? `Room ${room.room_id.slice(0, 12)}`,
          description: `${room.members} control connection${room.members === 1 ? "" : "s"} - view or leave`,
          value: room.room_id,
        })),
      ]} onSelect={(_, option) => {
        if (option?.value === "create") showDialog({ kind: "room-create" })
        else if (option?.value === "join") showDialog({ kind: "room-join" })
        else {
          const room = dialog.rooms.find((item) => item.room_id === option?.value)
          if (room) showDialog({ kind: "room-detail", room })
        }
      }} wrapSelection showDescription />
      {!dialog.rooms.length && <text fg="#888888">No joined rooms yet.</text>}
    </>
  )
}

function RoomCreateDialogContent({ dialogDraft, setDialogDraft, createRoom }: { dialogDraft: string; setDialogDraft: (v: string) => void; createRoom: (name: string) => void }) {
  return (
    <>
      <text>Choose a name for the new group.</text>
      <input focused value={dialogDraft} placeholder="Group name" onInput={setDialogDraft} onSubmit={(value) => void createRoom(typeof value === "string" ? value : dialogDraft)} maxLength={80} />
      <text fg="#888888">Enter creates the group and copies its secret invite.</text>
    </>
  )
}

function RoomJoinDialogContent({ dialogDraft, setDialogDraft, joinRoom }: { dialogDraft: string; setDialogDraft: (v: string) => void; joinRoom: (invite: string) => void }) {
  return (
    <>
      <text>Paste the secret invite you received from another room member.</text>
      <input focused value={dialogDraft} placeholder="meshtalk:... or meshtalk-group:..." onInput={setDialogDraft} onSubmit={(value) => void joinRoom(typeof value === "string" ? value : dialogDraft)} maxLength={4096} />
      <text fg="#888888">Enter joins the room. Invites are secrets.</text>
    </>
  )
}

function RoomCreatedDialogContent({ dialog, copyInvite, loadRooms }: { dialog: Extract<Dialog, { kind: "room-created" }>; copyInvite: (invite: string) => void; loadRooms: () => void }) {
  return (
    <>
      <text fg="#66dd88">{dialog.created ? "Room created" : "Room invite"}</text>
      <text><span fg="#888888">ID: </span>{dialog.roomId}</text>
      <text wrapMode="word"><span fg="#888888">Invite: </span>{dialog.invite}</text>
      <text fg={dialog.copied ? "#66dd88" : "#e0a34a"}>{dialog.copied ? "Copy requested. Paste once to confirm your terminal accepted it." : "Copy the invite before sharing it."}</text>
      <MouseSelect focused height={5} options={[
        { name: "Copy invite", description: "Copy the secret invite to the clipboard", value: "copy" },
        { name: "Back to rooms", description: "Manage your private rooms", value: "back" },
      ]} onSelect={(_, option) => option?.value === "copy" ? void copyInvite(dialog.invite) : void loadRooms()} />
    </>
  )
}

function RoomDetailDialogContent({ dialog, groups, leaveGroup, leaveRoom, loadRoomInvite, loadRooms }: { dialog: Extract<Dialog, { kind: "room-detail" }>; groups: Group[]; leaveGroup: (g: Group) => void; leaveRoom: (roomId: string) => void; loadRoomInvite: (roomId: string) => void; loadRooms: () => void }) {
  return (
    <>
      <text><span fg="#888888">Room ID: </span>{dialog.room.room_id}</text>
      <text><span fg="#888888">Control connections: </span>{dialog.room.members}</text>
      <text fg="#e0a34a">Leaving removes this room and its secret from this device.</text>
      <MouseSelect focused height={6} options={[
        { name: "Keep room", description: "Return without making changes", value: "keep" },
        { name: "Copy invite", description: "Reveal and copy this room's secret invite", value: "copy" },
        { name: "Leave room", description: "Permanently remove this room from this device", value: "leave" },
      ]} onSelect={(_, option) => {
        if (option?.value === "leave") { const group = groups.find((item) => item.group_id === dialog.room.group_id); if (group) void leaveGroup(group); else void leaveRoom(dialog.room.room_id) }
        else if (option?.value === "copy") void loadRoomInvite(dialog.room.room_id)
        else void loadRooms()
      }} />
    </>
  )
}

function GroupDetailDialogContent({ dialog, identity, peers, closeDialog, leaveGroup }: { dialog: Extract<Dialog, { kind: "group-detail" }>; identity: { peer_id: string; display_name: string } | undefined; peers: Peer[]; closeDialog: () => void; leaveGroup: (g: Group) => void }) {
  return (
    <>
      <text><span fg="#888888">Name: </span>{dialog.group.name}</text>
      <text><span fg="#888888">Group ID: </span>{dialog.group.group_id}</text>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}>
        {!dialog.members.length ? <text fg="#888888">No member details available.</text> : null}
        {dialog.members.map((member, index) => {
          const memberId = member.peer_id ?? member.member_id
          const knownPeer = peers.find((peer) => peer.peer_id === memberId)
          const color = memberId === identity?.peer_id ? "#65a9ff" : knownPeer ? peerPresence(knownPeer) === "active" ? "#66dd88" : peerPresence(knownPeer) === "away" ? "#e0a34a" : "#888888" : member.is_online ? "#66dd88" : "#888888"
          return <text key={memberId ?? String(index)}>
            <span fg={color}>{member.display_name}</span>
            <span fg="#718096"> {(memberId ?? "").slice(0, 12)}</span>
          </text>
        })}
      </scrollbox>
      <MouseSelect focused height={4} options={[
        { name: "Close", description: "Return to the group chat", value: "close" },
        { name: "Leave group", description: "Remove this group from this device", value: "leave" },
      ]} onSelect={(_, option) => option?.value === "leave" ? void leaveGroup(dialog.group) : closeDialog()} wrapSelection showDescription />
    </>
  )
}

function RenameDialogContent({ dialogDraft, setDialogDraft, setNameDraft, saveDisplayName }: { dialogDraft: string; setDialogDraft: (v: string) => void; setNameDraft: (v: string) => void; saveDisplayName: (v?: string) => void }) {
  return (
    <>
      <text>Choose the name other peers will see.</text>
      <input focused value={dialogDraft} placeholder="Display name" onInput={(value) => { setDialogDraft(value); setNameDraft(value) }} onSubmit={(value) => void saveDisplayName(typeof value === "string" ? value : dialogDraft)} maxLength={48} />
      <text fg="#888888">Enter saves and shares the name with connected peers.</text>
    </>
  )
}

function MuteTimeoutDialogContent({ dialog, dialogHeight, mutePeer }: { dialog: Extract<Dialog, { kind: "mute-timeout" }>; dialogHeight: number; mutePeer: (peerId: string, timeout: number) => void }) {
  return (
    <>
      <text>Mute notifications from <span fg="#66dd88">{dialog.displayName}</span>.</text>
      <text fg="#888888">Choose how long notifications will stay muted.</text>
      <MouseSelect focused height={Math.max(5, dialogHeight - 6)} options={[
        { name: "15 minutes", description: "Mute for a short break", value: String(15 * 60) },
        { name: "1 hour", description: "Mute for a while", value: String(60 * 60) },
        { name: "4 hours", description: "Mute for half a workday", value: String(4 * 60 * 60) },
        { name: "8 hours", description: "Mute for a full workday", value: String(8 * 60 * 60) },
        { name: "Permanent", description: "Mute until you manually unmute", value: "0" },
      ]} onSelect={(_, option) => option && void mutePeer(dialog.peerId, Number(option.value))} wrapSelection showDescription />
    </>
  )
}

function UnmuteConfirmDialogContent({ dialog, unmutePeer, showDialog }: { dialog: Extract<Dialog, { kind: "unmute-confirm" }>; unmutePeer: (peerId: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text>Unmute notifications from <span fg="#66dd88">{dialog.displayName}</span>?</text>
      <MouseSelect focused height={4} options={[
        { name: "Yes, unmute", description: "Resume desktop notifications from this peer", value: "yes" },
        { name: "Cancel", description: "Keep muted", value: "no" },
      ]} onSelect={(_, option) => option?.value === "yes" ? void unmutePeer(dialog.peerId) : showDialog({ kind: "commands" })} wrapSelection showDescription />
    </>
  )
}

function AddFriendDialogContent({ dialog, dialogDraft, setDialogDraft, sendFriendRequest }: { dialog: Extract<Dialog, { kind: "add-friend" }>; dialogDraft: string; setDialogDraft: (v: string) => void; sendFriendRequest: (peerId: string, note: string) => void }) {
  return (
    <>
      <text>Send a friend request to <span fg="#66dd88">{dialog.displayName}</span>?</text>
      <text fg="#888888">They must accept before your messages get through.</text>
      <input focused value={dialogDraft} placeholder="Optional note" onInput={setDialogDraft} onSubmit={(value) => void sendFriendRequest(dialog.peerId, typeof value === "string" ? value : dialogDraft)} maxLength={1024} />
      <text fg="#888888">Enter sends the request. Esc backs out.</text>
    </>
  )
}

function RemoveFriendDialogContent({ dialog, unfriendPeer, showDialog }: { dialog: Extract<Dialog, { kind: "remove-friend" }>; unfriendPeer: (peerId: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text>Remove <span fg="#66dd88">{dialog.displayName}</span> as a friend?</text>
      <text fg="#888888">Their future messages will be blocked until you accept a new request.</text>
      <MouseSelect focused height={4} options={[
        { name: "Remove friend", description: "Stop being friends and block their messages", value: "yes" },
        { name: "Cancel", description: "Keep them as a friend", value: "no" },
      ]} onSelect={(_, option) => option?.value === "yes" ? void unfriendPeer(dialog.peerId) : showDialog({ kind: "commands" })} wrapSelection showDescription />
    </>
  )
}

function FriendRequestsDialogContent({ dialog, dialogHeight, showDialog }: { dialog: Extract<Dialog, { kind: "friend-requests" }>; dialogHeight: number; showDialog: (d: Dialog) => void }) {
  return (
    <>
      {!dialog.requests.length && <text fg="#888888">No pending friend requests.</text>}
      {dialog.requests.length > 0 && (
        <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
          ...dialog.requests.filter((r) => r.direction === "incoming").map((r) => ({
            name: `\u2199 Request from ${r.sender_name}`, description: r.note || "Accept, decline, or block", value: `incoming:${r.request_id}`,
          })),
          ...dialog.requests.filter((r) => r.direction === "outgoing").map((r) => ({
            name: `\u2197 Request to ${r.recipient_name ?? r.sender_name}`, description: "Cancel this request", value: `outgoing:${r.request_id}`,
          })),
         { name: "Back to Commands", description: "Return to Commands", value: "back" },
        ]} onSelect={(_, option) => {
          if (!option) return
          if (option.value === "back") showDialog({ kind: "commands" })
          else if (option.value.startsWith("incoming:")) {
            const id = option.value.slice("incoming:".length)
            const request = dialog.requests.find((item) => item.request_id === id)
            if (request) showDialog({ kind: "friend-request-incoming", request })
          } else if (option.value.startsWith("outgoing:")) {
            const id = option.value.slice("outgoing:".length)
            const request = dialog.requests.find((item) => item.request_id === id)
            if (request) showDialog({ kind: "cancel-friend-confirm", requestId: request.request_id, displayName: request.recipient_name ?? request.sender_name })
          }
        }} wrapSelection showDescription />
      )}
    </>
  )
}

function FriendRequestIncomingDialogContent({ dialog, blockSenderFromRequest, respondToFriendRequest }: { dialog: Extract<Dialog, { kind: "friend-request-incoming" }>; blockSenderFromRequest: (request: FriendRequest) => void; respondToFriendRequest: (request: FriendRequest, accept: boolean) => void }) {
  return (
    <>
      <text><span fg="#66dd88">{dialog.request.sender_name}</span> wants to add you as a friend.</text>
      {dialog.request.note ? <text wrapMode="word"><span fg="#888888">Note: </span>{dialog.request.note}</text> : null}
      <MouseSelect focused height={7} options={[
        { name: "Accept", description: "Become friends and allow direct messages", value: "accept" },
        { name: "Decline", description: "Reject this friend request", value: "decline" },
        { name: "Block sender", description: "Ignore all future friend requests from this person", value: "block" },
      ]} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "block") void blockSenderFromRequest(dialog.request)
        else void respondToFriendRequest(dialog.request, option.value === "accept")
      }} wrapSelection showDescription />
    </>
  )
}

function FriendsDialogContent({ dialogHeight, loadBlockedPeers, runCommand, showDialog }: { dialogHeight: number; loadBlockedPeers: () => void; runCommand: (cmd: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <MouseSelect focused height={Math.max(5, dialogHeight - 3)} options={[
      { name: "Block", description: "Ignore friend requests from a specific person", value: "blocked" },
      { name: "Add friend", description: "Send a friend request to the selected peer", value: "add-friend" },
      { name: "Friend requests", description: "View and respond to pending requests", value: "friend-requests" },
      { name: "Remove friend", description: "Stop being friends with the selected peer", value: "remove-friend" },
         { name: "Back to Commands", description: "Return to Commands", value: "back" },
    ]} onSelect={(_, option) => {
      if (!option) return
      if (option.value === "back") showDialog({ kind: "commands" })
      else if (option.value === "blocked") void loadBlockedPeers()
      else runCommand(option.value)
    }} wrapSelection showDescription />
  )
}

function AccessibilityDialogContent({ dialogHeight, flashingEnabled, setAccessibilityFlashing, showDialog }: { dialogHeight: number; flashingEnabled: boolean; setAccessibilityFlashing: (enabled: boolean) => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text fg="#888888">Reduce motion and other accessibility options.</text>
      <MouseSelect focused height={Math.max(4, dialogHeight - 4)} options={[
        { name: flashingEnabled ? "Disable Flashing" : "Re-enable Flashing", description: flashingEnabled ? "Stop capability and rendezvous warnings from blinking" : "Allow capability and rendezvous warnings to blink", value: "toggle-flash" },
         { name: "Back to Commands", description: "Return to Commands", value: "back" },
      ]} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "toggle-flash") void setAccessibilityFlashing(!flashingEnabled)
        else showDialog({ kind: "commands" })
      }} wrapSelection showDescription />
    </>
  )
}

function BlockedDialogContent({ dialog, dialogHeight, loadBlockedPeers, showDialog, unblockPeer }: { dialog: Extract<Dialog, { kind: "blocked" }>; dialogHeight: number; loadBlockedPeers: () => void; showDialog: (d: Dialog) => void; unblockPeer: (peerId: string, displayName: string) => void }) {
  return (
    <>
      {!dialog.blocked.length && <text fg="#888888">No blocked peers. Blocked peers cannot send you friend requests.</text>}
      {dialog.blocked.length > 0 && (
        <MouseSelect focused height={Math.max(5, dialogHeight - 6)} options={[
          ...dialog.blocked.map((peer) => ({ name: peer.display_name, description: "Unblock — allow friend requests again", value: `unblock:${peer.peer_id}` })),
          { name: "Block a peer...", description: "Ignore friend requests from a specific person", value: "block-pick" },
          { name: "Back to friends", description: "Return to the Friends menu", value: "back" },
        ]} onSelect={(_, option) => {
          if (!option) return
          if (option.value === "block-pick") showDialog({ kind: "block-peer-pick" })
          else if (option.value === "back") showDialog({ kind: "friends" })
          else if (option.value.startsWith("unblock:")) {
            const peer = dialog.blocked.find((item) => `unblock:${item.peer_id}` === option.value)
            if (peer) void unblockPeer(peer.peer_id, peer.display_name)
          }
        }} wrapSelection showDescription />
      )}
      {dialog.blocked.length === 0 && (
        <MouseSelect focused height={4} options={[
          { name: "Block a peer...", description: "Ignore friend requests from a specific person", value: "block-pick" },
          { name: "Back to friends", description: "Return to the Friends menu", value: "back" },
        ]} onSelect={(_, option) => {
          if (option?.value === "block-pick") showDialog({ kind: "block-peer-pick" })
          else if (option?.value === "back") showDialog({ kind: "friends" })
        }} wrapSelection showDescription />
      )}
    </>
  )
}

function BlockPeerPickDialogContent({ dialogWidth, dialogHeight, peers, identity, loadBlockedPeers, showDialog }: { dialogWidth: number; dialogHeight: number; peers: Peer[]; identity: { peer_id: string; display_name: string } | undefined; loadBlockedPeers: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <MarqueeText width={dialogWidth - 4} fg="#888888" text="Choose someone to block. Blocked peers cannot send you friend requests." />
      <MouseSelect focused height={Math.max(5, dialogHeight - 6)} options={[
        ...peers.filter((peer) => peer.peer_id !== identity?.peer_id && !peer.is_blocked).map((peer) => ({
          name: peer.display_name, description: peer.is_online ? "Online" : "Offline", value: peer.peer_id,
        })),
        { name: "Back to blocked friends", description: "Return to the blocked friends list", value: "back" },
      ]} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "back") { showDialog({ kind: "blocked", blocked: [] }); void loadBlockedPeers(); return }
        const peer = peers.find((item) => item.peer_id === option.value)
        if (peer) showDialog({ kind: "block-peer", peerId: peer.peer_id, displayName: peer.display_name })
      }} wrapSelection showDescription />
    </>
  )
}

function BlockPeerDialogContent({ dialog, blockPeer, loadBlockedPeers, showDialog }: { dialog: Extract<Dialog, { kind: "block-peer" }>; blockPeer: (peerId: string, displayName: string) => void; loadBlockedPeers: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text>Block friend requests from <span fg="#66dd88">{dialog.displayName}</span>?</text>
      <text fg="#888888">You can unblock later in Commands {'>'} Friends {'>'} Block.</text>
      <MouseSelect focused height={4} options={[
        { name: "Block", description: "Ignore friend requests from this person", value: "yes" },
        { name: "Cancel", description: "Keep receiving friend requests", value: "no" },
      ]} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "yes") void blockPeer(dialog.peerId, dialog.displayName)
        else { showDialog({ kind: "blocked", blocked: [] }); void loadBlockedPeers() }
      }} wrapSelection showDescription />
    </>
  )
}

function CancelFriendConfirmDialogContent({ dialog, cancelFriendRequest, loadFriendRequests, showDialog }: { dialog: Extract<Dialog, { kind: "cancel-friend-confirm" }>; cancelFriendRequest: (requestId: string) => void; loadFriendRequests: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text>Cancel friend request to <span fg="#66dd88">{dialog.displayName}</span>?</text>
      <text fg="#888888">They will no longer see your pending request.</text>
      <MouseSelect focused height={4} options={[
        { name: "Cancel request", description: "Withdraw the pending friend request", value: "yes" },
        { name: "Keep request", description: "Leave the request pending", value: "no" },
      ]} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "yes") void cancelFriendRequest(dialog.requestId)
        else { showDialog({ kind: "friend-requests", requests: [] }); void loadFriendRequests() }
      }} wrapSelection showDescription />
    </>
  )
}

function DebugDialogContent({ dialog, controlStatus, debugInfo, dialogHeight, reStun, loadDebugInfo, showDialog }: { dialog: Extract<Dialog, { kind: "debug" }>; controlStatus: { connected: boolean; reconnect_attempts: number; control_url?: string | null }; debugInfo: DebugInfo | null; dialogHeight: number; reStun: () => void; loadDebugInfo: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text><span fg="#888888">Control: </span>{controlStatus.connected ? "Connected" : "Disconnected"}{controlStatus.reconnect_attempts ? ` (reconnects: ${controlStatus.reconnect_attempts})` : ""}</text>
      <text><span fg="#888888">STUN server: </span>{debugInfo?.stun_server ?? "..."}</text>
      <MouseSelect focused height={Math.min(8, Math.max(1, dialogHeight - 8))} options={[
        { name: "Re-STUN", description: "Re-query STUN server and republish endpoint cards", value: "re-stun" },
        { name: "Endpoints", description: "View your endpoint and connected peers", value: "endpoints" },
        { name: "Refresh", description: "Reload debug information", value: "refresh" },
         { name: "Back to Commands", description: "Return to Commands", value: "back" },
      ]} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "re-stun") void reStun()
        else if (option.value === "endpoints") { showDialog({ kind: "debug-endpoints" }); void loadDebugInfo() }
        else if (option.value === "refresh") void loadDebugInfo()
        else showDialog({ kind: "commands" })
      }} wrapSelection showDescription />
    </>
  )
}

function DebugEndpointsDialogContent({ debugInfo, showDialog }: { debugInfo: DebugInfo | null; showDialog: (d: Dialog) => void }) {
  return (
    <>
      {!debugInfo && <text fg="#888888">Loading debug info...</text>}
      {debugInfo && (
        <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}>
          <text><span fg="#888888">My public endpoint: </span>{debugInfo.public_endpoint ? `${debugInfo.public_endpoint[0]}:${debugInfo.public_endpoint[1]}` : "None"}</text>
          <text><span fg="#888888">Local TCP port: </span>{debugInfo.local_tcp_port}</text>
          <text fg="#888888">{"─".repeat(40)}</text>
          <text><span fg="#888888">Local</span></text>
          {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "lan_tcp")).length === 0 && <text fg="#888888">  No local peers</text>}
          {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "lan_tcp")).map((peer) => (
            <box key={`lp-${peer.peer_id}`} onMouseDown={() => showDialog({ kind: "debug-peer", peerId: peer.peer_id, displayName: peer.display_name })} style={{ width: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
              <text truncate fg={peer.is_online ? "#66dd88" : "#888888"}>{"> "}{peer.display_name} ({peer.peer_id.slice(0, 12)})</text>
            </box>
          ))}
          <text fg="#888888">{"─".repeat(40)}</text>
          <text><span fg="#888888">Remote</span></text>
          {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "remote_udp")).length === 0 && <text fg="#888888">  No remote peers</text>}
          {debugInfo.peers.filter((p) => p.endpoints.some((e) => e.transport === "remote_udp")).map((peer) => (
            <box key={`rp-${peer.peer_id}`} onMouseDown={() => showDialog({ kind: "debug-peer", peerId: peer.peer_id, displayName: peer.display_name })} style={{ width: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
              <text truncate fg={peer.is_online ? "#66dd88" : "#888888"}>{"> "}{peer.display_name} ({peer.peer_id.slice(0, 12)})</text>
            </box>
          ))}
        </scrollbox>
      )}
      <MouseSelect focused height={3} options={[{ name: "Back", description: "Return to debug", value: "back" }]} onSelect={(_, option) => { if (option?.value === "back") showDialog({ kind: "debug" }) }} wrapSelection showDescription />
    </>
  )
}

function DebugPeerDialogContent({ dialog, debugInfo, showDialog }: { dialog: Extract<Dialog, { kind: "debug-peer" }>; debugInfo: DebugInfo | null; showDialog: (d: Dialog) => void }) {
  const peer = debugInfo?.peers.find((p) => p.peer_id === dialog.peerId)
  if (!peer) return <text fg="#888888">Peer not found (try Refresh)</text>
  return (
    <>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}>
        <text><span fg="#888888">Name: </span>{peer.display_name}</text>
        <text><span fg="#888888">Peer ID: </span>{peer.peer_id}</text>
        <text><span fg="#888888">Online: </span>{peer.is_online ? "Yes" : "No"}</text>
        <text><span fg="#888888">Active transport: </span>{peer.active_transport ?? "None"}</text>
        <text><span fg="#888888">Active endpoint: </span>{peer.active_endpoint ?? "None"}</text>
        {peer.capabilities?.length ? <text><span fg="#888888">Capabilities: </span>{peer.capabilities.join(", ")}</text> : null}
        {peer.peer_missing_capabilities?.length ? <text><span fg="#888888">Peer missing: </span>{peer.peer_missing_capabilities.join(", ")}</text> : null}
        {peer.local_missing_capabilities?.length ? <text><span fg="#888888">Unavailable locally: </span>{peer.local_missing_capabilities.join(", ")}</text> : null}
        <text><span fg="#888888">Endpoints:</span></text>
        {peer.endpoints.map((e) => (
          <text key={`${e.transport}-${e.endpoint}`}>  {e.transport} {e.endpoint}{e.active ? " *" : ""}</text>
        ))}
      </scrollbox>
      <MouseSelect focused height={3} options={[{ name: "Back", description: "Return to endpoints", value: "back" }]} onSelect={(_, option) => { if (option?.value === "back") showDialog({ kind: "debug-endpoints" }) }} wrapSelection showDescription />
    </>
  )
}

function FileSendDialogContent({ dialog, dialogWidth, selection, peers, groups, dialogDraft, setDialogDraft, sendFile }: { dialog: Extract<Dialog, { kind: "file-send" }>; dialogWidth: number; selection: { kind: "peer" | "group"; id: string } | undefined; peers: Peer[]; groups: Group[]; dialogDraft: string; setDialogDraft: (v: string) => void; sendFile: (path: string) => void }) {
  const targetName = selection?.kind === "peer" ? peers.find((p) => p.peer_id === selection.id)?.display_name ?? selection.id.slice(0, 8) : groups.find((g) => g.group_id === selection?.id)?.name ?? "group"
  return (
    <>
      <text>Enter full file path to send to <span fg="#66dd88">{targetName}</span></text>
      <MarqueeText width={dialogWidth - 4} fg="#888888" text="Works cross-platform. Windows: C:\\path\\to\\file  macOS/Linux: /path/to/file" />
      <input focused value={dialogDraft} placeholder={process.platform === "win32" ? "C:\\Users\\you\\Documents\\file.txt" : "/home/you/file.txt"} onInput={setDialogDraft} onSubmit={(value) => void sendFile(typeof value === "string" ? value : dialogDraft)} maxLength={4096} />
      <MarqueeText width={dialogWidth - 4} fg="#888888" text="Enter sends. Path must be readable by the MeshTalk backend. Files up to 50 MiB." />
    </>
  )
}

function FileListDialogContent({ dialog, dialogHeight, dialogWidth, imageProtocol, loadFiles, loadFilesDir, setDialogDraft, showDialog, defaultDownloadPath }: { dialog: Extract<Dialog, { kind: "file-list" }>; dialogHeight: number; dialogWidth: number; imageProtocol: ImageProtocol; loadFiles: () => void; loadFilesDir: () => void; setDialogDraft: (v: string) => void; showDialog: (d: Dialog) => void; defaultDownloadPath: (filename: string) => string }) {
  return (
    <>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}>
        {!dialog.files.length && <text fg="#888888">No file transfers yet.</text>}
        {dialog.files.map((f) => (
          <box key={f.file_id} style={{ flexDirection: "column", paddingBottom: 1 }}>
            <text><span fg={f.direction === "inbound" ? "#66dd88" : "#65a9ff"}>{f.direction === "inbound" ? "\u2193" : "\u2191"}</span> {f.filename} ({(f.file_size / 1024).toFixed(1)} KiB) <span fg="#888888">{f.status}</span></text>
            <text fg="#888888">  {f.file_id.slice(0, 8)} {f.direction === "inbound" ? `from ${f.sender_id.slice(0, 8)}` : `to ${f.recipient_id.slice(0, 8)}`} {f.file_path ?? ""} {isImageFile(f.filename) ? "(image)" : ""}</text>
            {["completed", "sent"].includes(f.status) && isLocalFileMissing(f.file_path) ? <text fg="#ff7777">  File unavailable: not found or deleted locally</text> : null}
            {f.status === "completed" && f.file_path && !isLocalFileMissing(f.file_path) ? <ImageAttachment filePath={f.file_path} filename={f.filename} protocol={imageProtocol} expectedImage={isImageFile(f.filename)} lazy={false} maxWidth={Math.max(12, dialogWidth - 4)} maxHeight={Math.max(4, Math.floor(dialogHeight / 2))} onOpen={() => showDialog({ kind: "image-view", filePath: f.file_path!, filename: f.filename, version: f.completed_at, returnTo: "files" })} /> : null}
          </box>
        ))}
      </scrollbox>
      <MouseSelect focused height={Math.max(0, Math.min(8, dialogHeight - 4))} options={[
        ...dialog.files.filter((f) => f.status === "completed" || f.status === "sent").map((f) => ({
          name: `Save ${f.filename} to...`, description: `${f.file_id.slice(0, 8)} -> choose destination`, value: `dl:${f.file_id}`,
        })),
        { name: "Storage location", description: "View/change where received files are saved (e.g., E:\\ drive)", value: "storage" },
        { name: "Refresh", description: "Reload file list", value: "refresh" },
         { name: "Back", description: "Return to Commands", value: "back" },
      ]} marqueeNames width={Math.max(1, dialogWidth - 4)} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "refresh") void loadFiles()
        else if (option.value === "back") showDialog({ kind: "commands" })
        else if (option.value === "storage") void loadFilesDir()
        else if (option.value.startsWith("dl:")) {
          const fid = option.value.slice(3)
          const f = dialog.files.find((x) => x.file_id === fid)
          if (f) { setDialogDraft(defaultDownloadPath(f.filename)); showDialog({ kind: "file-download", fileId: f.file_id, filename: f.filename, filePath: f.file_path ?? "" }) }
        }
      }} wrapSelection showDescription />
    </>
  )
}

function FilesDirDialogContent({ dialog, dialogWidth, dialogDraft, setDialogDraft, setFilesDir, loadFiles }: { dialog: Extract<Dialog, { kind: "files-dir" }>; dialogWidth: number; dialogDraft: string; setDialogDraft: (v: string) => void; setFilesDir: (path: string) => void; loadFiles: () => void }) {
  return (
    <>
      <text>Files storage directory (cross-platform):</text>
      <text fg="#66dd88" wrapMode="word">{dialog.filesDir}</text>
      {dialog.env && <MarqueeText width={dialogWidth - 4} fg="#e0a34a" text={`Overridden by MESHTALK_FILES_DIR=${dialog.env} (env var takes precedence)`} />}
      {dialog.configured && !dialog.env && <text fg="#888888">Custom (from settings.json)</text>}
      {!dialog.configured && !dialog.env && <text fg="#888888">Default: {dialog.dataDir}/files</text>}
      <MarqueeText width={dialogWidth - 4} fg="#888888" text="Examples: Windows E:\\MeshTalkFiles  Linux /mnt/e/MeshTalkFiles  macOS /Volumes/E/MeshTalkFiles" />
      <input focused value={dialogDraft} placeholder="E:\MeshTalkFiles" onInput={setDialogDraft} onSubmit={(v) => void setFilesDir(typeof v === "string" ? v : dialogDraft)} maxLength={4096} />
      <text fg="#888888">Enter saves. New files go there; existing files stay in old location.</text>
      <MouseSelect focused={false} height={3} options={[{ name: "Back to files", description: "Return to file list", value: "back" }]} onSelect={() => void loadFiles()} />
    </>
  )
}

function FileDownloadDialogContent({ dialog, dialogWidth, dialogDraft, setDialogDraft, downloadFile, defaultDownloadPath }: { dialog: Extract<Dialog, { kind: "file-download" }>; dialogWidth: number; dialogDraft: string; setDialogDraft: (v: string) => void; downloadFile: (fileId: string, destPath: string) => void; defaultDownloadPath: (filename: string) => string }) {
  return (
    <>
      <MarqueeText width={dialogWidth - 4} text={`Save ${dialog.filename} to:`} />
      <MarqueeText width={dialogWidth - 4} fg="#888888" text={dialog.filePath} />
      <input focused value={dialogDraft} placeholder={defaultDownloadPath(dialog.filename)} onInput={setDialogDraft} onSubmit={(v) => void downloadFile(dialog.fileId, typeof v === "string" ? v : dialogDraft)} maxLength={4096} />
      <MarqueeText width={dialogWidth - 4} fg="#888888" text="Enter saves. Works on Linux/macOS/Windows. Path may be folder or file." />
    </>
  )
}
