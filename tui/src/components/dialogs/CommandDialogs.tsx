import { MouseSelect } from "../MouseSelect"
import { MarqueeText } from "../MarqueeText"
import type { Conversation, Dialog, Group, Peer } from "../../types"

type CommandsDialogProps = {
  dialogHeight: number
  groups: Group[]
  peers: Peer[]
  selectedGroup: Group | undefined
  selection: Conversation | undefined
  runCommand: (command: string) => void
}

export function CommandsDialog({ dialogHeight, groups, peers, selectedGroup, selection, runCommand }: CommandsDialogProps) {
  return <box style={{ flexDirection: "column" }}>
    <box height={1} flexShrink={0}><text><span fg="#b9a7ff"><b>COMMAND CENTER</b></span> <span fg="#77718f">Choose an action</span></text></box>
    <box height={1} flexShrink={0}><text fg="#534b70">────────────────────────────────────────</text></box>
    <MouseSelect focused height={Math.max(5, dialogHeight - 5)} options={[
      { name: "Control server", description: "Set up or inspect remote discovery", value: "control" },
      { name: "Private rooms", description: "Create, join, view, or leave rooms", value: "rooms" },
      ...(selectedGroup ? [{ name: "Group details", description: `View members or leave ${selectedGroup.name}`, value: "group-details" }] : []),
      { name: "Friends", description: "Add a friend, respond to requests, remove, or block", value: "friends" },
      { name: "Send file", description: selection ? `Send a file to ${selection.kind === "peer" ? peers.find((peer) => peer.peer_id === selection.id)?.display_name ?? "peer" : groups.find((group) => group.group_id === selection.id)?.name ?? "group"}` : "Select a peer or group first", value: "send-file" },
      { name: "Files", description: "View file transfer history and status", value: "files" },
      { name: "Notifications", description: "Mute or unmute desktop notifications for the selected peer", value: "notifications" },
      { name: "Accessibility", description: "Reduce motion and other accessibility options", value: "accessibility" },
      { name: "Advanced Configuration", description: "Pin server IP addresses to bypass DNS", value: "advanced" },
      { name: "Rename yourself", description: "Change the display name peers see", value: "rename" },
      { name: "Debug", description: "Re-STUN and connection diagnostics", value: "debug" },
      { name: "★  ABOUT & UPDATES  ★", description: "Version, credits, and check for updates", value: "about" },
    ]} onSelect={(_, option) => option && runCommand(option.value as string)} wrapSelection showDescription />
  </box>
}

type AboutDialogProps = {
  appReleaseVersion: string
  dialog: Extract<Dialog, { kind: "about" }>
  dialogError: string
  dialogHeight: number
  dialogWidth: number
  isReleaseBuild: boolean
  checkForUpdates: () => void
  goBack: () => void
}

export function AboutDialog({ appReleaseVersion, dialog, dialogError, dialogHeight, dialogWidth, isReleaseBuild, checkForUpdates, goBack }: AboutDialogProps) {
  return <box style={{ flexDirection: "column", gap: 1, backgroundColor: "#111923", width: "100%", height: "100%" }}>
    <text><span fg="#b9a7ff"><b>MeshTalk</b></span> <span fg="#77718f">terminal messenger</span></text>
    <text><span fg="#8fa7ff">Version </span><span fg="#66ddaa"><b>{appReleaseVersion}</b></span></text>
    <text><span fg="#e0a34a">Made with love</span> <span fg="#bbbbbb">by </span><span fg="#ff8fa3">Raymont</span><span fg="#bbbbbb"> and </span><span fg="#8fa7ff">friends.</span></text>
    {dialog.checked && <MarqueeText width={dialogWidth - 4} fg={isReleaseBuild ? "#66dd88" : "#ff5555"} text={isReleaseBuild ? "You are up to date, or release metadata is unavailable." : "Updates are available only in compiled MeshTalk releases."} />}
    {dialogError && <text fg="#ff7777">{dialogError}</text>}
    <MouseSelect focused height={Math.max(3, dialogHeight - 7)} options={[
      { name: dialog.checking ? "Checking for updates..." : "Check for updates", description: isReleaseBuild ? "Look for the latest stable MeshTalk release" : "Available in compiled MeshTalk releases", value: "check" },
      { name: "Back", description: "Return to Commands", value: "back" },
    ]} onSelect={(_, option) => {
      if (option?.value === "check" && !dialog.checking) checkForUpdates()
      else if (option?.value === "back") goBack()
    }} wrapSelection showDescription />
  </box>
}

type UpdateDialogProps = {
  appReleaseVersion: string
  dialog: Extract<Dialog, { kind: "update" }>
  dialogError: string
  dialogHeight: number
  dialogWidth: number
  closeDialog: () => void
  installUpdate: () => void
}

export function UpdateDialog({ appReleaseVersion, dialog, dialogError, dialogHeight, dialogWidth, closeDialog, installUpdate }: UpdateDialogProps) {
  return <>
    <text><b>MeshTalk {dialog.release.version} is available.</b></text>
    <text fg="#bbbbbb">Installed version: {appReleaseVersion}</text>
    <MarqueeText width={dialogWidth - 4} fg="#bbbbbb" text="The download will be verified with GitHub's SHA-256 digest before installation." />
    {dialogError && <text fg="#ff7777">{dialogError}</text>}
    <MouseSelect focused height={Math.max(3, dialogHeight - 7)} options={[
      { name: "Install now", description: "Close MeshTalk and install the verified release", value: "install" },
      { name: "Ignore", description: "Ask again the next time MeshTalk starts", value: "ignore" },
    ]} onSelect={(_, option) => {
      if (option?.value === "install") installUpdate()
      else if (option?.value === "ignore") closeDialog()
    }} wrapSelection showDescription />
  </>
}
