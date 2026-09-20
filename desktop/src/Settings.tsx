import { useEffect, useState } from "react"
import { invoke, request, target, type Conversation, type Row } from "./api"

export function Settings({ selection, onClose, onRefresh, theme, onTheme }: { selection?: Conversation; onClose: () => void; onRefresh: () => Promise<void>; theme: string; onTheme: (theme: string) => void }) {
  const [tab, setTab] = useState("General")
  const [data, setData] = useState<Row>({})
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [update, setUpdate] = useState<Row>()
  async function load() {
    const [identity, control, analytics, notifications, friends, blocked, rooms, preferences, muted, advanced] = await Promise.all([
      request("identity"), request("control"), request("analytics"), request("notifications"), request("friend_requests"), request("blocked_peers"), request("rooms"), invoke<Row>("preferences"), request("muted_peers"), request("advanced_config"),
    ])
    setData({ identity, control, analytics, notifications, friends, blocked, rooms, preferences, muted, advanced })
    setName(identity.display_name); setUrl(control.url ?? "")
  }
  useEffect(() => { void load().catch(e => setError(String(e))) }, [])
  async function act(operation: () => Promise<unknown>) {
    try { await operation(); await load(); await onRefresh(); setError(""); setNotice("Saved") } catch (e) { setError(String(e)) }
  }
  return <div className="overlay"><section className="settings dialog" role="dialog" aria-modal="true" aria-label="Settings">
    <header><h2>Settings</h2><button onClick={onClose} aria-label="Close settings">×</button></header>
    <nav className="tabs">{["General", "People", "Rooms", "Notifications", "Connection", "Diagnostics", "About"].map(item => <button key={item} className={tab === item ? "selected" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="settings-body">
      {tab === "General" && <>
        <form onSubmit={e => { e.preventDefault(); void act(() => request("set_display_name", { display_name: name })) }}><label>Display name<input value={name} maxLength={48} onChange={e => setName(e.target.value)} /></label><button>Save name</button></form>
        <label>When closing the window<select value={data.preferences?.close_mode ?? "ask"} onChange={e => act(() => invoke("preferences", { closeMode: e.target.value }))}><option value="ask">Ask next time</option><option value="quit">Quit completely</option><option value="tray">Keep running in tray</option></select></label>
        <label><input type="checkbox" checked={data.preferences?.autostart ?? false} onChange={e => act(() => invoke("preferences", { autostart: e.target.checked }))} /> Launch at login</label>
        <label>Appearance<select value={theme} onChange={e => onTheme(e.target.value)}><option value="dark">Discord dark</option><option value="light">Discord light</option></select></label>
        <label><input type="checkbox" checked={data.identity?.dnd_enabled ?? false} onChange={e => act(() => request("dnd", { enabled: e.target.checked }))} /> Do not disturb</label>
        <label>Optional analytics<select value={data.analytics?.analytics_level ?? "off"} onChange={e => act(() => request("analytics", { level: e.target.value }))}><option value="off">Off</option><option value="basic">Basic</option><option value="extended">Extended</option></select></label>
        <label><input type="checkbox" checked={data.identity?.flashing_enabled ?? true} onChange={e => act(() => request("accessibility", { flashing_enabled: e.target.checked }))} /> Allow activity animations</label>
        <p className="muted">Identity and message history are shared with the TUI and CLI. Desktop window preferences are stored separately.</p>
      </>}
      {tab === "People" && <>
        {selection && <section className="card"><h3>{selection.name}</h3><div className="actions"><button onClick={() => act(() => request("mute", target(selection)))}>Mute</button><button onClick={() => act(() => request("unmute", target(selection)))}>Unmute</button>{selection.kind === "peer" && <><button onClick={() => act(() => request("unfriend", { peer_id: selection.id }))}>Unfriend</button><button onClick={() => act(() => request("block_peer", { peer_id: selection.id }))}>Block</button></>}</div></section>}
        <h3>Friend requests</h3>{data.friends?.requests?.length === 0 && <p>No pending requests.</p>}{data.friends?.requests?.map((item: Row) => <section className="card" key={item.request_id}><strong>{item.direction === "incoming" ? item.sender_name : item.recipient_name}</strong><p>{item.note}</p><div className="actions">{item.direction === "incoming" ? <><button className="primary" onClick={() => act(() => request("friend_respond", { request_id: item.request_id, accept: true }))}>Accept</button><button onClick={() => act(() => request("friend_respond", { request_id: item.request_id, accept: false }))}>Decline</button></> : <button onClick={() => act(() => request("friend_cancel", { request_id: item.request_id }))}>Cancel request</button>}</div></section>)}
        <h3>Blocked people</h3>{data.blocked?.blocked?.map((item: Row) => <section className="card" key={item.peer_id}>{item.display_name}<button onClick={() => act(() => request("unblock_peer", { peer_id: item.peer_id }))}>Unblock</button></section>)}
      </>}
      {tab === "Rooms" && <>{data.rooms?.rooms?.map((room: Row) => <section className="card" key={room.room_id}><h3>{room.name ?? "Private room"}</h3><p>{room.members} members</p><div className="actions"><button onClick={() => act(async () => { const value = await request("room_invite", { room_id: room.room_id }); setData(current => ({ ...current, invite: value.invite })) })}>Show invite</button><button onClick={() => { if (window.confirm("Leave this room? Local history will be retained.")) void act(() => request(room.group_id ? "group_leave" : "room_leave", room.group_id ? { group_id: room.group_id } : { room_id: room.room_id })) }}>Leave</button></div></section>)}{data.invite && <textarea aria-label="Room invite" readOnly value={data.invite} />}</>}
      {tab === "Notifications" && <>
        <label><input type="checkbox" checked={data.notifications?.delivery !== "disabled"} onChange={e => act(() => request("notifications", { delivery: e.target.checked ? "native" : "disabled", setup_dismissed: true }))} /> Enable desktop notifications</label>
        {Object.entries(data.notifications?.events ?? {}).map(([event, enabled]) => <label key={event}><input type="checkbox" checked={!!enabled} onChange={e => act(() => request("notifications", { events: { [event]: e.target.checked } }))} /> {event.replaceAll("_", " ")}</label>)}
        <p>Notifications show generic activity, never message contents or attachment names.</p><button onClick={() => act(() => invoke("notify", { title: "MeshTalk notifications are working" }))}>Send test notification</button>
      </>}
      {tab === "Connection" && <>
        <form onSubmit={e => { e.preventDefault(); void act(() => request("control", { url, dismiss_setup: true })) }}><label>Control server URL<input placeholder="wss://…" value={url} onChange={e => setUrl(e.target.value)} /></label><p>{data.control?.connected ? "Connected" : "Disconnected"} · STUN {data.control?.stun_server}</p><div className="actions"><button type="button" onClick={() => setUrl("wss://meshtalk-control.qincai.xyz/v1/rendezvous")}>Public server</button><button>Save</button></div></form>
        <h3>Address pinning</h3><p className="muted">Pin current resolved addresses or restore automatic DNS resolution.</p>{["control", "stun"].map(service => <section key={service} className="card"><strong>{service}</strong><p>{data.advanced?.[`${service}_pinned_ips`]?.join(", ") || "Automatic DNS"}</p><button onClick={() => act(() => request("advanced_config", { [`auto_${service}_pinned_ip`]: true }))}>Pin current addresses</button><button onClick={() => act(() => request("advanced_config", { [`clear_${service}_pinned_ip`]: true }))}>Clear pins</button></section>)}
      </>}
      {tab === "Diagnostics" && <><div className="actions"><button onClick={() => act(async () => { const debug = await request("debug_info"); setData(current => ({ ...current, debug })) })}>Refresh diagnostics</button><button onClick={() => act(() => request("debug_re_stun"))}>Refresh network endpoint</button></div>{data.debug && <pre>{JSON.stringify(data.debug, null, 2)}</pre>}<p className="muted">Diagnostics include addresses and peer identifiers. Review before sharing.</p></>}
      {tab === "About" && <><div className="hero">◈</div><h2>MeshTalk {data.preferences?.version}</h2><p>Private peer-to-peer messaging.</p><label>Update channel<select value={data.preferences?.update_channel ?? "stable"} onChange={e => act(() => invoke("preferences", { updateChannel: e.target.value }))}><option value="stable">Stable</option><option value="unstable">Unstable (snapshots)</option></select></label><button onClick={() => act(async () => { const result = await invoke<Row>("check_update"); setUpdate(result) })}>Check for updates</button>{update && <div className="card"><h3>{update.available ? `MeshTalk ${update.version} is available` : "No newer desktop release available"}</h3>{update.available && <><p>Automatic installation is unavailable in unsigned builds. Download the installer from the release page.</p><button onClick={() => act(() => invoke("open_release", { tag: update.tag }))}>Open release downloads</button><pre>{update.notes}</pre></>}</div>}<p className="muted">This build is unsigned. Desktop and backend are packaged together. X25519 key agreement is not post-quantum secure.</p></>}
    </div>
  </section></div>
}
