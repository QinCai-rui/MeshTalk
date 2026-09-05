import type { Dialog, AdvancedConfig, BlockedPeer, ControlStatus, DebugInfo, FileTransfer, FriendRequest, Group, GroupDelivery, ImageProtocol, RoomStatus, SplashPreference } from "../types"
import type { NotificationDelivery, NotificationEvent, NotificationPreferences } from "../notifications"
import type { GroupMember, Peer } from "../types"
import type { Release } from "../../../common/updater"
import { MouseSelect } from "./MouseSelect"
import { MarqueeText } from "./MarqueeText"
import { NotificationDialogs } from "./dialogs/NotificationDialogs"
import { AboutDialog, SettingsLanding, UpdateDestinationDialog, UpdateDialog, UpdateTokenDialog } from "./dialogs/CommandDialogs"
import { SettingsConfirm, SettingsField, SettingsMenu, SettingsNotice, SettingsScreen, SettingsSummary } from "./dialogs/SettingsPrimitives"
import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { isImageFile, peerPresence, sortPeersByInteraction } from "../utils"
import { ImageAttachment, isLocalFileMissing } from "./ImageAttachment"
import { chatTheme as theme } from "../chatTheme"
import { SettingsPanel, usesSettingsPanel } from "./dialogs/SettingsPanel"
import { ControlDialogContent, ControlCustomDialogContent, ControlStatusDialogContent, AdvancedDialogContent, CustomisationDialogContent, SplashStyleDialogContent, ImageProtocolDialogContent, IpPinningDialogContent, AdvancedControlDialogContent, AdvancedStunDialogContent, AdvancedControlIpDialogContent, AdvancedStunIpDialogContent } from "./dialogs/PreferenceDialogs"

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
  splashStyle: SplashPreference
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
  onDeleteFile?: (file: FileTransfer) => void

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
  const { dialog, dialogBusy, dialogError, dialogHeight, dialogWidth, dialogDraft, controlStatus, debugInfo, flashingEnabled, imageProtocol, splashStyle, groups, identity, mutedPeers, notificationPreferences, notificationTestDelivery, peers, selected, selectedGroupId, selection, dialogWidthFor, appReleaseVersion, isReleaseBuild } = props
  const { runCommand, showDialog, closeDialog, goBack, setDialogDraft, setDialogError, setNameDraft } = props
  const { configureControl, dismissControlSetup, loadControlStatus, saveAdvancedConfig, setAccessibilityFlashing } = props
  const { createRoom, joinRoom, leaveRoom, loadRoomInvite, loadRooms, copyInvite, leaveGroup, loadGroupDetails } = props
  const { mutePeer, unmutePeer, sendFriendRequest, respondToFriendRequest, cancelFriendRequest, unfriendPeer, loadFriendRequests, loadBlockedPeers, blockPeer, unblockPeer, blockSenderFromRequest } = props
  const { reStun, loadDebugInfo, loadFiles, loadFilesDir, setFilesDir, sendFile, downloadFile, defaultDownloadPath, onDeleteFile } = props
  const { testNotificationDelivery, disableNotifications, confirmNotificationDelivery, toggleNotificationEvent } = props
  const { saveDisplayName, checkForUpdatesFromAbout, installUpdate, saveUpdateToken, restartUpdate } = props

  if (!dialog) return null
  const fileManagerOpen = dialog.kind === "file-list"

  const content = <>
      {dialog.kind === "settings" && <SettingsLanding dialogHeight={dialogHeight} />}
      {dialog.kind === "about" && <AboutDialog appReleaseVersion={appReleaseVersion} dialog={dialog} dialogError={dialogError} dialogHeight={dialogHeight} dialogWidth={dialogWidth} isReleaseBuild={isReleaseBuild} checkForUpdates={checkForUpdatesFromAbout} goBack={goBack} />}
      {dialog.kind === "update" && <UpdateDialog appReleaseVersion={appReleaseVersion} dialog={dialog} dialogError={dialogError} dialogHeight={dialogHeight} dialogWidth={dialogWidth} closeDialog={closeDialog} installing={dialogBusy} installUpdate={installUpdate} restartUpdate={restartUpdate} chooseUpdateDestination={(release) => { setDialogError(""); setDialogDraft(""); showDialog({ kind: "update-directory", release }) }} />}
      {dialog.kind === "update-directory" && <UpdateDestinationDialog dialog={dialog} dialogError={dialogError} dialogWidth={dialogWidth} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} installUpdate={installUpdate} />}
      {dialog.kind === "update-token" && <UpdateTokenDialog dialog={dialog} dialogError={dialogError} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} saveUpdateToken={saveUpdateToken} />}
      {dialog.kind === "control" && <ControlDialogContent dialog={dialog} dialogHeight={dialogHeight} configureControl={configureControl} dismissControlSetup={dismissControlSetup} loadControlStatus={loadControlStatus} showDialog={showDialog} />}
      {dialog.kind === "control-custom" && <ControlCustomDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} configureControl={configureControl} />}
      {dialog.kind === "control-status" && <ControlStatusDialogContent dialog={dialog} showDialog={showDialog} />}
       {dialog.kind === "advanced" && <AdvancedDialogContent dialog={dialog} dialogHeight={dialogHeight} showDialog={showDialog} />}
       {dialog.kind === "advanced-image-protocol" && <ImageProtocolDialogContent dialog={dialog} dialogHeight={dialogHeight} saveAdvancedConfig={saveAdvancedConfig} showDialog={showDialog} />}
       {dialog.kind === "customisation" && <CustomisationDialogContent splashStyle={splashStyle} dialogHeight={dialogHeight} showDialog={showDialog} />}
       {dialog.kind === "customisation-splash" && <SplashStyleDialogContent splashStyle={splashStyle} dialogHeight={dialogHeight} saveAdvancedConfig={saveAdvancedConfig} showDialog={showDialog} />}
      {dialog.kind === "advanced-ip-pinning" && <IpPinningDialogContent dialog={dialog} dialogHeight={dialogHeight} showDialog={showDialog} />}
      {dialog.kind === "advanced-control" && <AdvancedControlDialogContent dialog={dialog} dialogHeight={dialogHeight} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} showDialog={showDialog} />}
      {dialog.kind === "advanced-stun" && <AdvancedStunDialogContent dialog={dialog} dialogHeight={dialogHeight} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} showDialog={showDialog} />}
      {dialog.kind === "advanced-control-ip" && <AdvancedControlIpDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} />}
      {dialog.kind === "advanced-stun-ip" && <AdvancedStunIpDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} saveAdvancedConfig={saveAdvancedConfig} />}
      {dialog.kind === "rooms" && <RoomsDialogContent dialog={dialog} dialogHeight={dialogHeight} loadRooms={loadRooms} showDialog={showDialog} />}
      {dialog.kind === "room-create" && <RoomCreateDialogContent dialogHeight={dialogHeight} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} createRoom={createRoom} />}
      {dialog.kind === "room-join" && <RoomJoinDialogContent dialogHeight={dialogHeight} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} joinRoom={joinRoom} />}
      {dialog.kind === "room-created" && <RoomCreatedDialogContent dialog={dialog} dialogHeight={dialogHeight} copyInvite={copyInvite} loadRooms={loadRooms} />}
      {dialog.kind === "room-detail" && <RoomDetailDialogContent dialog={dialog} dialogHeight={dialogHeight} groups={groups} leaveGroup={leaveGroup} leaveRoom={leaveRoom} loadRoomInvite={loadRoomInvite} loadRooms={loadRooms} />}
       {dialog.kind === "group-detail" && <GroupDetailDialogContent dialog={dialog} identity={identity} peers={peers} closeDialog={closeDialog} leaveGroup={leaveGroup} />}
      {dialog.kind === "rename" && <RenameDialogContent dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} setNameDraft={setNameDraft} saveDisplayName={saveDisplayName} />}
      {dialog.kind === "mute-timeout" && <MuteTimeoutDialogContent dialog={dialog} dialogHeight={dialogHeight} mutePeer={mutePeer} />}
      {dialog.kind === "unmute-confirm" && <UnmuteConfirmDialogContent dialog={dialog} unmutePeer={unmutePeer} showDialog={showDialog} />}
      {dialog.kind === "add-friend" && <AddFriendDialogContent dialog={dialog} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} sendFriendRequest={sendFriendRequest} />}
      {dialog.kind === "remove-friend" && <RemoveFriendDialogContent dialog={dialog} unfriendPeer={unfriendPeer} showDialog={showDialog} />}
      {dialog.kind === "friend-requests" && <FriendRequestsDialogContent dialog={dialog} dialogHeight={dialogHeight} showDialog={showDialog} />}
      {dialog.kind === "friend-request-incoming" && <FriendRequestIncomingDialogContent dialog={dialog} dialogHeight={dialogHeight} blockSenderFromRequest={blockSenderFromRequest} respondToFriendRequest={respondToFriendRequest} />}
      {dialog.kind === "friends" && <FriendsDialogContent dialogHeight={dialogHeight} loadBlockedPeers={loadBlockedPeers} runCommand={runCommand} showDialog={showDialog} />}
      {["notification-enable", "notification-confirm", "notification-fallback", "notifications", "notification-settings", "notification-peer"].includes(dialog.kind) && <NotificationDialogs dialog={dialog as Extract<Dialog, { kind: "notification-enable" | "notification-confirm" | "notification-fallback" | "notifications" | "notification-settings" | "notification-peer" }>} dialogBusy={dialogBusy} dialogError={dialogError} dialogHeight={dialogHeight} dialogWidth={dialogWidth} identity={identity} mutedPeers={mutedPeers} notificationPreferences={notificationPreferences} notificationTestDelivery={notificationTestDelivery} peers={peers} selectedPeerId={selected?.peer_id} showDialog={showDialog} testNotificationDelivery={testNotificationDelivery} disableNotifications={disableNotifications} confirmNotificationDelivery={confirmNotificationDelivery} toggleNotificationEvent={toggleNotificationEvent} runCommand={runCommand} />}
      {dialog.kind === "accessibility" && <AccessibilityDialogContent dialogHeight={dialogHeight} flashingEnabled={flashingEnabled} setAccessibilityFlashing={setAccessibilityFlashing} showDialog={showDialog} />}
      {dialog.kind === "blocked" && <BlockedDialogContent dialog={dialog} dialogHeight={dialogHeight} loadBlockedPeers={loadBlockedPeers} showDialog={showDialog} unblockPeer={unblockPeer} />}
      {dialog.kind === "block-peer-pick" && <BlockPeerPickDialogContent dialogHeight={dialogHeight} peers={peers} identity={identity} loadBlockedPeers={loadBlockedPeers} showDialog={showDialog} />}
      {dialog.kind === "block-peer" && <BlockPeerDialogContent dialog={dialog} blockPeer={blockPeer} loadBlockedPeers={loadBlockedPeers} showDialog={showDialog} />}
      {dialog.kind === "cancel-friend-confirm" && <CancelFriendConfirmDialogContent dialog={dialog} cancelFriendRequest={cancelFriendRequest} loadFriendRequests={loadFriendRequests} showDialog={showDialog} />}
      {dialog.kind === "debug" && <DebugDialogContent dialog={dialog} controlStatus={controlStatus} debugInfo={debugInfo} dialogHeight={dialogHeight} reStun={reStun} loadDebugInfo={loadDebugInfo} showDialog={showDialog} />}
      {dialog.kind === "debug-endpoints" && <DebugEndpointsDialogContent debugInfo={debugInfo} showDialog={showDialog} />}
      {dialog.kind === "debug-peer" && <DebugPeerDialogContent dialog={dialog} debugInfo={debugInfo} showDialog={showDialog} />}
      {dialog.kind === "file-send" && <FileSendDialogContent dialog={dialog} dialogWidth={dialogWidth} selection={selection} peers={peers} groups={groups} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} sendFile={sendFile} />}
      {dialog.kind === "file-list" && <FileListDialogContent dialog={dialog} dialogHeight={dialogHeight} dialogWidth={dialogWidthFor(dialog.kind)} imageProtocol={imageProtocol} peers={peers} groups={groups} loadFiles={loadFiles} loadFilesDir={loadFilesDir} setDialogDraft={setDialogDraft} showDialog={showDialog} defaultDownloadPath={defaultDownloadPath} onDeleteFile={onDeleteFile} />}
      {dialog.kind === "files-dir" && <FilesDirDialogContent dialog={dialog} dialogWidth={dialogWidth} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} setFilesDir={setFilesDir} loadFiles={loadFiles} />}
      {dialog.kind === "file-download" && <FileDownloadDialogContent dialog={dialog} dialogWidth={dialogWidth} dialogHeight={dialogHeight} dialogDraft={dialogDraft} setDialogDraft={setDialogDraft} downloadFile={downloadFile} defaultDownloadPath={defaultDownloadPath} loadFiles={loadFiles} />}
      {dialog.kind === "image-view" && <ImageViewerDialogContent dialog={dialog} dialogWidth={dialogWidthFor(dialog.kind)} dialogHeight={dialogHeight} imageProtocol={imageProtocol} />}
      {dialog.kind === "delivery-details" && <DeliveryDetailsDialogContent dialog={dialog} />}
  </>
  if (usesSettingsPanel(dialog)) return <box position="absolute" left={0} top={0} width="100%" height="100%" backgroundColor={theme.overlay} alignItems="center" justifyContent="center">
    <box width={dialogWidthFor(dialog.kind)} height={dialogHeight} border borderColor={theme.line} backgroundColor={theme.surfaceRaised} paddingX={1} paddingY={dialogHeight > 12 ? 1 : 0}>
      <SettingsPanel dialog={dialog} width={dialogWidthFor(dialog.kind) - 4} height={dialogHeight - 4} busy={dialogBusy} error={dialogError} runCommand={runCommand} goBack={goBack}>{content}</SettingsPanel>
    </box>
  </box>
  return <box position="absolute" left={0} top={0} width="100%" height="100%" backgroundColor={theme.overlay} alignItems="center" justifyContent="center">
    <box width={dialogWidthFor(dialog.kind)} height={dialogHeight} border={!fileManagerOpen} borderColor={theme.line} backgroundColor={fileManagerOpen ? theme.canvas : theme.surfaceRaised} padding={fileManagerOpen ? 0 : 1} gap={fileManagerOpen ? 0 : 1} overflow="hidden" flexDirection="column">
      {content}
    </box>
  </box>
}

function ImageViewerDialogContent({ dialog, dialogWidth, dialogHeight, imageProtocol }: { dialog: Extract<Dialog, { kind: "image-view" }>; dialogWidth: number; dialogHeight: number; imageProtocol: ImageProtocol }) {
  return (
    <>
      <text wrapMode="none"><span fg={theme.success}>{dialog.filename}</span></text>
      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, alignItems: "center", justifyContent: "center" }}>
        <ImageAttachment filePath={dialog.filePath} filename={dialog.filename} protocol={imageProtocol} expectedImage fullSize lazy={false} maxWidth={Math.max(1, dialogWidth - 4)} maxHeight={Math.max(1, dialogHeight - 5)} />
      </box>
      <text fg={theme.muted}>Esc returns.</text>
    </>
  )
}

function DeliveryDetailsDialogContent({ dialog }: { dialog: Extract<Dialog, { kind: "delivery-details" }> }) {
  const statusOrder = ["delivered", "sent", "queued", "pending", "unavailable"]
  const statusColor: Record<string, string> = { delivered: theme.success, sent: theme.markdown.heading, queued: theme.warning, pending: theme.muted, unavailable: theme.danger }
  const grouped = statusOrder.map((status) => [status, dialog.deliveries.filter((delivery) => delivery.status === status)] as const).filter(([, deliveries]) => deliveries.length)
  return <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.link, backgroundColor: theme.surface } }}>
    {!dialog.deliveries.length ? <text fg={theme.muted}>No delivery details are available yet.</text> : null}
    {grouped.map(([status, deliveries]) => <box key={status} style={{ flexDirection: "column", marginBottom: 1 }}>
      <text fg={statusColor[status]}><b>{status[0].toUpperCase() + status.slice(1)} ({deliveries.length})</b></text>
      {deliveries.map((delivery: GroupDelivery) => <text key={delivery.recipient_id}>  {delivery.display_name}</text>)}
    </box>)}
  </scrollbox>
}


function RoomsDialogContent({ dialog, dialogHeight, loadRooms, showDialog }: { dialog: Extract<Dialog, { kind: "rooms" }>; dialogHeight: number; loadRooms: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Private rooms"]} description="Create private spaces or join one with a secret invite." dialogHeight={dialogHeight}>
      {!dialog.rooms.length ? <SettingsNotice>No private rooms are joined on this device yet.</SettingsNotice> : null}
      <SettingsMenu dialogHeight={dialogHeight} headerRows={dialog.rooms.length ? 4 : 7} options={[
        { section: "Rooms", name: "Create private room", description: "Create a room and copy its secret invite.", value: "create", tone: "accent" },
        { section: "Rooms", name: "Join with invite", description: "Paste an invite from someone you trust to join their private room.", value: "join" },
        ...dialog.rooms.map((room) => ({
          section: "Joined rooms",
          name: room.name ?? `Room ${room.room_id.slice(0, 12)}`,
          description: `${room.members} connected. View the invite or leave this room.`,
          value: room.room_id,
          status: `${room.members} connected`,
        })),
      ]} onSelect={(option) => {
        if (option.value === "create") showDialog({ kind: "room-create" })
        else if (option.value === "join") showDialog({ kind: "room-join" })
        else {
          const room = dialog.rooms.find((item) => item.room_id === option.value)
          if (room) showDialog({ kind: "room-detail", room })
        }
      }} />
    </SettingsScreen>
  )
}

function RoomCreateDialogContent({ dialogHeight, dialogDraft, setDialogDraft, createRoom }: { dialogHeight: number; dialogDraft: string; setDialogDraft: (v: string) => void; createRoom: (name: string) => void }) {
  return <SettingsScreen breadcrumb={["Private rooms", "Create"]} description="Give the room a recognisable name before sharing its secret invite." dialogHeight={dialogHeight}><SettingsField label="Room name" description="A name for the people who join this private room" value={dialogDraft} placeholder="Room name" submitHint="Enter creates room" onInput={setDialogDraft} onSubmit={(value) => void createRoom(value)} maxLength={80} /></SettingsScreen>
}

function RoomJoinDialogContent({ dialogHeight, dialogDraft, setDialogDraft, joinRoom }: { dialogHeight: number; dialogDraft: string; setDialogDraft: (v: string) => void; joinRoom: (invite: string) => void }) {
  return <SettingsScreen breadcrumb={["Private rooms", "Join"]} description="Only join rooms using an invite from someone you trust." dialogHeight={dialogHeight}><SettingsField label="Secret invite" description="Paste the invite received from another room member" value={dialogDraft} placeholder="meshtalk:... or meshtalk-group:..." submitHint="Enter joins room" onInput={setDialogDraft} onSubmit={(value) => void joinRoom(value)} maxLength={4096} /></SettingsScreen>
}

function RoomCreatedDialogContent({ dialog, dialogHeight, copyInvite, loadRooms }: { dialog: Extract<Dialog, { kind: "room-created" }>; dialogHeight: number; copyInvite: (invite: string) => void; loadRooms: () => void }) {
  return (
    <SettingsScreen breadcrumb={["Private rooms", dialog.created ? "Invite ready" : "Room invite"]} description="Treat this invite like a room password and share it only with people you trust." dialogHeight={dialogHeight}>
      <SettingsSummary label="Room ID" value={dialog.roomId} />
      <SettingsSummary label="Invite" value={dialog.invite} tone="accent" />
      <SettingsNotice tone={dialog.copied ? "success" : "warning"}>{dialog.copied ? "Copy requested. Paste once to confirm your terminal accepted it." : "Copy the invite before sharing it."}</SettingsNotice>
      <SettingsMenu dialogHeight={dialogHeight} headerRows={10} options={[
        { name: "Copy invite", description: "Copy the secret invite to the clipboard", value: "copy" },
        { name: "Back to rooms", description: "Manage your private rooms", value: "back" },
      ]} onSelect={(option) => option.value === "copy" ? void copyInvite(dialog.invite) : void loadRooms()} />
    </SettingsScreen>
  )
}

function RoomDetailDialogContent({ dialog, dialogHeight, groups, leaveGroup, leaveRoom, loadRoomInvite, loadRooms }: { dialog: Extract<Dialog, { kind: "room-detail" }>; dialogHeight: number; groups: Group[]; leaveGroup: (g: Group) => void; leaveRoom: (roomId: string) => void; loadRoomInvite: (roomId: string) => void; loadRooms: () => void }) {
  return (
    <SettingsScreen breadcrumb={["Private rooms"]} description="Manage this room’s invite and connection status." dialogHeight={dialogHeight}>
      <SettingsSummary label="Room" value={dialog.room.name ?? `Room ${dialog.room.room_id.slice(0, 12)}`} />
      <SettingsSummary label="Room ID" value={dialog.room.room_id} />
      <SettingsSummary label="Connected" value={String(dialog.room.members)} tone={dialog.room.members ? "success" : "warning"} />
      <SettingsNotice tone="warning">Leaving removes this room and its secret from this device.</SettingsNotice>
      <SettingsMenu dialogHeight={dialogHeight} headerRows={10} options={[
        { name: "Keep room", description: "Return without making changes", value: "keep" },
        { name: "Copy invite", description: "Reveal and copy this room's secret invite", value: "copy" },
        { name: "Leave room", description: "Permanently remove this room from this device", value: "leave", tone: "danger" },
      ]} onSelect={(option) => {
        if (option.value === "leave") { const group = groups.find((item) => item.group_id === dialog.room.group_id); if (group) void leaveGroup(group); else void leaveRoom(dialog.room.room_id) }
        else if (option.value === "copy") void loadRoomInvite(dialog.room.room_id)
        else void loadRooms()
      }} />
    </SettingsScreen>
  )
}

function GroupDetailDialogContent({ dialog, identity, peers, closeDialog, leaveGroup }: { dialog: Extract<Dialog, { kind: "group-detail" }>; identity: { peer_id: string; display_name: string } | undefined; peers: Peer[]; closeDialog: () => void; leaveGroup: (g: Group) => void }) {
  return (
    <>
      <text><span fg={theme.muted}>Name: </span>{dialog.group.name}</text>
      <text><span fg={theme.muted}>Group ID: </span>{dialog.group.group_id}</text>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.link, backgroundColor: theme.surface } }}>
        {!dialog.members.length ? <text fg={theme.muted}>No member details available.</text> : null}
        {dialog.members.map((member, index) => {
          const memberId = member.peer_id ?? member.member_id
          const knownPeer = peers.find((peer) => peer.peer_id === memberId)
          const color = memberId === identity?.peer_id ? theme.presence.self : knownPeer ? peerPresence(knownPeer) === "active" ? theme.success : peerPresence(knownPeer) === "away" ? theme.warning : theme.muted : member.is_online ? theme.success : theme.muted
          return <text key={memberId ?? String(index)}>
            <span fg={color}>{member.display_name}</span>
            <span fg={theme.subdued}> {(memberId ?? "").slice(0, 12)}</span>
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
    <SettingsField label="Display name" description="The name shown to connected peers" value={dialogDraft} placeholder="Display name" onInput={(value) => { setDialogDraft(value); setNameDraft(value) }} onSubmit={(value) => void saveDisplayName(value)} maxLength={48} />
  )
}

function MuteTimeoutDialogContent({ dialog, dialogHeight, mutePeer }: { dialog: Extract<Dialog, { kind: "mute-timeout" }>; dialogHeight: number; mutePeer: (peerId: string, timeout: number) => void }) {
  return (
    <>
      <text>Mute notifications from <span fg={theme.success}>{dialog.displayName}</span>.</text>
      <text fg={theme.muted}>Choose how long notifications will stay muted.</text>
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
  return <SettingsConfirm question={<>Resume notifications from <span fg={theme.accent}>{dialog.displayName}</span>?</>} detail="Desktop notifications from this peer will be allowed again." confirmLabel="Unmute notifications" onConfirm={() => void unmutePeer(dialog.peerId)} onCancel={() => showDialog({ kind: "settings" })} />
}

function AddFriendDialogContent({ dialog, dialogDraft, setDialogDraft, sendFriendRequest }: { dialog: Extract<Dialog, { kind: "add-friend" }>; dialogDraft: string; setDialogDraft: (v: string) => void; sendFriendRequest: (peerId: string, note: string) => void }) {
  return (
    <>
      <text>Send a friend request to <span fg={theme.success}>{dialog.displayName}</span>?</text>
      <text fg={theme.muted}>They must accept before your messages get through.</text>
      <input focused value={dialogDraft} placeholder="Optional note" onInput={setDialogDraft} onSubmit={(value) => void sendFriendRequest(dialog.peerId, typeof value === "string" ? value : dialogDraft)} maxLength={1024} />
      <text fg={theme.muted}>Enter sends the request. Esc backs out.</text>
    </>
  )
}

function RemoveFriendDialogContent({ dialog, unfriendPeer, showDialog }: { dialog: Extract<Dialog, { kind: "remove-friend" }>; unfriendPeer: (peerId: string) => void; showDialog: (d: Dialog) => void }) {
  return <SettingsConfirm question={<>Remove <span fg={theme.accent}>{dialog.displayName}</span> as a friend?</>} detail="Their future messages will be blocked until you accept a new friend request." confirmLabel="Remove friend" destructive onConfirm={() => void unfriendPeer(dialog.peerId)} onCancel={() => showDialog({ kind: "settings" })} />
}

function FriendRequestsDialogContent({ dialog, dialogHeight, showDialog }: { dialog: Extract<Dialog, { kind: "friend-requests" }>; dialogHeight: number; showDialog: (d: Dialog) => void }) {
  const incoming = dialog.requests.filter((request) => request.direction === "incoming")
  const outgoing = dialog.requests.filter((request) => request.direction === "outgoing")
  return (
    <SettingsScreen breadcrumb={["Friends", "Requests"]} description="Review incoming requests and manage the ones you have sent." dialogHeight={dialogHeight}>
      {!dialog.requests.length ? <SettingsNotice>No friend requests are pending.</SettingsNotice> : null}
      <SettingsMenu dialogHeight={dialogHeight} headerRows={dialog.requests.length ? 4 : 7} options={[
          ...incoming.map((request) => ({
            section: "Incoming", name: request.sender_name, description: request.note || "Accept, decline, or block this request.", value: `incoming:${request.request_id}`, status: "Needs response", tone: "accent" as const,
          })),
          ...outgoing.map((request) => ({
            section: "Sent", name: request.recipient_name ?? request.sender_name, description: "Pending. Cancel this request if you no longer want to connect.", value: `outgoing:${request.request_id}`, status: "Pending",
          })),
          { section: "Navigation", name: "Back", description: "Return to Friends.", value: "back" },
        ]} onSelect={(option) => {
          if (!option) return
          if (option.value === "back") showDialog({ kind: "friends" })
          else if (option.value.startsWith("incoming:")) {
            const id = option.value.slice("incoming:".length)
            const request = dialog.requests.find((item) => item.request_id === id)
            if (request) showDialog({ kind: "friend-request-incoming", request })
          } else if (option.value.startsWith("outgoing:")) {
            const id = option.value.slice("outgoing:".length)
            const request = dialog.requests.find((item) => item.request_id === id)
            if (request) showDialog({ kind: "cancel-friend-confirm", requestId: request.request_id, displayName: request.recipient_name ?? request.sender_name })
          }
        }} />
    </SettingsScreen>
  )
}

function FriendRequestIncomingDialogContent({ dialog, dialogHeight, blockSenderFromRequest, respondToFriendRequest }: { dialog: Extract<Dialog, { kind: "friend-request-incoming" }>; dialogHeight: number; blockSenderFromRequest: (request: FriendRequest) => void; respondToFriendRequest: (request: FriendRequest, accept: boolean) => void }) {
  return (
    <SettingsScreen breadcrumb={["Friends", "Requests", dialog.request.sender_name]} description="Choose how MeshTalk should handle this request." dialogHeight={dialogHeight}>
      <SettingsSummary label="From" value={dialog.request.sender_name} tone="accent" />
      {dialog.request.note ? <SettingsNotice>{dialog.request.note}</SettingsNotice> : null}
      <SettingsMenu dialogHeight={dialogHeight} headerRows={dialog.request.note ? 8 : 6} options={[
        { section: "Response", name: "Accept", description: "Become friends and allow direct messages.", value: "accept", tone: "success" },
        { section: "Response", name: "Decline", description: "Reject this friend request.", value: "decline" },
        { section: "Safety", name: "Block sender", description: "Ignore all future friend requests from this person.", value: "block", tone: "danger" },
      ]} onSelect={(option) => {
        if (!option) return
        if (option.value === "block") void blockSenderFromRequest(dialog.request)
        else void respondToFriendRequest(dialog.request, option.value === "accept")
      }} />
    </SettingsScreen>
  )
}

function FriendsDialogContent({ dialogHeight, loadBlockedPeers, runCommand, showDialog }: { dialogHeight: number; loadBlockedPeers: () => void; runCommand: (cmd: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Friends"]} description="Manage trusted peers, requests, and request blocking." dialogHeight={dialogHeight}>
      <SettingsMenu dialogHeight={dialogHeight} options={[
        { section: "Requests", name: "Friend requests", description: "Review incoming requests or cancel your pending requests.", value: "friend-requests" },
        { section: "Selected peer", name: "Add friend", description: "Send a friend request to the peer selected in the conversation list.", value: "add-friend" },
        { section: "Selected peer", name: "Remove friend", description: "Remove the selected friend and block future messages until a new request is accepted.", value: "remove-friend", tone: "warning" },
        { section: "Privacy", name: "Blocked requests", description: "Block a person or unblock a previously blocked requester.", value: "blocked" },
      ]} onSelect={(option) => {
      if (option.value === "blocked") void loadBlockedPeers()
      else runCommand(option.value)
      }} />
    </SettingsScreen>
  )
}

function AccessibilityDialogContent({ dialogHeight, flashingEnabled, setAccessibilityFlashing, showDialog }: { dialogHeight: number; flashingEnabled: boolean; setAccessibilityFlashing: (enabled: boolean) => void; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Accessibility"]} description="Make warning behaviour comfortable and easier to follow." dialogHeight={dialogHeight}>
      <SettingsMenu dialogHeight={dialogHeight} options={[
        { section: "Motion", name: "Flashing warnings", description: `${flashingEnabled ? "Capability and rendezvous warnings may blink." : "Warnings remain static."} Press Enter to toggle.`, value: "toggle-flash", status: flashingEnabled ? "On" : "Off", tone: flashingEnabled ? "warning" : "success" },
        { section: "Navigation", name: "Back", description: "Return to Settings.", value: "back" },
      ]} onSelect={(option) => {
        if (!option) return
        if (option.value === "toggle-flash") void setAccessibilityFlashing(!flashingEnabled)
        else showDialog({ kind: "settings" })
      }} />
    </SettingsScreen>
  )
}

function BlockedDialogContent({ dialog, dialogHeight, loadBlockedPeers, showDialog, unblockPeer }: { dialog: Extract<Dialog, { kind: "blocked" }>; dialogHeight: number; loadBlockedPeers: () => void; showDialog: (d: Dialog) => void; unblockPeer: (peerId: string, displayName: string) => void }) {
  const options = [
    ...dialog.blocked.map((peer) => ({ section: "Blocked people", name: peer.display_name, description: "Allow friend requests from this person again.", value: `unblock:${peer.peer_id}`, status: "Blocked", tone: "warning" as const })),
    { section: "Safety", name: "Block a peer", description: "Ignore future friend requests from a specific person.", value: "block-pick", tone: "danger" as const },
    { section: "Navigation", name: "Back", description: "Return to Friends.", value: "back" },
  ]
  return (
    <SettingsScreen breadcrumb={["Friends", "Blocked people"]} description="Blocked people cannot send friend requests to this device." dialogHeight={dialogHeight}>
      {!dialog.blocked.length ? <SettingsNotice>No people are blocked.</SettingsNotice> : null}
      <SettingsMenu dialogHeight={dialogHeight} headerRows={dialog.blocked.length ? 4 : 7} options={options} onSelect={(option) => {
          if (!option) return
          if (option.value === "block-pick") showDialog({ kind: "block-peer-pick" })
          else if (option.value === "back") showDialog({ kind: "friends" })
          else if (option.value.startsWith("unblock:")) {
            const peer = dialog.blocked.find((item) => `unblock:${item.peer_id}` === option.value)
            if (peer) void unblockPeer(peer.peer_id, peer.display_name)
          }
      }} />
    </SettingsScreen>
  )
}

function BlockPeerPickDialogContent({ dialogHeight, peers, identity, loadBlockedPeers, showDialog }: { dialogHeight: number; peers: Peer[]; identity: { peer_id: string; display_name: string } | undefined; loadBlockedPeers: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Friends", "Blocked people", "Block"]} description="Choose someone whose future friend requests should be ignored." dialogHeight={dialogHeight}>
      <SettingsNotice tone="warning">Blocked people cannot send you friend requests.</SettingsNotice>
      <SettingsMenu dialogHeight={dialogHeight} headerRows={7} options={[
        ...peers.filter((peer) => peer.peer_id !== identity?.peer_id && !peer.is_blocked).map((peer) => ({
          section: "People", name: peer.display_name, description: peer.is_online ? "Online. Block friend requests from this person." : "Offline. Block future friend requests from this person.", value: peer.peer_id, status: peer.is_online ? "Online" : "Offline",
        })),
        { section: "Navigation", name: "Back", description: "Return to Blocked people.", value: "back" },
      ]} onSelect={(option) => {
        if (!option) return
        if (option.value === "back") { showDialog({ kind: "blocked", blocked: [] }); void loadBlockedPeers(); return }
        const peer = peers.find((item) => item.peer_id === option.value)
        if (peer) showDialog({ kind: "block-peer", peerId: peer.peer_id, displayName: peer.display_name })
      }} />
    </SettingsScreen>
  )
}

function BlockPeerDialogContent({ dialog, blockPeer, loadBlockedPeers, showDialog }: { dialog: Extract<Dialog, { kind: "block-peer" }>; blockPeer: (peerId: string, displayName: string) => void; loadBlockedPeers: () => void; showDialog: (d: Dialog) => void }) {
  return <SettingsConfirm question={<>Block friend requests from <span fg={theme.accent}>{dialog.displayName}</span>?</>} detail="Future friend requests from this person will be ignored. You can unblock them later." confirmLabel="Block requests" destructive onConfirm={() => void blockPeer(dialog.peerId, dialog.displayName)} onCancel={() => { showDialog({ kind: "blocked", blocked: [] }); void loadBlockedPeers() }} />
}

function CancelFriendConfirmDialogContent({ dialog, cancelFriendRequest, loadFriendRequests, showDialog }: { dialog: Extract<Dialog, { kind: "cancel-friend-confirm" }>; cancelFriendRequest: (requestId: string) => void; loadFriendRequests: () => void; showDialog: (d: Dialog) => void }) {
  return <SettingsConfirm question={<>Cancel the friend request to <span fg={theme.accent}>{dialog.displayName}</span>?</>} detail="The pending request will be withdrawn and no longer visible to them." confirmLabel="Cancel request" cancelLabel="Keep request" destructive onConfirm={() => void cancelFriendRequest(dialog.requestId)} onCancel={() => { showDialog({ kind: "friend-requests", requests: [] }); void loadFriendRequests() }} />
}

function DebugDialogContent({ dialog, controlStatus, debugInfo, dialogHeight, reStun, loadDebugInfo, showDialog }: { dialog: Extract<Dialog, { kind: "debug" }>; controlStatus: { connected: boolean; reconnect_attempts: number; control_url?: string | null }; debugInfo: DebugInfo | null; dialogHeight: number; reStun: () => void; loadDebugInfo: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <text><span fg={theme.muted}>Control: </span>{controlStatus.connected ? "Connected" : "Disconnected"}{controlStatus.reconnect_attempts ? ` (reconnects: ${controlStatus.reconnect_attempts})` : ""}</text>
      <text><span fg={theme.muted}>STUN server: </span>{debugInfo?.stun_server ?? "..."}</text>
      <MouseSelect focused height={Math.min(8, Math.max(1, dialogHeight - 8))} options={[
        { name: "Re-STUN", description: "Re-query STUN server and republish endpoint cards", value: "re-stun" },
        { name: "Endpoints", description: "View your endpoint and connected peers", value: "endpoints" },
        { name: "Refresh", description: "Reload debug information", value: "refresh" },
         { name: "Back to Settings", description: "Return to Settings", value: "back" },
      ]} onSelect={(_, option) => {
        if (!option) return
        if (option.value === "re-stun") void reStun()
        else if (option.value === "endpoints") { showDialog({ kind: "debug-endpoints" }); void loadDebugInfo() }
        else if (option.value === "refresh") void loadDebugInfo()
        else showDialog({ kind: "settings" })
      }} wrapSelection showDescription />
    </>
  )
}

function DebugEndpointsDialogContent({ debugInfo, showDialog }: { debugInfo: DebugInfo | null; showDialog: (d: Dialog) => void }) {
  const sortedPeers = debugInfo ? sortPeersByInteraction(debugInfo.peers) : []
  return (
    <>
      {!debugInfo && <text fg={theme.muted}>Loading debug info...</text>}
      {debugInfo && (
        <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.link, backgroundColor: theme.surface } }}>
          <text><span fg={theme.muted}>My public endpoint: </span>{debugInfo.public_endpoint ? `${debugInfo.public_endpoint[0]}:${debugInfo.public_endpoint[1]}` : "None"}</text>
          <text><span fg={theme.muted}>Local TCP port: </span>{debugInfo.local_tcp_port}</text>
          <text fg={theme.muted}>{"─".repeat(40)}</text>
          <text><span fg={theme.muted}>Peers</span></text>
          {sortedPeers.length === 0 && <text fg={theme.muted}>  No peers</text>}
          {sortedPeers.map((peer) => (
            <box key={peer.peer_id} onMouseDown={() => showDialog({ kind: "debug-peer", peerId: peer.peer_id, displayName: peer.display_name })} style={{ width: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
              <text truncate fg={peer.is_online ? theme.success : theme.muted}>{"> "}{peer.display_name} ({peer.peer_id.slice(0, 12)})</text>
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
  if (!peer) return <text fg={theme.muted}>Peer not found (try Refresh)</text>
  return (
    <>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.link, backgroundColor: theme.surface } }}>
        <text><span fg={theme.muted}>Name: </span>{peer.display_name}</text>
        <text><span fg={theme.muted}>Peer ID: </span>{peer.peer_id}</text>
        <text><span fg={theme.muted}>Online: </span>{peer.is_online ? "Yes" : "No"}</text>
        <text><span fg={theme.muted}>Active transport: </span>{peer.active_transport ?? "None"}</text>
        <text><span fg={theme.muted}>Active endpoint: </span>{peer.active_endpoint ?? "None"}</text>
        {peer.capabilities?.length ? <text><span fg={theme.muted}>Capabilities: </span>{peer.capabilities.join(", ")}</text> : null}
        {peer.peer_missing_capabilities?.length ? <text><span fg={theme.muted}>Peer missing: </span>{peer.peer_missing_capabilities.join(", ")}</text> : null}
        {peer.local_missing_capabilities?.length ? <text><span fg={theme.muted}>Unavailable locally: </span>{peer.local_missing_capabilities.join(", ")}</text> : null}
        <text><span fg={theme.muted}>Endpoints:</span></text>
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
      <text>Enter full file path to send to <span fg={theme.success}>{targetName}</span></text>
      <MarqueeText width={dialogWidth - 4} fg={theme.muted} text="Works cross-platform. Windows: C:\\path\\to\\file  macOS/Linux: /path/to/file" />
      <input focused value={dialogDraft} placeholder={process.platform === "win32" ? "C:\\Users\\you\\Documents\\file.txt" : "/home/you/file.txt"} onInput={setDialogDraft} onSubmit={(value) => void sendFile(typeof value === "string" ? value : dialogDraft)} maxLength={4096} />
      <MarqueeText width={dialogWidth - 4} fg={theme.muted} text="Enter sends. Path must be readable by the MeshTalk backend. Files up to 50 MiB." />
    </>
  )
}

export function FileListDialogContent({ dialog, dialogHeight, dialogWidth, imageProtocol, peers, groups, loadFiles, loadFilesDir, setDialogDraft, showDialog, defaultDownloadPath, onDeleteFile }: { dialog: Extract<Dialog, { kind: "file-list" }>; dialogHeight: number; dialogWidth: number; imageProtocol: ImageProtocol; peers: Peer[]; groups: Group[]; loadFiles: () => void; loadFilesDir: () => void; setDialogDraft: (v: string) => void; showDialog: (d: Dialog) => void; defaultDownloadPath: (filename: string) => string; onDeleteFile?: (file: FileTransfer) => void }) {
  const [filter, setFilter] = useState<"all" | "inbound" | "outbound" | "images" | "other">("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FileTransfer | null>(null)
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null)
  const filtered = useMemo(() => {
    let files = [...dialog.files].sort((a, b) => (b.completed_at ?? b.created_at) - (a.completed_at ?? a.created_at))
    if (filter === "inbound") files = files.filter((f) => f.direction === "inbound")
    if (filter === "outbound") files = files.filter((f) => f.direction === "outbound")
    if (filter === "images") files = files.filter((f) => isImageFile(f.filename))
    if (filter === "other") files = files.filter((f) => !isImageFile(f.filename))
    return files
  }, [dialog.files, filter])
  const counts = useMemo(() => ({
    all: dialog.files.length,
    inbound: dialog.files.filter((f) => f.direction === "inbound").length,
    outbound: dialog.files.filter((f) => f.direction === "outbound").length,
    images: dialog.files.filter((f) => isImageFile(f.filename)).length,
    other: dialog.files.filter((f) => !isImageFile(f.filename)).length,
  }), [dialog.files])
  useEffect(() => {
    if (!filtered.length) { setSelectedId(null); return }
    if (!selectedId || !filtered.some((f) => f.file_id === selectedId)) setSelectedId(filtered[0].file_id)
  }, [filtered, selectedId])
  useEffect(() => {
    if (selectedId) scrollboxRef.current?.scrollChildIntoView(selectedId)
  }, [selectedId])
  const selectedFile = filtered.find((f) => f.file_id === selectedId) ?? null
  const canSaveSelected = !!selectedFile && ["completed", "sent"].includes(selectedFile.status) && !isLocalFileMissing(selectedFile.file_path)
  const saveSelected = () => {
    if (!selectedFile || !canSaveSelected) return
    setDialogDraft(defaultDownloadPath(selectedFile.filename))
    showDialog({ kind: "file-download", fileId: selectedFile.file_id, filename: selectedFile.filename, filePath: selectedFile.file_path ?? "" })
  }
  const requestDelete = () => { if (selectedFile) setPendingDelete(selectedFile) }
  const confirmDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    if (onDeleteFile) onDeleteFile(target)
    else loadFiles()
  }
  useKeyboard((key) => {
    if (pendingDelete) {
      if (key.name === "escape") setPendingDelete(null)
      else if (key.name === "return" || key.name === "enter") void confirmDelete()
      return
    }
    const index = filtered.findIndex((f) => f.file_id === selectedId)
    if (key.name === "up" || key.name === "k") { if (index > 0) setSelectedId(filtered[index - 1].file_id) }
    else if (key.name === "down" || key.name === "j") { if (index >= 0 && index < filtered.length - 1) setSelectedId(filtered[index + 1].file_id) }
    else if (key.name === "return" || key.name === "enter" || key.name === "s") saveSelected()
    else if (key.name === "r") loadFiles()
    else if (key.name === "l") loadFilesDir()
    else if (key.name === "d") requestDelete()
  })
  const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  const statusStyle = (status: string) => {
    if (status === "completed") return { color: theme.success, label: "done" }
    if (status === "sent") return { color: theme.presence.self, label: "sent" }
    if (status === "receiving" || status === "sending") return { color: theme.warning, label: status }
    if (status === "failed" || status === "error") return { color: theme.danger, label: "failed" }
    return { color: theme.muted, label: status }
  }
  const chips: { id: typeof filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all }, { id: "inbound", label: "Received", count: counts.inbound },
    { id: "outbound", label: "Sent", count: counts.outbound }, { id: "images", label: "Images", count: counts.images }, { id: "other", label: "Other", count: counts.other },
  ]
  const peerLabel = (peerId: string) => peers.find((peer) => peer.peer_id === peerId)?.display_name ?? peerId.slice(0, 8)
  const transferDirection = (file: FileTransfer) => {
    if (file.direction === "inbound") return `Received from ${peerLabel(file.sender_id)}`
    if (file.group_id) return `Sent to ${groups.find((group) => group.group_id === file.group_id)?.name ?? file.group_id.slice(0, 8)}`
    return `Sent to ${peerLabel(file.recipient_id)}`
  }
  const wide = dialogWidth >= 92
  const renderSelectedImage = (file: FileTransfer, maxWidth: number) => isImageFile(file.filename) && file.status === "completed" && file.file_path && !isLocalFileMissing(file.file_path)
    ? <ImageAttachment filePath={file.file_path} filename={file.filename} protocol={imageProtocol} expectedImage lazy={false} maxWidth={maxWidth} maxHeight={Math.max(4, Math.min(14, dialogHeight - 14))} onOpen={() => showDialog({ kind: "image-view", filePath: file.file_path!, filename: file.filename, version: file.completed_at, returnTo: "files" })} />
    : null
  return <box style={{ width: "100%", height: "100%", minHeight: 0, flexDirection: "column", backgroundColor: theme.canvas }}>
    <box style={{ flexShrink: 0, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: theme.surface }}>
      <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={theme.text}><b>File Manager</b></text>
        <text fg={theme.muted}>{counts.all} transfer{counts.all === 1 ? "" : "s"}</text>
      </box>
      <text fg={theme.muted}>Files shared through MeshTalk</text>
    </box>
    <box style={{ flexDirection: "row", flexWrap: "wrap", gap: 1, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, flexShrink: 0, backgroundColor: theme.surface }}>
      {chips.map((chip) => <box id={`file-filter-${chip.id}`} key={chip.id} onMouseDown={() => setFilter(chip.id)} style={{ height: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: filter === chip.id ? theme.selected : undefined }}>
        <text fg={filter === chip.id ? theme.accent : theme.muted}>{filter === chip.id ? "> " : ""}{chip.label} {chip.count}</text>
      </box>)}
    </box>
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: wide ? "row" : "column", gap: wide ? 1 : 0 }}>
      <scrollbox id="file-manager-list" ref={scrollboxRef} focused style={{ width: wide ? "44%" : "100%", flexGrow: wide ? 0 : 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }} verticalScrollbarOptions={{ showArrows: true, trackOptions: { foregroundColor: theme.line, backgroundColor: theme.canvas }, arrowOptions: { foregroundColor: theme.line } }}>
        {!filtered.length ? <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 2, flexDirection: "column", gap: 1 }}><text fg={theme.text}><b>No {filter === "all" ? "file transfers" : filter} yet</b></text><text fg={theme.muted}>Send a file with /file or receive one from a peer.</text></box> : null}
        {filtered.map((f) => {
          const status = statusStyle(f.status)
          const missing = ["completed", "sent"].includes(f.status) && isLocalFileMissing(f.file_path)
          const selected = f.file_id === selectedId
          const progress = f.total_chunks && f.received_chunks !== undefined ? Math.round(f.received_chunks / f.total_chunks * 100) : undefined
          const direction = transferDirection(f)
          return <box key={f.file_id} id={f.file_id} onMouseDown={() => setSelectedId(f.file_id)} style={{ width: "100%", flexDirection: "column", paddingLeft: 2, paddingRight: 1, paddingTop: 1, paddingBottom: 1, backgroundColor: selected ? theme.selected : undefined }}>
            <box style={{ flexDirection: "row", justifyContent: "space-between", gap: 1 }}>
              <text fg={selected ? theme.accent : theme.text} style={{ flexGrow: 1, flexShrink: 1 }} wrapMode="word">{selected ? "> " : "  "}<b>{f.filename}</b></text>
              <text fg={theme.muted} flexShrink={0}>{formatSize(f.file_size)}</text>
            </box>
            <text fg={theme.muted} wrapMode="word">  {direction}{f.group_id ? " / group" : ""} / <span fg={status.color}>{status.label}</span>{progress !== undefined && !["completed", "sent"].includes(f.status) ? ` / ${progress}%` : ""}</text>
            {missing ? <text fg={theme.danger}>  File unavailable: moved or deleted locally</text> : null}
            {progress !== undefined && !["completed", "sent"].includes(f.status) ? <box style={{ width: "100%", height: 1, backgroundColor: theme.surface }}><box style={{ width: `${Math.min(100, progress)}%`, height: 1, backgroundColor: theme.warning }} /></box> : null}
            {!wide && selected && f.file_path ? <text fg={theme.muted} wrapMode="word">  {f.file_path}</text> : null}
            {!wide && selected ? renderSelectedImage(f, Math.max(12, dialogWidth - 6)) : null}
          </box>
        })}
      </scrollbox>
      {wide && <box id="file-manager-details" style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, padding: 2, backgroundColor: theme.surface }}>
        {!selectedFile ? <text fg={theme.muted}>Select a file to see its details.</text> : (() => {
          const status = statusStyle(selectedFile.status)
          const missing = ["completed", "sent"].includes(selectedFile.status) && isLocalFileMissing(selectedFile.file_path)
          return <>
            <text fg={theme.text} wrapMode="word"><b>{selectedFile.filename}</b></text>
            <text fg={theme.muted}>{formatSize(selectedFile.file_size)} / <span fg={status.color}>{status.label}</span>{isImageFile(selectedFile.filename) ? " / image" : ""}</text>
            <text fg={theme.muted}>{transferDirection(selectedFile)}{selectedFile.group_id ? " / group" : ""}</text>
            <text fg={theme.muted}>Transfer {selectedFile.file_id.slice(0, 8)}</text>
            <box height={1} />
            <text fg={theme.muted}>Local file</text>
            {selectedFile.file_path ? <text fg={missing ? theme.danger : theme.text} wrapMode="word">{selectedFile.file_path}</text> : <text fg={theme.muted}>No local path available</text>}
            {missing ? <text fg={theme.danger}>File unavailable: moved or deleted locally</text> : null}
            <box height={1} />
            {renderSelectedImage(selectedFile, Math.max(12, Math.floor(dialogWidth * 0.5) - 6))}
            <text fg={canSaveSelected ? theme.muted : theme.warning}>{canSaveSelected ? "S saves a copy to another location." : "This file cannot be saved in its current state."}</text>
          </>
        })()}
      </box>}
    </box>
    <box style={{ flexDirection: "row", flexWrap: "wrap", gap: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1, flexShrink: 0, backgroundColor: theme.surface }}>
      <FileManagerAction shortcut="S" label="ave" onPress={saveSelected} disabled={!canSaveSelected} />
      <FileManagerAction shortcut="D" label="elete" onPress={requestDelete} danger />
      <FileManagerAction shortcut="L" label="ocation" onPress={() => void loadFilesDir()} />
      <FileManagerAction shortcut="R" label="efresh" onPress={() => void loadFiles()} />
      <FileManagerAction shortcut="Esc" label=" Back" onPress={() => showDialog({ kind: "settings" })} />
      <text fg={theme.muted}>Up/Down or J/K select</text>
    </box>
    {pendingDelete ? <box style={{ position: "absolute", left: 2, right: 2, top: Math.max(1, Math.floor(dialogHeight / 2) - 3), border: true, borderColor: theme.danger, backgroundColor: theme.dangerSurface, padding: 1, flexDirection: "column", gap: 1 }}>
      <text fg={theme.danger}><b>Delete {pendingDelete.filename} locally?</b></text>
      <text fg={theme.text}>This removes the local file and transfer history. Enter confirms; Esc cancels.</text>
      <box style={{ flexDirection: "row", gap: 1 }}>
        <FileManagerAction shortcut="Enter" label=" Delete" onPress={() => void confirmDelete()} danger />
        <FileManagerAction shortcut="Esc" label=" Cancel" onPress={() => setPendingDelete(null)} />
      </box>
    </box> : null}
  </box>
}

function FileManagerAction({ shortcut, label, onPress, disabled = false, danger = false }: { shortcut: string; label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  const color = disabled ? theme.line : danger ? theme.danger : theme.text
  return <box onMouseDown={disabled ? undefined : onPress} style={{ height: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: disabled ? undefined : danger ? theme.dangerSurface : theme.selected }}>
    <text fg={color}><u>{shortcut}</u>{label}</text>
  </box>
}

function FilesDirDialogContent({ dialog, dialogWidth, dialogDraft, setDialogDraft, setFilesDir, loadFiles }: { dialog: Extract<Dialog, { kind: "files-dir" }>; dialogWidth: number; dialogDraft: string; setDialogDraft: (v: string) => void; setFilesDir: (path: string) => void; loadFiles: () => void }) {
  const isEnv = !!dialog.env
  const isCustom = !!dialog.configured && !isEnv
  const state = isEnv ? { label: "env override", color: theme.warning, background: theme.dangerSurface } : isCustom ? { label: "custom", color: theme.success, background: theme.successSurface } : { label: "default", color: theme.muted, background: theme.surface }
  return <>
    <box style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 1, flexShrink: 0 }}>
      <text><span fg={theme.link}><b>File storage</b></span> <span fg={theme.muted}>· received files</span></text>
      <text fg={theme.subdued}>Enter saves · Esc returns</text>
    </box>
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", gap: 1 }}>
      <box style={{ flexDirection: "column", gap: 1, padding: 1, border: true, borderColor: theme.surface, backgroundColor: theme.canvas }}>
        <box style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <text fg={theme.text}><b>Current location</b></text>
          <box style={{ height: 3, paddingLeft: 1, paddingRight: 1, alignItems: "center", justifyContent: "center", backgroundColor: state.background, border: true, borderColor: theme.surface }}><text fg={state.color}>{state.label}</text></box>
        </box>
        <box style={{ minHeight: 3, paddingLeft: 1, paddingRight: 1, alignItems: "center", border: true, borderColor: theme.selected, backgroundColor: theme.surfaceRaised }}>
          <text fg={theme.text} wrapMode="word"><b>{dialog.filesDir}</b></text>
        </box>
        {isEnv ? <text fg={theme.warning}>MESHTALK_FILES_DIR={dialog.env} takes precedence over this setting.</text> : isCustom ? <text fg={theme.muted}>Custom path saved in settings.json.</text> : <text fg={theme.muted}>Default location: {dialog.dataDir}/files</text>}
      </box>
      <box style={{ flexDirection: "column", gap: 1, padding: 1, border: true, borderColor: theme.surface, backgroundColor: theme.surfaceRaised }}>
        <text fg={theme.text}><b>Change location</b></text>
        <text fg={theme.muted}>New incoming files will be saved here. Existing files stay where they are.</text>
        <input focused value={dialogDraft} placeholder={dialog.filesDir} onInput={setDialogDraft} onSubmit={(value) => void setFilesDir(typeof value === "string" ? value : dialogDraft)} maxLength={4096} />
        <text fg={theme.subdued}>Examples: E:\MeshTalkFiles · /mnt/e/MeshTalkFiles · /Volumes/E/MeshTalkFiles</text>
      </box>
    </box>
    <box style={{ flexDirection: "row", gap: 1, justifyContent: "flex-end", minHeight: 3, flexShrink: 0 }}>
      <box onMouseDown={() => void setFilesDir(dialogDraft)} style={{ height: 3, paddingLeft: 1, paddingRight: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.selected, border: true, borderColor: theme.link }}><text fg={theme.text}>Save location</text></box>
      <box onMouseDown={() => void loadFiles()} style={{ height: 3, paddingLeft: 1, paddingRight: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.surface, border: true, borderColor: theme.surface }}><text fg={theme.text}>Back to files</text></box>
    </box>
  </>
}

function FileDownloadDialogContent({ dialog, dialogWidth, dialogHeight, dialogDraft, setDialogDraft, downloadFile, defaultDownloadPath, loadFiles }: { dialog: Extract<Dialog, { kind: "file-download" }>; dialogWidth: number; dialogHeight: number; dialogDraft: string; setDialogDraft: (v: string) => void; downloadFile: (fileId: string, destPath: string) => void; defaultDownloadPath: (filename: string) => string; loadFiles: () => void }) {
  const isImage = isImageFile(dialog.filename)
  const suggested = defaultDownloadPath(dialog.filename)
  const sourceMissing = !dialog.filePath || isLocalFileMissing(dialog.filePath)
  useKeyboard((key) => { if (key.name === "s") void downloadFile(dialog.fileId, dialogDraft || suggested) })
  return <>
    <box style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 1, flexShrink: 0 }}>
      <text><span fg={theme.link}><b>Save File</b></span> <span fg={theme.muted}>· {dialog.filename}</span></text>
      <text fg={theme.subdued}>Enter saves · Esc back</text>
    </box>
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", gap: 1 }}>
      <box style={{ flexDirection: "column", gap: 1, padding: 1, border: true, borderColor: theme.surface, backgroundColor: theme.canvas }}>
        <text fg={theme.text}><b>Source</b></text>
        <box style={{ flexDirection: "column", padding: 1, border: true, borderColor: theme.selected, backgroundColor: theme.surfaceRaised }}>
          <box style={{ flexDirection: "row", gap: 1 }}>
            <text fg={isImage ? theme.warning : theme.link}>{isImage ? "◉" : "▭"}</text>
            <text><b fg={theme.text}>{dialog.filename}</b> <span fg={theme.subdued}>· {dialog.fileId.slice(0, 8)}</span></text>
          </box>
          {dialog.filePath ? <text fg={theme.subdued} wrapMode="word">{dialog.filePath}</text> : <text fg={theme.muted}>No local path</text>}
          {sourceMissing ? <text fg={theme.danger}>Source unavailable — file was moved or deleted locally</text> : null}
        </box>
        <text fg={theme.muted}>Saving copies the file; the original stays in File Manager.</text>
      </box>
      <box style={{ flexDirection: "column", gap: 1, padding: 1, border: true, borderColor: theme.surface, backgroundColor: theme.surfaceRaised }}>
        <text fg={theme.text}><b>Destination</b></text>
        <text fg={theme.muted}>Folder or full file path. Works on Windows, macOS and Linux.</text>
        <input focused value={dialogDraft} placeholder={suggested} onInput={setDialogDraft} onSubmit={(value) => void downloadFile(dialog.fileId, typeof value === "string" ? value : dialogDraft)} maxLength={4096} />
        <text fg={theme.subdued}>Suggested: {suggested}</text>
      </box>
    </box>
    <box style={{ flexDirection: "row", gap: 1, justifyContent: "flex-end", minHeight: 3, flexShrink: 0 }}>
      <box onMouseDown={() => void downloadFile(dialog.fileId, dialogDraft || suggested)} style={{ height: 3, paddingLeft: 1, paddingRight: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.selected, border: true, borderColor: theme.link }}><text fg={theme.text}><u>S</u>ave</text></box>
      <box onMouseDown={() => void loadFiles()} style={{ height: 3, paddingLeft: 1, paddingRight: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.surface, border: true, borderColor: theme.surface }}><text fg={theme.text}>Back</text></box>
    </box>
  </>
}
