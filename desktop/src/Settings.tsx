import { useEffect, useRef, useState, type ReactNode } from "react"
import { invoke, request, target, type Conversation, type Row } from "./api"
import { Dialog } from "./components/Dialog"
import { Icon, type IconName } from "./components/Icon"
import { Updater } from "./components/Updater"

const PUBLIC_CONTROL = "wss://meshtalk-control.qincai.xyz/v1/rendezvous"
const sections: { name: string; icon: IconName; description: string }[] = [
  { name: "Profile", icon: "people", description: "Choose how people see you and manage this desktop app." },
  { name: "Appearance", icon: "appearance", description: "Make MeshTalk comfortable to read and use." },
  { name: "Notifications", icon: "bell", description: "Decide which activity gets your attention." },
  { name: "Privacy", icon: "shield", description: "Control optional analytics and review what stays on your device." },
  { name: "People", icon: "people", description: "Manage friend requests, blocked contacts, and this conversation." },
  { name: "Rooms", icon: "group", description: "Manage the shared rooms that help you connect with others." },
  { name: "Connection", icon: "connection", description: "Configure remote discovery, your server, and network addresses." },
  { name: "Diagnostics", icon: "details", description: "Inspect connection details and troubleshoot networking." },
  { name: "About", icon: "help", description: "MeshTalk version, release channel, and desktop updates." },
]
const eventNames: Record<string, { title: string; description: string }> = {
  messages: { title: "Messages", description: "New activity in your conversations." },
  friend_requests: { title: "Friend requests", description: "Someone wants to connect with you." },
  file_offers: { title: "Incoming files", description: "Someone offers to send you a file." },
  file_completed: { title: "Completed transfers", description: "A file has finished transferring." },
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="settings-section"><h3>{title}</h3>{description && <p className="section-description">{description}</p>}<div className="settings-section-content">{children}</div></section>
}

function Toggle({ title, description, checked, onChange, disabled = false }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <label className="setting-row toggle-row"><span><span className="setting-title">{title}</span><span className="setting-description">{description}</span></span><input className="switch" type="checkbox" role="switch" aria-label={title} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /></label>
}

export function Settings({ selection, onClose, onRefresh, theme, onTheme, accent, onAccent }: { selection?: Conversation; onClose: () => void; onRefresh: () => Promise<void>; theme: string; onTheme: (theme: string) => void; accent: string; onAccent: (accent: string) => void }) {
  const [tab, setTab] = useState("Profile")
  const [data, setData] = useState<Row>()
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [update, setUpdate] = useState<Row>()
  const [pins, setPins] = useState<Record<string, string>>({})
  const [testSent, setTestSent] = useState(false)
  const [leaving, setLeaving] = useState<Row>()
  const [removing, setRemoving] = useState(false)
  const [invite, setInvite] = useState<{ room: string; value: string }>()
  const [copied, setCopied] = useState(false)
  const content = useRef<HTMLDivElement>(null)

  async function load(initial = false) {
    const [identity, control, analytics, notifications, friends, blocked, rooms, preferences, muted, advanced] = await Promise.all([
      request("identity"), request("control"), request("analytics"), request("notifications"), request("friend_requests"), request("blocked_peers"), request("rooms"), invoke<Row>("preferences"), request("muted_peers"), request("advanced_config"),
    ])
    setData(current => ({ ...current, identity, control, analytics, notifications, friends, blocked, rooms, preferences, muted, advanced }))
    if (initial) { setName(identity.display_name); setUrl(control.url ?? "") }
  }
  useEffect(() => { void load(true).catch(e => setError(`Could not load settings: ${String(e)}`)) }, [])
  useEffect(() => { content.current?.scrollTo({ top: 0 }) }, [tab])
  async function act(operation: () => Promise<unknown>, message = "Changes saved") {
    setBusy(true); setError(""); setNotice("")
    try { await operation(); await load(); await onRefresh(); setNotice(message) } catch (e) { setError(`Could not complete this action: ${String(e)}`) } finally { setBusy(false) }
  }
  const current = sections.find(section => section.name === tab)!
  const events = data?.notifications?.events ?? {}

  return <Dialog title="Settings" onClose={onClose} className="settings-screen">
    <div className="settings-workspace">
      <aside className="settings-sidebar">
        <button className="settings-back" onClick={onClose}><Icon name="back" size={18} />Back to chats</button>
        <h1>Settings</h1>
        <nav aria-label="Settings sections">{sections.map(section => <button key={section.name} aria-current={tab === section.name ? "page" : undefined} className={tab === section.name ? "selected" : ""} onClick={() => { setTab(section.name); setNotice("") }}><Icon name={section.icon} size={19} />{section.name}</button>)}</nav>
        <p className="settings-local"><Icon name="shield" size={17} />Your identity lives on this device.</p>
      </aside>
      <div ref={content} className="settings-content">
        <header className="settings-page-heading"><h2>{current.name}</h2><p>{current.description}</p></header>
        {error && <div className="settings-feedback error" role="alert"><span>{error}</span>{!data && <button disabled={busy} onClick={() => act(() => load(true), "Settings loaded")}>Try again</button>}</div>}
        <div className="save-status" role="status" aria-label="Settings status" aria-live="polite">{busy ? "Saving…" : notice}</div>
        {!data ? !error && <p role="status">Loading settings…</p> : <fieldset disabled={busy} className="settings-fields">
          {tab === "Profile" && <>
            <Section title="Your profile" description="Your display name is visible to people you connect with.">
              <div className="profile-preview"><span className="avatar">{(data.identity.display_name || "?").slice(0, 1).toUpperCase()}</span><div><strong>{data.identity.display_name}</strong><span>Local MeshTalk identity</span></div></div>
              <form className="settings-form" onSubmit={e => { e.preventDefault(); void act(() => request("set_display_name", { display_name: name.trim() }), "Display name saved") }}><label htmlFor="display-name">Display name</label><div className="field-action"><input id="display-name" required value={name} maxLength={48} onChange={e => setName(e.target.value)} /><button className="primary" disabled={!name.trim() || name.trim() === data.identity.display_name}>Save name</button></div></form>
            </Section>
            <Section title="Desktop behavior">
              <label className="setting-row"><span><span className="setting-title">When you close the window</span><span className="setting-description">Keep receiving messages in the tray, or quit the app.</span></span><select aria-label="When you close the window" value={data.preferences?.close_mode ?? "ask"} onChange={e => act(() => invoke("preferences", { closeMode: e.target.value }))}><option value="ask">Ask each time</option><option value="quit">Quit MeshTalk</option><option value="tray">Keep running in tray</option></select></label>
              <Toggle title="Launch at login" description="Start MeshTalk when you sign in to your computer." checked={data.preferences?.autostart ?? false} onChange={checked => void act(() => invoke("preferences", { autostart: checked }))} />
            </Section>
            <p className="settings-note">The desktop app, TUI, and CLI share your identity and message history. Window preferences apply only to this desktop app.</p>
          </>}
          {tab === "Appearance" && <>
            <Section title="Theme" description="Follow your system appearance or choose a theme."><div className="theme-choices" role="group" aria-label="Theme">{["system", "light", "dark"].map(value => <button key={value} aria-pressed={theme === value} onClick={() => onTheme(value)}><span className={`theme-sample ${value}`}><span /><span /><span /></span>{value === "system" ? "Follow system" : value === "light" ? "Light" : "Dark"}</button>)}</div></Section>
            <Section title="Chat color" description="Choose the color for your outgoing messages and app controls."><div className="accent-choices" role="group" aria-label="Chat color">{["teal", "blue"].map(value => <button key={value} aria-pressed={accent === value} onClick={() => onAccent(value)}><span className={`color-swatch ${value}`} />{value === "teal" ? "MeshTalk teal" : "Signal-inspired blue"}</button>)}</div><div className="chat-style-preview" aria-label="Chat appearance preview"><span className="preview-incoming">A little easier to read.</span><span className="preview-outgoing">Just the way you like it.</span></div></Section>
            <Section title="Accessibility"><Toggle title="Activity animations" description="Allow activity animations. Your system's reduced-motion preference is always respected." checked={data.identity?.flashing_enabled ?? true} onChange={checked => void act(() => request("accessibility", { flashing_enabled: checked }))} /></Section>
          </>}
          {tab === "Notifications" && <>
            <Section title="Desktop notifications"><Toggle title="Enable notifications" description="Show system notifications when MeshTalk is not focused." checked={data.notifications.delivery !== "disabled"} onChange={checked => void act(() => request("notifications", { delivery: checked ? "native" : "disabled", setup_dismissed: true }))} /><Toggle title="Do not disturb" description="Pause notifications without disconnecting from your contacts." checked={data.identity.dnd_enabled ?? false} onChange={checked => void act(() => request("dnd", { enabled: checked }))} /></Section>
            <Section title="Notify me about">{Object.entries(events).map(([event, enabled]) => <Toggle key={event} title={eventNames[event]?.title ?? event.replaceAll("_", " ")} description={eventNames[event]?.description ?? "Activity of this type."} checked={Boolean(enabled)} disabled={data.notifications.delivery === "disabled"} onChange={checked => void act(() => request("notifications", { events: { [event]: checked } }))} />)}</Section>
            <Section title="Check notification delivery" description="Notifications never include message text or attachment names."><button className="secondary" onClick={() => act(async () => { await invoke("notify", { title: "MeshTalk notifications are working" }); setTestSent(true) }, "Test notification sent")}>Send a test notification</button>{testSent && <div className="inline-prompt"><p>Did you receive it? If not, check your system's notification settings and Do not disturb mode.</p><div className="actions"><button className="primary" onClick={() => act(async () => { await request("notifications", { delivery: "native", setup_dismissed: true }); setTestSent(false) }, "Notifications enabled")}>Yes, enable notifications</button><button onClick={() => act(async () => { await request("notifications", { delivery: "disabled", setup_dismissed: true }); setTestSent(false) }, "Notifications disabled")}>No, keep disabled</button></div></div>}</Section>
          </>}
          {tab === "Privacy" && <>
            <Section title="Optional analytics" description="Analytics are off by default. You can change your choice at any time."><label className="setting-row"><span><span className="setting-title">Analytics level</span><span className="setting-description">Choose whether to send optional usage and diagnostic data.</span></span><select aria-label="Analytics level" value={data.analytics.analytics_level ?? "off"} onChange={e => act(() => request("analytics", { level: e.target.value }))}><option value="off">Off</option><option value="basic">Basic</option><option value="extended">Extended</option></select></label></Section>
            <Section title="Your data"><div className="privacy-fact"><Icon name="shield" size={22} /><div><strong>Identity and history stay on your device</strong><p>The control service helps peers connect and can relay encrypted traffic. It does not store your chat history.</p></div></div><div className="privacy-fact"><Icon name="bell" size={22} /><div><strong>Private notification previews</strong><p>System notifications show generic activity, never message text or attachment names.</p></div></div></Section>
            <p className="settings-note">MeshTalk uses X25519 key agreement. It is not post-quantum secure.</p>
          </>}
          {tab === "People" && <>
            {selection && <Section title={selection.name} description="Actions for the currently selected conversation."><div className="actions"><button className="secondary" onClick={() => act(() => request("mute", target(selection)), "Conversation muted")}>Mute</button><button className="secondary" onClick={() => act(() => request("unmute", target(selection)), "Conversation unmuted")}>Unmute</button>{selection.kind === "peer" && <button className="danger" onClick={() => setRemoving(true)}>Remove friend or block…</button>}</div></Section>}
            <Section title="Friend requests">{!data.friends.requests?.length && <p className="settings-empty">No pending requests. You can find people from the chat sidebar.</p>}{data.friends.requests?.map((item: Row) => <div className="settings-person" key={item.request_id}><div><strong>{item.direction === "incoming" ? item.sender_name : item.recipient_name}</strong><small>{item.direction === "incoming" ? "Wants to connect with you" : "Request sent"}</small>{item.note && <p>{item.note}</p>}</div><div className="actions">{item.direction === "incoming" ? <><button className="primary" onClick={() => act(() => request("friend_respond", { request_id: item.request_id, accept: true }), "Friend request accepted")}>Accept</button><button onClick={() => act(() => request("friend_respond", { request_id: item.request_id, accept: false }), "Friend request declined")}>Decline</button></> : <button onClick={() => act(() => request("friend_cancel", { request_id: item.request_id }), "Friend request cancelled")}>Cancel request</button>}</div></div>)}</Section>
            <Section title="Blocked people" description="Blocked people cannot send you messages or friend requests.">{!data.blocked.blocked?.length && <p className="settings-empty">You haven't blocked anyone.</p>}{data.blocked.blocked?.map((item: Row) => <div className="settings-person" key={item.peer_id}><strong>{item.display_name}</strong><button className="secondary" onClick={() => act(() => request("unblock_peer", { peer_id: item.peer_id }), "Person unblocked")}>Unblock</button></div>)}</Section>
          </>}
          {tab === "Rooms" && <Section title="Your rooms" description="Shared rooms help people discover each other remotely. Group rooms also carry group conversations.">{!data.rooms.rooms?.length && <p className="settings-empty">No rooms yet. Use New conversation to create a group or join with an invite.</p>}{data.rooms.rooms?.map((room: Row) => <div className="settings-person" key={room.room_id}><div><strong>{room.name ?? "Private room"}</strong><small>{room.members} members</small></div><div className="actions"><button className="secondary" onClick={() => act(async () => { const value = await request("room_invite", { room_id: room.room_id }); setInvite({ room: room.name ?? "Private room", value: value.invite }); setCopied(false) }, "Invite ready to share")}>Share invite</button><button className="danger" onClick={() => setLeaving(room)}>Leave…</button></div></div>)}</Section>}
          {tab === "Connection" && <>
            <Section title="Remote discovery" description="LAN messaging works without the public control service. Remote discovery helps you connect beyond your local network."><Toggle title="Enable remote discovery" description="Use a control service for rendezvous and encrypted relaying when needed." checked={Boolean(data.control.url)} onChange={checked => void act(async () => { const next = checked ? url.trim() || PUBLIC_CONTROL : ""; await request("control", { url: next, dismiss_setup: true }); setUrl(next) })} /><dl className="network-facts"><div><dt>Status</dt><dd><span className={`status-dot ${data.control.connected ? "online" : ""}`} />{data.control.connected ? "Remote discovery connected" : data.control.url ? "Remote discovery disconnected" : "Local network only"}</dd></div><div><dt>Public endpoint</dt><dd>{data.control.public_endpoint?.join(":") ?? "Not discovered"}</dd></div><div><dt>Reconnect attempts</dt><dd>{data.control.reconnect_attempts ?? 0}</dd></div></dl></Section>
            <Section title="Control server" description="The server exchanges connection information and can relay encrypted traffic. It cannot read your messages."><form className="settings-form" onSubmit={e => { e.preventDefault(); void act(() => request("control", { url: url.trim(), dismiss_setup: true }), "Control server saved") }}><label htmlFor="control-url">Server URL</label><input id="control-url" placeholder="wss://…" value={url} onChange={e => setUrl(e.target.value)} /><div className="actions"><button type="button" className="secondary" onClick={() => setUrl(PUBLIC_CONTROL)}>Use public server address</button><button className="primary">Save server</button></div><small>Saving an empty address turns off remote discovery.</small></form><dl className="network-facts"><div><dt>STUN server</dt><dd>{data.control.stun_server ?? data.advanced.stun_server ?? "Not configured"}</dd></div></dl></Section>
            <Section title="Address pinning" description="Override automatic DNS resolution for the control or STUN server. Most users should leave this on automatic.">{["control", "stun"].map(service => <div className="pinning-service" key={service}><h4>{service === "control" ? "Control server addresses" : "STUN server addresses"}</h4><p className="setting-description">{data.advanced[`${service}_pinned_ips`]?.join(", ") || "Automatic DNS resolution"}</p><div className="actions"><button className="secondary" onClick={() => act(() => request("advanced_config", { [`auto_${service}_pinned_ip`]: true }), "Current addresses pinned")}>Pin current addresses</button><button className="secondary" onClick={() => act(() => request("advanced_config", { [`clear_${service}_pinned_ip`]: true }), "Automatic DNS restored")}>Use automatic DNS</button></div><form className="settings-form" onSubmit={e => { e.preventDefault(); void act(() => request("advanced_config", { [`${service}_pinned_ip`]: pins[service] }), "Pinned addresses saved") }}><label htmlFor={`${service}-addresses`}>Manual {service === "control" ? "control" : "STUN"} addresses</label><div className="field-action"><input id={`${service}-addresses`} placeholder={service === "control" ? "IPv4 or IPv6, comma separated" : "IPv4, comma separated"} value={pins[service] ?? ""} onChange={e => setPins(current => ({ ...current, [service]: e.target.value }))} /><button className="primary" disabled={!pins[service]?.trim()}>Save addresses</button></div></form></div>)}</Section>
          </>}
          {tab === "Diagnostics" && <>
            <Section title="Network tools" description="Refresh your public network endpoint or inspect the backend's current status."><div className="actions"><button className="secondary" onClick={() => act(async () => { const debug = await request("debug_info"); setData(current => ({ ...current, debug })) }, "Diagnostics refreshed")}>Refresh diagnostics</button><button className="secondary" onClick={() => act(() => request("debug_re_stun"), "Network endpoint refresh requested")}>Refresh network endpoint</button></div></Section>
            <Section title="Diagnostic details" description="These details include network addresses and peer identifiers. Review them before sharing.">{data.debug ? <pre className="diagnostic-output">{JSON.stringify(data.debug, null, 2)}</pre> : <p className="settings-empty">Choose Refresh diagnostics to load the current details.</p>}</Section>
          </>}
          {tab === "About" && <>
            <div className="about-brand"><Icon name="messages" size={40} /><div><h3>MeshTalk</h3><p>Version {data.preferences?.version ?? "unknown"}</p></div></div><p>Private peer-to-peer messaging.</p>
            <Section title="Desktop updates"><label className="setting-row"><span><span className="setting-title">Release channel</span><span className="setting-description">Stable releases are recommended for everyday use.</span></span><select aria-label="Release channel" value={data.preferences?.update_channel ?? "stable"} onChange={e => act(() => invoke("preferences", { updateChannel: e.target.value }))}><option value="stable">Stable</option><option value="unstable">Unstable snapshots</option></select></label><p className="settings-note">Unstable releases may contain unfinished changes. Switching to stable does not downgrade your installation.</p><Updater channel={data.preferences?.update_channel ?? "stable"} /><button className="secondary" onClick={() => act(async () => { const result = await invoke<Row>("check_update"); setUpdate(result) }, "Release check finished")}>Check release downloads</button>{update && <div className="inline-prompt"><p>{update.available ? `MeshTalk ${update.version} is available` : "No newer desktop release available"}</p>{update.available && <><button className="primary" onClick={() => act(() => invoke("open_release", { tag: update.tag }), "Release page opened")}>Open release downloads</button><pre>{update.notes}</pre></>}</div>}</Section>
            <p className="settings-note">Desktop and backend are packaged together. X25519 key agreement is not post-quantum secure.</p>
          </>}
        </fieldset>}
      </div>
    </div>
    {leaving && <Dialog title={`Leave ${leaving.name ?? "this room"}?`} onClose={() => setLeaving(undefined)}><p>Your local history will remain on this device. You will stop receiving new activity from this room.</p><div className="actions"><button onClick={() => setLeaving(undefined)}>Cancel</button><button className="danger" disabled={busy} onClick={() => act(async () => { await request(leaving.group_id ? "group_leave" : "room_leave", leaving.group_id ? { group_id: leaving.group_id } : { room_id: leaving.room_id }); setLeaving(undefined) }, "Room left")}>Leave room</button></div>{error && <p role="alert">{error}</p>}</Dialog>}
    {removing && selection?.kind === "peer" && <Dialog title={`Manage ${selection.name}`} onClose={() => setRemoving(false)}><p>Removing a friend lets you send another request later. Blocking drops their messages and friend requests until you unblock them.</p><div className="actions"><button onClick={() => setRemoving(false)}>Cancel</button><button className="danger" disabled={busy} onClick={() => act(async () => { await request("unfriend", { peer_id: selection.id }); setRemoving(false) }, "Friend removed")}>Remove friend</button><button className="danger" disabled={busy} onClick={() => act(async () => { await request("block_peer", { peer_id: selection.id }); setRemoving(false) }, "Person blocked")}>Block</button></div>{error && <p role="alert">{error}</p>}</Dialog>}
    {invite && <Dialog title={`Invite to ${invite.room}`} onClose={() => setInvite(undefined)}><p>Share this invite only with people you want in your room.</p><textarea aria-label="Room invite" readOnly value={invite.value} /><button className="primary" onClick={() => { void navigator.clipboard.writeText(invite.value).then(() => setCopied(true)).catch(e => setError(String(e))) }}>{copied ? "Copied" : "Copy invite"}</button>{error && <p role="alert">{error}</p>}</Dialog>}
  </Dialog>
}
