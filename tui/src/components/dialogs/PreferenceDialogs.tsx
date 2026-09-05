import type { Dialog, SplashPreference } from "../../types"
import { MouseSelect } from "../MouseSelect"
import { SettingsField, SettingsMenu, SettingsNotice, SettingsScreen, SettingsSummary } from "./SettingsPrimitives"
const PUBLIC_CONTROL_URL = "wss://meshtalk-control.qincai.xyz/v1/rendezvous"

export function ControlDialogContent({ dialog, dialogHeight, configureControl, dismissControlSetup, loadControlStatus, showDialog }: { dialog: Extract<Dialog, { kind: "control" }>; dialogHeight: number; configureControl: (url: string) => void; dismissControlSetup: () => void; loadControlStatus: () => void; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Connection", "Control server"]} description="Remote discovery lets peers find each other outside the local network." dialogHeight={dialogHeight}>
      {dialog.firstRun ? <SettingsNotice tone="warning">Set up remote discovery now, or continue with LAN-only chat and configure it later.</SettingsNotice> : null}
      <SettingsMenu dialogHeight={dialogHeight} headerRows={dialog.firstRun ? 7 : 4} options={[
        { section: "Server", name: "MeshTalk public server", description: PUBLIC_CONTROL_URL, value: "public", status: "Recommended", tone: "accent" },
        { section: "Server", name: "Custom server", description: "Enter another secure WebSocket URL. Localhost may use an unencrypted ws:// address.", value: "custom" },
        { section: "Status", name: "Connection details", description: "See the current URL, connection state, STUN server, and public endpoint.", value: "status" },
        ...(dialog.firstRun ? [{ section: "Setup", name: "Continue with LAN only", description: "Skip remote discovery for now. This remains available from Settings.", value: "skip", tone: "warning" as const }] : []),
      ]} onSelect={(option) => {
        if (option?.value === "public") configureControl(PUBLIC_CONTROL_URL)
        else if (option?.value === "custom") showDialog({ kind: "control-custom", firstRun: dialog.firstRun })
        else if (option?.value === "status") loadControlStatus()
        else if (option?.value === "skip") dismissControlSetup()
      }} />
    </SettingsScreen>
  )
}

export function ControlCustomDialogContent({ dialogDraft, setDialogDraft, configureControl }: { dialogDraft: string; setDialogDraft: (v: string) => void; configureControl: (url: string) => void }) {
  return (
    <SettingsField label="Server URL" description="Use wss://, or ws:// for localhost only" value={dialogDraft} placeholder="wss://control.example/v1/rendezvous" onInput={setDialogDraft} onSubmit={(value) => void configureControl(value)} maxLength={2048} />
  )
}

export function ControlStatusDialogContent({ dialog, showDialog }: { dialog: Extract<Dialog, { kind: "control-status" }>; showDialog: (d: Dialog) => void }) {
  return (
    <>
      <SettingsSummary label="Server" value={dialog.control.url ?? "Not configured"} />
      <SettingsSummary label="Connection" value={dialog.control.connected ? "Connected" : "Disconnected"} tone={dialog.control.connected ? "success" : "warning"} />
      <SettingsSummary label="STUN" value={dialog.control.stun_server} />
      <SettingsSummary label="Public endpoint" value={dialog.control.public_endpoint?.join(":") ?? "Not discovered"} />
      <MouseSelect focused height={6} descriptionMode="panel" options={[
        { name: "Change server", description: "Choose the public server or enter a custom URL.", value: "change" },
        { name: "Back", description: "Return to Settings.", value: "back" },
      ]} onSelect={(_, option) => option?.value === "change" ? showDialog({ kind: "control" }) : showDialog({ kind: "settings" })} wrapSelection />
    </>
  )
}

export function AdvancedDialogContent({ dialog, dialogHeight, showDialog }: { dialog: Extract<Dialog, { kind: "advanced" }>; dialogHeight: number; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Advanced"]} description="Low-level rendering and network overrides for troubleshooting." dialogHeight={dialogHeight}>
      <SettingsNotice tone="warning">Incorrect network overrides can prevent remote connections.</SettingsNotice>
      <SettingsMenu dialogHeight={dialogHeight} headerRows={7} options={[
        { section: "Media", name: "Image protocol", description: "Choose terminal image rendering. Auto prefers Kitty, then Sixel, then portable blocks.", value: "image-protocol", status: dialog.config.image_protocol },
        { section: "Network", name: "IP pinning", description: "Pin control or STUN server addresses to bypass DNS resolution.", value: "ip-pinning", status: dialog.config.control_pinned_ips.length + dialog.config.stun_pinned_ips.length ? "Configured" : "Automatic", tone: dialog.config.control_pinned_ips.length + dialog.config.stun_pinned_ips.length ? "warning" : "default" },
        { section: "Navigation", name: "Back", description: "Return to Settings.", value: "back" },
      ]} onSelect={(option) => {
         if (option?.value === "image-protocol") showDialog({ kind: "advanced-image-protocol", config: dialog.config })
       else if (option?.value === "ip-pinning") showDialog({ kind: "advanced-ip-pinning", config: dialog.config })
      else if (option?.value === "back") showDialog({ kind: "settings" })
      }} />
    </SettingsScreen>
  )
}

export function CustomisationDialogContent({ splashStyle, dialogHeight, showDialog }: { splashStyle: SplashPreference; dialogHeight: number; showDialog: (d: Dialog) => void }) {
  const current = splashStyle === "boot-log" ? "Boot log" : splashStyle === "card" ? "Animated card" : "Off"
  return <SettingsScreen breadcrumb={["Customisation"]} description="Adjust MeshTalk’s startup presentation." dialogHeight={dialogHeight}>
    <SettingsMenu dialogHeight={dialogHeight} options={[
      { section: "Startup", name: "Splash screen", description: "Choose the presentation shown while MeshTalk starts.", value: "splash", status: current },
      { section: "Navigation", name: "Back", description: "Return to Settings.", value: "back" },
    ]} onSelect={(option) => {
    if (option?.value === "splash") showDialog({ kind: "customisation-splash", splashStyle })
    else if (option?.value === "back") showDialog({ kind: "settings" })
    }} />
  </SettingsScreen>
}

export function SplashStyleDialogContent({ splashStyle, dialogHeight, saveAdvancedConfig, showDialog }: { splashStyle: SplashPreference; dialogHeight: number; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void; showDialog: (d: Dialog) => void }) {
  const current = splashStyle === "boot-log" ? "Boot log" : splashStyle === "card" ? "Animated card" : "Off"
  return <SettingsScreen breadcrumb={["Customisation", "Splash screen"]} description="Choose what appears during startup." dialogHeight={dialogHeight}>
    <SettingsMenu dialogHeight={dialogHeight} options={[
      { section: "Style", name: "Boot log", description: "Show real startup operations as a terminal boot log.", value: "boot-log", status: splashStyle === "boot-log" ? "Current" : undefined, tone: "accent" },
      { section: "Style", name: "Animated card", description: "Show the animated MeshTalk card with live startup status.", value: "card", status: splashStyle === "card" ? "Current" : undefined, tone: "accent" },
      { section: "Style", name: "Off", description: "Skip splash artwork and open chat as soon as startup finishes.", value: "off", status: splashStyle === "off" ? "Current" : undefined, tone: "accent" },
      { section: "Navigation", name: "Back", description: `Return to Customisation. Current style: ${current}.`, value: "back" },
    ]} onSelect={(option) => {
    if (!option) return
    if (option.value === "back") showDialog({ kind: "customisation" })
    else void saveAdvancedConfig({ splash_style: option.value }, `Splash screen set to ${option.value}.`)
    }} />
  </SettingsScreen>
}

export function ImageProtocolDialogContent({ dialog, dialogHeight, saveAdvancedConfig, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-image-protocol" }>; dialogHeight: number; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void; showDialog: (d: Dialog) => void }) {
  return <SettingsScreen breadcrumb={["Advanced", "Image protocol"]} description="Select the renderer MeshTalk uses for image attachments." dialogHeight={dialogHeight}>
    <SettingsMenu dialogHeight={dialogHeight} options={[
      { section: "Protocol", name: "Auto-detect", description: "Prefer Kitty, then Sixel, then portable blocks. Use Blocks explicitly inside tmux.", value: "auto", status: dialog.config.image_protocol === "auto" ? "Current" : undefined, tone: "accent" },
      { section: "Protocol", name: "Kitty", description: "Force high-quality Kitty graphics where the terminal supports it.", value: "kitty", status: dialog.config.image_protocol === "kitty" ? "Current" : undefined, tone: "accent" },
      { section: "Protocol", name: "Sixel", description: "Force Sixel graphics; falls back to blocks without pixel geometry.", value: "sixel", status: dialog.config.image_protocol === "sixel" ? "Current" : undefined, tone: "accent" },
      { section: "Protocol", name: "Blocks", description: "Force portable Unicode block rendering.", value: "blocks", status: dialog.config.image_protocol === "blocks" ? "Current" : undefined, tone: "accent" },
      { section: "Navigation", name: "Back", description: "Return to Advanced configuration.", value: "back" },
    ]} onSelect={(option) => {
    if (!option) return
    if (option.value === "back") showDialog({ kind: "advanced", config: dialog.config })
    else void saveAdvancedConfig({ image_protocol: option.value }, `Image protocol set to ${option.value}.`)
    }} />
  </SettingsScreen>
}

export function IpPinningDialogContent({ dialog, dialogHeight, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-ip-pinning" }>; dialogHeight: number; showDialog: (d: Dialog) => void }) {
  return <SettingsScreen breadcrumb={["Advanced", "IP pinning"]} description="Override DNS by saving server IP addresses directly." dialogHeight={dialogHeight}>
    <SettingsNotice tone="warning">Pinned addresses can become stale and stop connections until updated or removed.</SettingsNotice>
    <SettingsMenu dialogHeight={dialogHeight} headerRows={7} options={[
      { section: "Targets", name: "Control server", description: dialog.config.control_pinned_ips.length ? `Pinned addresses: ${dialog.config.control_pinned_ips.join(", ")}` : "Uses DNS automatically; no addresses are pinned.", value: "control", status: dialog.config.control_pinned_ips.length ? `${dialog.config.control_pinned_ips.length} pinned` : "Automatic", tone: dialog.config.control_pinned_ips.length ? "warning" : "default" },
      { section: "Targets", name: "STUN server", description: dialog.config.stun_pinned_ips.length ? `Pinned addresses: ${dialog.config.stun_pinned_ips.join(", ")}` : "Uses DNS automatically; no addresses are pinned.", value: "stun", status: dialog.config.stun_pinned_ips.length ? `${dialog.config.stun_pinned_ips.length} pinned` : "Automatic", tone: dialog.config.stun_pinned_ips.length ? "warning" : "default" },
      { section: "Navigation", name: "Back", description: "Return to Advanced configuration.", value: "back" },
    ]} onSelect={(option) => {
    if (option?.value === "control") showDialog({ kind: "advanced-control", config: dialog.config })
    else if (option?.value === "stun") showDialog({ kind: "advanced-stun", config: dialog.config })
    else if (option?.value === "back") showDialog({ kind: "advanced", config: dialog.config })
    }} />
  </SettingsScreen>
}

export function AdvancedControlDialogContent({ dialog, dialogHeight, setDialogDraft, saveAdvancedConfig, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-control" }>; dialogHeight: number; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Advanced", "IP pinning", "Control server"]} description="Choose how control-server addresses are pinned." dialogHeight={dialogHeight}>
      <SettingsMenu dialogHeight={dialogHeight} options={[
        { section: "Configure", name: "Enter addresses manually", description: "Enter one or more comma-separated IPv4 or IPv6 addresses.", value: "manual" },
        { section: "Configure", name: "Resolve and pin now", description: "Query A and AAAA records, then save the results as pins.", value: "auto" },
        ...(dialog.config.control_pinned_ips.length ? [{ section: "Reset", name: "Remove IP pin", description: `Remove these pinned addresses: ${dialog.config.control_pinned_ips.join(", ")}`, value: "clear", tone: "danger" as const }] : []),
        { section: "Navigation", name: "Back", description: "Return to Advanced configuration.", value: "back" },
      ]} onSelect={(option) => {
      if (option?.value === "manual") { showDialog({ kind: "advanced-control-ip" }); setDialogDraft(dialog.config.control_pinned_ips.join(", ")) }
      else if (option?.value === "auto") void saveAdvancedConfig({ auto_control_pinned_ip: true }, "Control server addresses resolved and pinned.")
      else if (option?.value === "clear") void saveAdvancedConfig({ clear_control_pinned_ip: true }, "Control server IP pin cleared.")
      else if (option?.value === "back") showDialog({ kind: "advanced", config: dialog.config })
      }} />
    </SettingsScreen>
  )
}

export function AdvancedStunDialogContent({ dialog, dialogHeight, setDialogDraft, saveAdvancedConfig, showDialog }: { dialog: Extract<Dialog, { kind: "advanced-stun" }>; dialogHeight: number; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void; showDialog: (d: Dialog) => void }) {
  return (
    <SettingsScreen breadcrumb={["Advanced", "IP pinning", "STUN server"]} description="Choose how STUN-server addresses are pinned." dialogHeight={dialogHeight}>
      <SettingsMenu dialogHeight={dialogHeight} options={[
        { section: "Configure", name: "Enter addresses manually", description: "Enter one or more comma-separated IPv4 addresses.", value: "manual" },
        { section: "Configure", name: "Resolve and pin now", description: "Query A records, then save the results as pins.", value: "auto" },
        ...(dialog.config.stun_pinned_ips.length ? [{ section: "Reset", name: "Remove IP pin", description: `Remove these pinned addresses: ${dialog.config.stun_pinned_ips.join(", ")}`, value: "clear", tone: "danger" as const }] : []),
        { section: "Navigation", name: "Back", description: "Return to Advanced configuration.", value: "back" },
      ]} onSelect={(option) => {
      if (option?.value === "manual") { showDialog({ kind: "advanced-stun-ip" }); setDialogDraft(dialog.config.stun_pinned_ips.join(", ")) }
      else if (option?.value === "auto") void saveAdvancedConfig({ auto_stun_pinned_ip: true }, "STUN server addresses resolved and pinned.")
      else if (option?.value === "clear") void saveAdvancedConfig({ clear_stun_pinned_ip: true }, "STUN server IP pin cleared.")
      else if (option?.value === "back") showDialog({ kind: "advanced", config: dialog.config })
      }} />
    </SettingsScreen>
  )
}

export function AdvancedControlIpDialogContent({ dialogDraft, setDialogDraft, saveAdvancedConfig }: { dialogDraft: string; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void }) {
  return (
    <SettingsField label="Pinned addresses" description="Comma-separated IPv4 or IPv6 addresses for the control server" value={dialogDraft} placeholder="104.21.6.171, 2606:4700:3032::6815:6ab" onInput={setDialogDraft} onSubmit={(value) => void saveAdvancedConfig({ control_pinned_ip: value }, "Control server IPs pinned.")} maxLength={1024} />
  )
}

export function AdvancedStunIpDialogContent({ dialogDraft, setDialogDraft, saveAdvancedConfig }: { dialogDraft: string; setDialogDraft: (v: string) => void; saveAdvancedConfig: (p: Record<string, unknown>, m: string) => void }) {
  return (
    <SettingsField label="Pinned addresses" description="Comma-separated IPv4 addresses for the STUN server" value={dialogDraft} placeholder="203.0.113.10, 203.0.113.11" onInput={setDialogDraft} onSubmit={(value) => void saveAdvancedConfig({ stun_pinned_ip: value }, "STUN server IPs pinned.")} maxLength={1024} />
  )
}
