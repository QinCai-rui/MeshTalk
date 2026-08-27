import { MarqueeText } from "../MarqueeText"
import { MouseSelect } from "../MouseSelect"
import type { Conversation, Dialog, Peer } from "../../types"
import type { NotificationDelivery, NotificationEvent, NotificationPreferences } from "../../notifications"

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
  if (dialog.kind === "notification-enable") return <><MarqueeText width={dialogWidth - 4} fg="#bbbbbb" text={dialogBusy ? "Switch to another terminal tab now. The test will be sent in four seconds." : "Would you like MeshTalk to send desktop notifications?"} /><MouseSelect focused height={Math.max(4, dialogHeight - 5)} options={[{ name: "Enable and test", description: "Send a test through your terminal notification protocol", value: "enable" }, { name: "Not now", description: "Keep desktop notifications off; configure them later in Commands", value: "disable" }]} onSelect={(_, option) => { if (option?.value === "enable") testNotificationDelivery("terminal", dialog.firstRun); else if (option?.value === "disable") disableNotifications(dialog.firstRun) }} wrapSelection showDescription /></>
  if (dialog.kind === "notification-confirm") return <><MarqueeText width={dialogWidth - 4} fg="#bbbbbb" text={`A test notification was sent using ${dialog.delivery === "terminal" ? "your terminal" : "your operating system"}.`} />{dialog.delivery === "native" && process.platform === "darwin" && <MarqueeText width={dialogWidth - 4} fg="#e0a34a" text="macOS can suppress banners in Focus mode or when terminal-notifier, Script Editor, or osascript alerts are disabled in System Settings > Notifications." />}<MouseSelect focused height={Math.max(4, dialogHeight - (dialog.delivery === "native" && process.platform === "darwin" ? 7 : 5))} options={[{ name: "I received it", description: "Use this notification method", value: "confirm" }, { name: "I did not receive it", description: dialog.delivery === "terminal" ? "Try your operating system's native notification method" : "Leave notifications disabled", value: "missing" }]} onSelect={(_, option) => { if (option?.value === "confirm") confirmNotificationDelivery(dialog.delivery, dialog.firstRun); else if (option?.value === "missing" && dialog.delivery === "terminal") showDialog({ kind: "notification-fallback", firstRun: dialog.firstRun }); else if (option?.value === "missing") disableNotifications(dialog.firstRun) }} wrapSelection showDescription /></>
  if (dialog.kind === "notification-fallback") return <><MarqueeText width={dialogWidth - 4} fg="#e0a34a" text="Terminal notifications are unavailable or were not received. Try a native desktop notification instead." />{dialogError && <text fg="#ff7777">{dialogError}</text>}<MouseSelect focused height={Math.max(4, dialogHeight - 6)} options={[{ name: "Test native notification", description: "Use macOS, Linux, or Windows notification support", value: "test" }, { name: "Disable notifications", description: "You can configure this later in Commands Menu", value: "disable" }]} onSelect={(_, option) => { if (option?.value === "test") testNotificationDelivery("native", dialog.firstRun); else if (option?.value === "disable") disableNotifications(dialog.firstRun) }} wrapSelection showDescription /></>
  if (dialog.kind === "notifications") return <NotificationMenu dialogHeight={dialogHeight} peers={peers} selectedPeerId={selectedPeerId} identity={identity} mutedPeers={mutedPeers} showDialog={showDialog} />
  if (dialog.kind === "notification-settings") return <NotificationSettings dialogBusy={dialogBusy} dialogHeight={dialogHeight} dialogWidth={dialogWidth} notificationPreferences={notificationPreferences} notificationTestDelivery={notificationTestDelivery} notificationEventEnabled={(event) => Boolean(notificationPreferences?.events[event])} showDialog={showDialog} testNotificationDelivery={testNotificationDelivery} toggleNotificationEvent={toggleNotificationEvent} />
  return <NotificationPeer dialogHeight={dialogHeight} peers={peers} selectedPeerId={selectedPeerId} identity={identity} mutedPeers={mutedPeers} showDialog={showDialog} runCommand={runCommand} />
}

function NotificationMenu({ dialogHeight, peers, selectedPeerId, identity, mutedPeers, showDialog }: Pick<Props, "dialogHeight" | "peers" | "selectedPeerId" | "identity" | "mutedPeers" | "showDialog">) {
  const peer = peers.find((item) => item.peer_id === selectedPeerId)
  const isMuted = peer ? !!mutedPeers[peer.peer_id] : false
  return <>{!peer && <text fg="#888888">Select a peer in the sidebar first.</text>}{peer && peer.peer_id === identity?.peer_id && <text fg="#888888">You cannot mute or unmute yourself.</text>}{peer && peer.peer_id !== identity?.peer_id && !peer.is_online && !isMuted && <text fg="#888888">{peer.display_name} is not online.</text>}<MouseSelect focused height={Math.max(5, dialogHeight - 4)} options={[{ name: "Desktop alerts", description: "Delivery method, test alert, and alert types", value: "desktop" }, { name: "Selected peer alerts", description: selectedPeerId ? "Mute or unmute the selected peer" : "Select a peer first to manage their alerts", value: "peer" }, { name: "Back to Commands", description: "Return to Commands", value: "back" }]} onSelect={(_, option) => { if (option?.value === "desktop") showDialog({ kind: "notification-settings" }); else if (option?.value === "peer") showDialog({ kind: "notification-peer" }); else if (option?.value === "back") showDialog({ kind: "commands" }) }} wrapSelection showDescription /></>
}

function NotificationSettings({ dialogBusy, dialogHeight, dialogWidth, notificationPreferences, notificationTestDelivery, notificationEventEnabled, showDialog, testNotificationDelivery, toggleNotificationEvent }: Pick<Props, "dialogBusy" | "dialogHeight" | "dialogWidth" | "notificationPreferences" | "notificationTestDelivery" | "showDialog" | "testNotificationDelivery" | "toggleNotificationEvent"> & { notificationEventEnabled: (event: NotificationEvent) => boolean }) {
  const delivery = notificationPreferences?.delivery ?? "disabled"
  const options: { name: string; description: string; value: string }[] = [{ name: delivery === "disabled" ? "Enable desktop notifications" : "Configure delivery method", description: delivery === "disabled" ? "Test terminal or native desktop notifications" : `Current method: ${delivery === "terminal" ? "terminal" : "native OS notification"}`, value: "configure" }]
  if (delivery !== "disabled") { options.push({ name: "Test notification", description: "Send a test using the current delivery method", value: "test" }); for (const [event, label] of [["messages", "Messages"], ["friend_requests", "Friend requests"], ["file_offers", "Incoming files"], ["file_completed", "Completed files"]] as [NotificationEvent, string][]) options.push({ name: `${notificationEventEnabled(event) ? "Disable" : "Enable"} ${label}`, description: `${notificationEventEnabled(event) ? "Stop" : "Allow"} desktop alerts for ${label.toLowerCase()}`, value: `event:${event}` }) }
  options.push({ name: "Back to Notifications", description: "Return to notification options", value: "back" })
  return <>{dialogBusy && notificationTestDelivery === "terminal" && <MarqueeText width={dialogWidth - 4} fg="#e0a34a" text="Switch to another terminal tab now. The test will be sent in four seconds." />}{dialogBusy && notificationTestDelivery === "native" && <text fg="#bbbbbb">Sending a native desktop notification...</text>}<MouseSelect focused height={Math.max(5, dialogHeight - 4)} options={options} onSelect={(_, option) => { if (!option) return; if (option.value === "back") showDialog({ kind: "notifications" }); else if (option.value === "configure") showDialog({ kind: "notification-enable" }); else if (option.value === "test" && delivery !== "disabled") testNotificationDelivery(delivery); else if (option.value.startsWith("event:")) toggleNotificationEvent(option.value.slice("event:".length) as NotificationEvent) }} wrapSelection showDescription /></>
}

function NotificationPeer({ dialogHeight, peers, selectedPeerId, identity, mutedPeers, showDialog, runCommand }: Pick<Props, "dialogHeight" | "peers" | "selectedPeerId" | "identity" | "mutedPeers" | "showDialog" | "runCommand">) {
  const peer = peers.find((item) => item.peer_id === selectedPeerId)
  const muted = peer ? !!mutedPeers[peer.peer_id] : false
  const options: { name: string; description: string; value: string }[] = []
  if (peer && !muted && peer.is_online && peer.peer_id !== identity?.peer_id) options.push({ name: "Mute", description: `Mute notifications from ${peer.display_name}`, value: "mute" })
  if (peer && muted) options.push({ name: "Unmute", description: `Resume notifications from ${peer.display_name}`, value: "unmute" })
  options.push({ name: "Back to Notifications", description: "Return to notification options", value: "back" })
  return <MouseSelect focused height={Math.max(5, dialogHeight - 4)} options={options} onSelect={(_, option) => { if (!option) return; if (option.value === "back") showDialog({ kind: "notifications" }); else runCommand(option.value) }} wrapSelection showDescription />
}
