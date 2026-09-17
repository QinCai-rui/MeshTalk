import { TypingDots } from "./TypingDots"
import { EmptyState } from "./EmptyState"
import { useEffect, useRef, useState } from "react"
import { useRenderer } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { chatTheme as theme, presenceIndicator } from "../chatTheme"
import type { Conversation, Group, GroupMember, Peer } from "../types"
import { friendMarkers, isMuteActive, peerPresence } from "../utils"
import { HoverHighlight } from "./HoverHighlight"
import { MarqueeText } from "./MarqueeText"

const presenceColor = (presence: "active" | "away" | "offline", dnd = false) =>
  dnd && presence !== "offline" ? theme.presence.dnd : theme.presence[presence]

type SidebarProps = {
  appVersion: string
  stacked?: boolean
  dialogOpen: boolean
  dndEnabled?: boolean
  editingName: boolean
  groups: Group[]
  groupMembers: Record<string, GroupMember[]>
  identity: { peer_id: string; display_name: string } | undefined
  mutedPeers: Record<string, number>
  mutedGroups?: Record<string, number>
  mentionCounts?: Record<string, number>
  nameDraft: string
  peers: Peer[]
  selectedGroupId: string | undefined
  selectedPeerId: string | undefined
  sidebarWidth: number
  typingConversationKeys: Set<string>
  openGroupDetails: (group: Group) => void
  setEditingName: (value: boolean) => void
  setNameDraft: (value: string) => void
  setSelection: (selection: Conversation) => void
  setScrollFocused: (value: boolean) => void
  saveDisplayName: () => void
  friendRequestCount?: number
  onOpenInbox?: () => void
  onAddFriend?: () => void
  onOpenConnection?: () => void
  onOpenLanHelp?: () => void
  onCreateGroup?: () => void
  onJoinGroup?: () => void
}

export function Sidebar({ appVersion, stacked = false, dialogOpen, dndEnabled = false, editingName, groups, groupMembers, identity, mutedPeers, mutedGroups = {}, mentionCounts = {}, nameDraft, peers, selectedGroupId, selectedPeerId, sidebarWidth, typingConversationKeys, openGroupDetails, setEditingName, setNameDraft, setSelection, setScrollFocused, saveDisplayName, friendRequestCount = 0, onOpenInbox, onAddFriend, onOpenConnection, onOpenLanHelp, onCreateGroup, onJoinGroup }: SidebarProps) {
  const renderer = useRenderer()
  const peerListRef = useRef<ScrollBoxRenderable>(null)
  const groupListRef = useRef<ScrollBoxRenderable>(null)
  const [peersHelpDismissed, setPeersHelpDismissed] = useState(false)
  const [groupsHelpDismissed, setGroupsHelpDismissed] = useState(false)
  useEffect(() => {
    const id = selectedPeerId ? `nav-peer-${selectedPeerId}` : selectedGroupId ? `nav-group-${selectedGroupId}` : undefined
    if (!id) return
    const list = selectedPeerId ? peerListRef.current : groupListRef.current
    const reveal = () => list?.scrollChildIntoView(id)
    // Newly mounted rows have no screen coordinates until the first layout pass.
    reveal()
    renderer.once("frame", reveal)
    return () => { renderer.off("frame", reveal) }
  }, [renderer, selectedPeerId, selectedGroupId, stacked])
  const peersById = new Map(peers.map(peer => [peer.peer_id, peer]))
  const pick = (selection: Conversation) => { setSelection(selection); setScrollFocused(false); setEditingName(false) }
  const rowStyle = (selected: boolean) => ({ width: "100%" as const, flexDirection: "column" as const, paddingLeft: 1, paddingRight: 1, backgroundColor: selected ? theme.selected : undefined })
  return <box style={{ width: sidebarWidth, height: stacked ? 8 : "100%", flexShrink: 0, flexDirection: "column", backgroundColor: theme.surface }}>
    <HoverHighlight style={{ paddingLeft: 1, paddingRight: 1, paddingTop: stacked ? 0 : 1, paddingBottom: stacked ? 0 : 1, flexShrink: 0 }} active={editingName} onMouseDown={() => setEditingName(true)}>
      <text fg={theme.accent}><b>MeshTalk</b><span fg={theme.muted}> {appVersion}</span></text>
      {editingName ? <input value={nameDraft} focused={!dialogOpen} placeholder="Display name" onInput={setNameDraft} onSubmit={saveDisplayName} maxLength={48} /> : <MarqueeText width={Math.max(1, sidebarWidth - 2)} fg={theme.text} text={`You: ${identity?.display_name ?? "Connecting..."}`} />}
      {dndEnabled && !editingName && <text fg={theme.presence.dnd} wrapMode="none">● Do Not Disturb on</text>}
      {!stacked && <text fg={theme.muted}>Ctrl+Up/Down switch chats</text>}
    </HoverHighlight>
    {friendRequestCount > 0 && <HoverHighlight paddingLeft={1} paddingRight={1} flexShrink={0} id="sidebar-friend-inbox" onMouseDown={event => { if (event.button === 0) onOpenInbox?.() }}>{hovered => <text fg={hovered ? theme.text : theme.warning} wrapMode="none">Friend requests ({friendRequestCount})</text>}</HoverHighlight>}
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}>
      <box id="sidebar-dm-section" style={{ flexGrow: 3, flexBasis: 0, flexShrink: 1, minHeight: 1, flexDirection: "column" }}>
        <box paddingLeft={1} paddingRight={1} flexShrink={0}><text fg={theme.accent}><b>DMs ({peers.length}) / {peers.filter(peer => peer.is_online).length} online</b></text></box>
        <scrollbox id="sidebar-dms" ref={peerListRef} onMouseDown={() => setScrollFocused(false)} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column", width: Math.max(1, sidebarWidth - 1) }} verticalScrollbarOptions={{ showArrows: true, trackOptions: { foregroundColor: theme.line, backgroundColor: theme.surface }, arrowOptions: { foregroundColor: theme.line } }}>
          {!peers.length && !peersHelpDismissed && <EmptyState id="sidebar-empty-peers" message="No peers yet. LAN discovery is on — local peers appear automatically." detail="LAN-only? You're good. Optionally add a friend or set up remote discovery." compact={stacked} actions={[
            { id: "add", label: "Add friend", hint: "Ctrl+F", onSelect: () => { if (onAddFriend) onAddFriend(); else onOpenInbox?.() } },
            { id: "connection", label: "Connection", hint: "Ctrl+P", onSelect: () => onOpenConnection?.() },
            ...(!stacked ? [{ id: "lan-help", label: "Diagnostics", onSelect: () => onOpenLanHelp?.() } as const] : []),
            { id: "dismiss", label: "Hide", onSelect: () => setPeersHelpDismissed(true) },
          ]} />}
          {!peers.length && peersHelpDismissed && <HoverHighlight paddingLeft={1} onMouseDown={event => { if (event.button === 0) setPeersHelpDismissed(false) }}><text fg={theme.muted} wrapMode="word">Waiting for peers... <span fg={theme.accent}><u>Show tips</u></span></text></HoverHighlight>}
          {peers.map(peer => {
        const selected = peer.peer_id === selectedPeerId
        const presence = peerPresence(peer)
        const peerDnd = Boolean(peer.dnd) && presence !== "offline"
        const color = presenceColor(presence, peer.dnd)
        const markers = friendMarkers(peer)
        const typing = typingConversationKeys.has(`peer:${peer.peer_id}`)
        const isMuted = isMuteActive(mutedPeers[peer.peer_id])
        // Muted rows keep their normal colors; transparency comes from row
        // opacity only. Unread badges and bold emphasis are suppressed so
        // muted chats only move to the top.
        const nameColor = color
        const showUnread = peer.unread_count > 0 && !isMuted
        const flags = [peer.capability_gap && "Limited", isMuted && "Muted", peerDnd && "DND"].filter(Boolean).join(" / ")
        return <HoverHighlight id={`nav-peer-${peer.peer_id}`} key={peer.peer_id} active={selected} onMouseDown={() => pick({ kind: "peer", id: peer.peer_id })} opacity={isMuted ? 0.30 : undefined} style={rowStyle(selected)}>
          <box flexDirection="row" width="100%">
            <MarqueeText width={Math.max(1, sidebarWidth - 2)} fg={nameColor} text={`${selected ? "> " : "  "}${presenceIndicator(presence, peer.dnd)} ${peer.display_name}${markers}`} />
          </box>
          <box height={1} paddingLeft={2} flexDirection="row" gap={1}>
            {showUnread && <text fg={theme.accent}>{peer.unread_count} new</text>}
            {flags.length > 0 && <text fg={theme.muted}>{flags}</text>}
            {typing && <TypingDots />}
          </box>
        </HoverHighlight>
          })}
        </scrollbox>
      </box>
      <box id="sidebar-group-section" style={{ flexGrow: 2, flexBasis: 0, flexShrink: 1, minHeight: 1, flexDirection: "column" }}>
        <box paddingLeft={1} paddingRight={1} flexShrink={0}><text fg={theme.accent}><b>Groups ({groups.length})</b></text></box>
        <scrollbox id="sidebar-groups" ref={groupListRef} onMouseDown={() => setScrollFocused(false)} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column", width: Math.max(1, sidebarWidth - 1) }} verticalScrollbarOptions={{ showArrows: true, trackOptions: { foregroundColor: theme.line, backgroundColor: theme.surface }, arrowOptions: { foregroundColor: theme.line } }}>
          {!groups.length && !groupsHelpDismissed && <EmptyState id="sidebar-empty-groups" message="No groups yet." compact={stacked} actions={[
            { id: "create", label: "Create group", onSelect: () => onCreateGroup?.() },
            { id: "join", label: "Join with invite", onSelect: () => onJoinGroup?.() },
            { id: "dismiss", label: "Hide", onSelect: () => setGroupsHelpDismissed(true) },
          ]} />}
          {!groups.length && groupsHelpDismissed && <HoverHighlight paddingLeft={1} onMouseDown={event => { if (event.button === 0) setGroupsHelpDismissed(false) }}><text fg={theme.muted} wrapMode="word">No groups joined <span fg={theme.accent}><u>Show tips</u></span></text></HoverHighlight>}
          {groups.map(group => {
        const selected = group.group_id === selectedGroupId
        const members = groupMembers[group.group_id]
        // The compact roster is a presence view: retain active and away members,
        // while the overflow count still represents everyone in the group.
        const visibleMembers = members?.filter(member => {
          const id = member.peer_id ?? member.member_id
          const peer = id ? peersById.get(id) : undefined
          return peer ? peerPresence(peer) !== "offline" : Boolean(member.is_online)
        }) ?? []
        const typing = typingConversationKeys.has(`group:${group.group_id}`)
        const otherOnline = visibleMembers.some(member => (member.peer_id ?? member.member_id) !== identity?.peer_id)
        const onlyYouOnline = Boolean(members && visibleMembers.some(member => (member.peer_id ?? member.member_id) === identity?.peer_id) && !otherOnline)
        const memberLabel = ` (${group.member_count} members)`
        const isMuted = isMuteActive(mutedGroups[group.group_id])
        const nameColor = selected ? theme.accent : theme.text
        const mentionCount = mentionCounts[group.group_id] ?? 0
        const showUnread = group.unread_count > 0 && (!isMuted || mentionCount > 0)
        return <HoverHighlight id={`nav-group-${group.group_id}`} key={group.group_id} active={selected} onMouseDown={() => pick({ kind: "group", id: group.group_id })} opacity={isMuted ? 0.30 : undefined} style={rowStyle(selected)}>
          <box flexDirection="row" width="100%">
            <MarqueeText width={Math.max(1, sidebarWidth - 2)} fg={nameColor} text={`${selected ? "> " : "  "}${group.name}${memberLabel}`} />
          </box>
          <box height={1} paddingLeft={2} flexDirection="row" gap={1}>
            {showUnread && <text fg={theme.accent}>{group.unread_count} new</text>}
            {mentionCount > 0 && <text fg={theme.warning}>@{mentionCount} mentioned</text>}
            {isMuted && <text fg={theme.muted}>Muted</text>}
            {selected && onlyYouOnline && !typing && <text fg={theme.muted}>No one else online</text>}
            {typing && <TypingDots />}
          </box>
          {selected && !stacked && visibleMembers.map((member, index) => {
            const id = member.peer_id ?? member.member_id
            const peer = id ? peersById.get(id) : undefined
            const presence = peer ? peerPresence(peer) : member.is_online ? "active" : "offline"
            const memberDnd = peer?.dnd
            return <text key={id ?? index} fg={id === identity?.peer_id ? theme.presence.self : presenceColor(presence, memberDnd)}>  {presenceIndicator(presence, memberDnd)} {member.display_name}{id === identity?.peer_id ? " (you)" : ""}{peer ? friendMarkers(peer) : ""}</text>
          })}
          {selected && members && (() => {
            const hidden = Math.max(0, group.member_count - visibleMembers.length)
            return <HoverHighlight id={`nav-group-more-${group.group_id}`} paddingLeft={2} onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); openGroupDetails(group) } }}>{hovered => <text fg={hovered ? theme.text : theme.accent}>{hidden > 0 ? <u>{`+ ${hidden} more`}</u> : <u>···</u>}</text>}</HoverHighlight>
          })()}
        </HoverHighlight>
          })}
        </scrollbox>
      </box>
    </box>
  </box>
}
