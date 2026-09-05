import type { MouseSelectOption } from "../MouseSelect"
import type { Conversation, Dialog, Peer } from "../../types"
import type { NotificationDelivery, NotificationEvent, NotificationPreferences } from "../../notifications"
import { SettingsMenu, SettingsNotice, SettingsScreen } from "./SettingsPrimitives"

type Props = {
  dialog: Extract<Dialog, { kind: "notification-enable" | "notification-confirm" | "notification-fallback" | "notifications" | "notification-settings" | "notification-peer" }>
  dialogBusy: boolean
  dialogError: string
  dialogHeight: number
  dialogWidth: number
  identity: { peer_id: string; display_name: string } | undefined
  mutedPeers: Record<string, number>
  notificationPreferences: NotificationPreferences | null
  notificationTestDelivery: Exclude<NotificationDelivery, "disabled"> | null
  peers: Peer[]
  selectedPeerId: string | undefined
  showDialog: (dialog: Dialog) => void
  testNotificationDelivery: (delivery: Exclude<NotificationDelivery, "disabled">, firstRun?: boolean) => void
  disableNotifications: (firstRun?: boolean) => void
  confirmNotificationDelivery: (delivery: Exclude<NotificationDelivery, "disabled">, firstRun?: boolean) => void
  toggleNotificationEvent: (event: NotificationEvent) => void
  runCommand: (command: string) => void
}

export function NotificationDialogs(props: Props) {
  const { dialog, dialogBusy, dialogError, dialogHeight, dialogWidth, identity, mutedPeers, notificationPreferences, notificationTestDelivery, peers, selectedPeerId, showDialog, testNotificationDelivery, disableNotifications, confirmNotificationDelivery, toggleNotificationEvent, runCommand } = props
  if (dialog.kind === "notification-enable") return <SettingsScreen breadcrumb={["Notifications", "Delivery"]} description="Choose whether MeshTalk may send alerts outside the terminal." dialogHeight={dialogHeight}>
    {dialogBusy ? <SettingsNotice tone="warning">Switch to another terminal tab. The test will be sent in four seconds.</SettingsNotice> : null}
    <SettingsMenu dialogHeight={dialogHeight} headerRows={dialogBusy ? 7 : 4} options={[
      { section: "Desktop alerts", name: "Enable and test", description: "Send a test through the terminal notification protocol before saving it.", value: "enable", status: "Recommended", tone: "accent" },
      { section: "Desktop alerts", name: "Keep notifications off", description: "Do not send desktop alerts. You can enable them later from Settings.", value: "disable", status: "Off" },
    ]} onSelect={(option) => { if (option.value === "enable") testNotificationDelivery("terminal", dialog.firstRun); else disableNotifications(dialog.firstRun) }} />
  </SettingsScreen>
  if (dialog.kind === "notification-confirm") return <SettingsScreen breadcrumb={["Notifications", "Confirm test"]} description="Confirm whether the test alert appeared." dialogHeight={dialogHeight}>
    <SettingsNotice tone="success">A test was sent using {dialog.delivery === "terminal" ? "your terminal" : "your operating system"}.</SettingsNotice>
    {dialog.delivery === "native" && process.platform === "darwin" ? <SettingsNotice tone="warning">macOS may suppress banners in Focus mode or when notification helpers are disabled in System Settings.</SettingsNotice> : null}
    <SettingsMenu dialogHeight={dialogHeight} headerRows={dialog.delivery === "native" && process.platform === "darwin" ? 9 : 7} options={[
      { section: "Result", name: "I received it", description: "Save this delivery method and enable desktop alerts.", value: "confirm", tone: "success" },
      { section: "Result", name: "I did not receive it", description: dialog.delivery === "terminal" ? "Try the operating system’s native notification method instead." : "Leave desktop notifications disabled.", value: "missing", tone: "warning" },
    ]} onSelect={(option) => { if (option.value === "confirm") confirmNotificationDelivery(dialog.delivery, dialog.firstRun); else if (dialog.delivery === "terminal") showDialog({ kind: "notification-fallback", firstRun: dialog.firstRun }); else disableNotifications(dialog.firstRun) }} />
  </SettingsScreen>
  if (dialog.kind === "notification-fallback") return <SettingsScreen breadcrumb={["Notifications", "Fallback"]} description="The terminal notification test was not received." dialogHeight={dialogHeight}>
    <SettingsNotice tone="warning">Try a native desktop notification, or leave alerts off.</SettingsNotice>
    {dialogError ? <SettingsNotice tone="danger">{dialogError}</SettingsNotice> : null}
    <SettingsMenu dialogHeight={dialogHeight} headerRows={dialogError ? 9 : 7} options={[
      { section: "Next step", name: "Test native notification", description: "Use the notification support provided by macOS, Linux, or Windows.", value: "test" },
      { section: "Next step", name: "Keep notifications off", description: "Do not send desktop alerts. You can configure this later.", value: "disable", status: "Off" },
    ]} onSelect={(option) => { if (option.value === "test") testNotificationDelivery("native", dialog.firstRun); else disableNotifications(dialog.firstRun) }} />
  </SettingsScreen>
  if (dialog.kind === "notifications") return <NotificationMenu dialogHeight={dialogHeight} peers={peers} selectedPeerId={selectedPeerId} identity={identity} mutedPeers={mutedPeers} showDialog={showDialog} />
  if (dialog.kind === "notification-settings") return <NotificationSettings dialogBusy={dialogBusy} dialogHeight={dialogHeight} dialogWidth={dialogWidth} notificationPreferences={notificationPreferences} notificationTestDelivery={notificationTestDelivery} notificationEventEnabled={(event) => Boolean(notificationPreferences?.events[event])} showDialog={showDialog} testNotificationDelivery={testNotificationDelivery} toggleNotificationEvent={toggleNotificationEvent} />
  return <NotificationPeer dialogHeight={dialogHeight} peers={peers} selectedPeerId={selectedPeerId} identity={identity} mutedPeers={mutedPeers} showDialog={showDialog} runCommand={runCommand} />
}

function NotificationMenu({ dialogHeight, peers, selectedPeerId, identity, mutedPeers, showDialog }: Pick<Props, "dialogHeight" | "peers" | "selectedPeerId" | "identity" | "mutedPeers" | "showDialog">) {
  const peer = peers.find((item) => item.peer_id === selectedPeerId)
  const isMuted = peer ? !!mutedPeers[peer.peer_id] : false
  const peerStatus = !peer ? "No peer selected" : peer.peer_id === identity?.peer_id ? "This is you" : isMuted ? "Muted" : peer.is_online ? "Alerts allowed" : "Offline"
  return <SettingsScreen breadcrumb={["Notifications"]} description="Manage desktop delivery and alerts from the selected peer." dialogHeight={dialogHeight}>
    <SettingsMenu dialogHeight={dialogHeight} options={[
      { section: "General", name: "Desktop alerts", description: "Choose the delivery method, send a test, and select which events trigger alerts.", value: "desktop" },
      { section: "Selected peer", name: peer ? peer.display_name : "Peer alerts", description: !peer ? "Select a peer in the conversation list first." : peer.peer_id === identity?.peer_id ? "Your own notifications cannot be muted." : !peer.is_online && !isMuted ? `${peer.display_name} is offline and cannot be muted until connected.` : "Mute or unmute alerts from this peer.", value: "peer", status: peerStatus, tone: isMuted ? "warning" : peer ? "default" : "warning" },
      { section: "Navigation", name: "Back", description: "Return to Settings.", value: "back" },
    ]} onSelect={(option) => { if (option.value === "desktop") showDialog({ kind: "notification-settings" }); else if (option.value === "peer") showDialog({ kind: "notification-peer" }); else showDialog({ kind: "settings" }) }} />
  </SettingsScreen>
}

function NotificationSettings({ dialogBusy, dialogHeight, dialogWidth, notificationPreferences, notificationTestDelivery, notificationEventEnabled, showDialog, testNotificationDelivery, toggleNotificationEvent }: Pick<Props, "dialogBusy" | "dialogHeight" | "dialogWidth" | "notificationPreferences" | "notificationTestDelivery" | "showDialog" | "testNotificationDelivery" | "toggleNotificationEvent"> & { notificationEventEnabled: (event: NotificationEvent) => boolean }) {
  const delivery = notificationPreferences?.delivery ?? "disabled"
  const options: MouseSelectOption[] = [{ section: "Delivery", name: "Delivery method", description: delivery === "disabled" ? "Enable and test terminal or native desktop notifications." : "Run setup again to choose and test another delivery method.", value: "configure", status: delivery === "disabled" ? "Off" : delivery === "terminal" ? "Terminal" : "Native", tone: delivery === "disabled" ? "warning" : "success" }]
  if (delivery !== "disabled") {
    options.push({ section: "Delivery", name: "Send test notification", description: "Send a test using the saved delivery method.", value: "test", status: dialogBusy ? "Sending" : "Ready", tone: dialogBusy ? "warning" : "default" })
    for (const [event, label] of [["messages", "Messages"], ["friend_requests", "Friend requests"], ["file_offers", "Incoming files"], ["file_completed", "Completed files"]] as [NotificationEvent, string][]) {
      const enabled = notificationEventEnabled(event)
      options.push({ section: "Alert types", name: label, description: `${enabled ? "Send" : "Do not send"} desktop alerts for ${label.toLowerCase()}. Press Enter to toggle.`, value: `event:${event}`, status: enabled ? "On" : "Off", tone: enabled ? "success" : "default" })
    }
  }
  options.push({ section: "Navigation", name: "Back", description: "Return to Notifications.", value: "back", status: "" })
  return <SettingsScreen breadcrumb={["Notifications", "Desktop alerts"]} description="Choose how alerts are delivered and which events trigger them." dialogHeight={dialogHeight}>
    {dialogBusy && notificationTestDelivery === "terminal" ? <SettingsNotice tone="warning">Switch to another terminal tab. The test will be sent in four seconds.</SettingsNotice> : null}
    {dialogBusy && notificationTestDelivery === "native" ? <SettingsNotice>Sending a native desktop notification.</SettingsNotice> : null}
    <SettingsMenu dialogHeight={dialogHeight} headerRows={dialogBusy ? 7 : 4} options={options} onSelect={(option) => { if (option.value === "back") showDialog({ kind: "notifications" }); else if (option.value === "configure") showDialog({ kind: "notification-enable" }); else if (option.value === "test" && delivery !== "disabled") testNotificationDelivery(delivery); else if (option.value.startsWith("event:")) toggleNotificationEvent(option.value.slice("event:".length) as NotificationEvent) }} />
  </SettingsScreen>
}

function NotificationPeer({ dialogHeight, peers, selectedPeerId, identity, mutedPeers, showDialog, runCommand }: Pick<Props, "dialogHeight" | "peers" | "selectedPeerId" | "identity" | "mutedPeers" | "showDialog" | "runCommand">) {
  const peer = peers.find((item) => item.peer_id === selectedPeerId)
  const muted = peer ? !!mutedPeers[peer.peer_id] : false
  const options: MouseSelectOption[] = []
  if (peer && !muted && peer.is_online && peer.peer_id !== identity?.peer_id) options.push({ section: "Selected peer", name: "Notifications from this peer", description: `Mute notifications from ${peer.display_name}.`, value: "mute", status: "On", tone: "success" as const })
  if (peer && muted) options.push({ section: "Selected peer", name: "Notifications from this peer", description: `Resume notifications from ${peer.display_name}.`, value: "unmute", status: "Muted", tone: "warning" as const })
  if (!options.length) options.push({ section: "Selected peer", name: peer?.display_name ?? "No peer selected", description: !peer ? "Select a peer in the conversation list before managing its alerts." : peer.peer_id === identity?.peer_id ? "Your own notifications cannot be muted." : "This peer must be online before notifications can be muted.", value: "back", status: "Unavailable", tone: "warning" as const })
  options.push({ section: "Navigation", name: "Back", description: "Return to Notifications.", value: "back", tone: "default" as const })
  return <SettingsScreen breadcrumb={["Notifications", "Peer alerts"]} description={peer ? `Alert state for ${peer.display_name}.` : "Manage alerts from the selected peer."} dialogHeight={dialogHeight}>
    <SettingsMenu dialogHeight={dialogHeight} options={options} onSelect={(option) => { if (option.value === "back") showDialog({ kind: "notifications" }); else runCommand(option.value as string) }} />
  </SettingsScreen>
}
