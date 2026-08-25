import type { Conversation, Group, GroupMember, Peer } from "../types"
import { friendMarkers, peerPresence, transportName } from "../utils"

type SidebarProps = {
  activeCount: number
  compact: boolean
  dialogOpen: boolean
  editingName: boolean
  groups: Group[]
  groupMembers: Record<string, GroupMember[]>
  identity: { peer_id: string; display_name: string } | undefined
  mutedPeers: Record<string, number>
  nameDraft: string
  peers: Peer[]
  selectedGroupId: string | undefined
  selectedPeerId: string | undefined
  sidebarWidth: number
  typingConversationKeys: Set<string>
  setEditingName: (value: boolean) => void
  setNameDraft: (value: string) => void
  setSelection: (selection: Conversation) => void
  setScrollFocused: (value: boolean) => void
  saveDisplayName: () => void
}

export function Sidebar({ activeCount, compact, dialogOpen, editingName, groups, groupMembers, identity, mutedPeers, nameDraft, peers, selectedGroupId, selectedPeerId, sidebarWidth, typingConversationKeys, setEditingName, setNameDraft, setSelection, setScrollFocused, saveDisplayName }: SidebarProps) {
  // Outer and section borders/padding consume eight columns; reserve one more for the scrollbar.
  const listContentOptions = { flexDirection: "column" as const, width: Math.max(1, sidebarWidth - 9) }
  return <box title={`You: ${identity?.display_name ?? "..."}`} style={{ border: true, width: sidebarWidth, flexShrink: 0, flexDirection: "column", padding: 1, gap: 1 }}>
    <box onMouseDown={() => setEditingName(true)}>
      {editingName ? <input value={nameDraft} focused={!dialogOpen} placeholder="Display name" onInput={setNameDraft} onSubmit={saveDisplayName} maxLength={48} /> : <><text fg="#888888">Click to rename</text><text fg="#888888">{identity?.peer_id.slice(0, 12)}</text></>}
    </box>
    <box title={`Peers: ${activeCount} active`} bottomTitle="Ctrl+D removes offline" style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 3, flexDirection: "column", padding: 1 }}>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={listContentOptions} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}>
        {!peers.length ? <text fg="#888888">No peers discovered</text> : null}
        {peers.map((peer) => {
          const presence = peerPresence(peer)
          const limited = Boolean(peer.capability_gap)
          const muted = peer.peer_id in mutedPeers
          return <box key={peer.peer_id} onMouseDown={() => { setSelection({ kind: "peer", id: peer.peer_id }); setScrollFocused(false); setEditingName(false) }} style={{ width: "100%", flexDirection: "column", backgroundColor: peer.peer_id === selectedPeerId ? "#25354d" : undefined }}>
            <box style={{ width: "100%", flexDirection: "row" }}><text wrapMode="word" style={{ flexGrow: 1, flexShrink: 1 }} fg={presence === "active" ? "#66dd88" : presence === "away" ? "#e0a34a" : "#888888"}>{peer.peer_id === selectedPeerId ? "> " : "  "}{compact ? peer.display_name.slice(0, 10) : peer.display_name} {presence}{limited ? <span fg="#ff9f43"> LIMITED</span> : null}{peer.unread_count ? ` (${peer.unread_count} new)` : ""}{friendMarkers(peer)}{muted ? " M" : ""}</text>{typingConversationKeys.has(`peer:${peer.peer_id}`) && <spinner name="simpleDotsScrolling" color="#7aa2d6" />}</box>
            {peer.endpoints.length ? peer.endpoints.map((endpoint) => <text key={`${endpoint.transport}-${endpoint.endpoint}`} wrapMode="word" fg={endpoint.active ? "#7aa2d6" : "#718096"}>{endpoint.active ? "* " : "  "}{transportName(endpoint.transport)} {endpoint.endpoint}</text>) : <text fg="#718096">No known endpoint</text>}
          </box>
        })}
      </scrollbox>
    </box>
    <box title={`Groups: ${groups.length}`} style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 3, flexDirection: "column", padding: 1 }}>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={listContentOptions} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "#6ea8fe", backgroundColor: "#24344d" } }}>
        {!groups.length ? <text fg="#888888">No groups joined</text> : null}
        {groups.map((group) => <box key={group.group_id} onMouseDown={() => { setSelection({ kind: "group", id: group.group_id }); setScrollFocused(false); setEditingName(false) }} style={{ width: "100%", flexDirection: "column", backgroundColor: group.group_id === selectedGroupId ? "#25354d" : undefined }}>
          <box style={{ width: "100%", flexDirection: "row" }}><text wrapMode="word" style={{ flexGrow: 1, flexShrink: 1 }} fg="#b69cff">{group.group_id === selectedGroupId ? "> " : "  "}{compact ? group.name.slice(0, 14) : group.name}{group.unread_count ? ` (${group.unread_count} new)` : ""}</text>{typingConversationKeys.has(`group:${group.group_id}`) && <spinner name="simpleDotsScrolling" color="#7aa2d6" />}</box>
          <text fg="#718096">  {group.member_count} member{group.member_count === 1 ? "" : "s"}</text>
          {group.group_id === selectedGroupId && groupMembers[group.group_id]?.filter((member) => member.show_in_sidebar !== false).map((member, index) => {
            const memberId = member.peer_id ?? member.member_id
            const knownPeer = peers.find((peer) => peer.peer_id === memberId)
            const color = memberId === identity?.peer_id ? "#65a9ff" : knownPeer ? peerPresence(knownPeer) === "active" ? "#66dd88" : peerPresence(knownPeer) === "away" ? "#e0a34a" : "#888888" : member.is_online ? "#66dd88" : "#888888"
            return <text key={memberId ?? String(index)} wrapMode="word" fg={color}>{"    "}{compact ? member.display_name.slice(0, 12) : member.display_name}</text>
          })}
        </box>)}
      </scrollbox>
    </box>
  </box>
}
