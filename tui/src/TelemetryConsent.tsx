import { PRIVACY_URL, markPrompted, writeLevel, type TelemetryLevel } from "../../common/telemetry";
import { chatTheme as theme } from "./chatTheme";
import { MouseSelect, type MouseSelectOption } from "./components/MouseSelect";
export function TelemetryConsent({ version, done }: { version: string; done: () => void }) {
  const choose = (_: number, option: { value?: string } | null) => {
    const value = option?.value;
    const level: TelemetryLevel = value === "basic" ? "basic" : value === "off" ? "off" : "extended";
    writeLevel(level); markPrompted(version); done();
  };
  const options: MouseSelectOption[] = [
    { section: "Choose what to share", name: "Extended telemetry", description: "Version pings plus anonymous aggregate usage and stability counters. Recommended for debugging.", value: "extended", tone: "accent" },
    { name: "Basic telemetry", description: "Anonymous version pings only. No usage or stability counters.", value: "basic" },
    { name: "Keep telemetry off", description: "Do not send telemetry. You can change this later in Settings > Diagnostics.", value: "off", tone: "warning" },
  ];
  return <box style={{ position: "absolute", left: 4, right: 4, top: 3, bottom: 3, border: true, borderColor: theme.accent, backgroundColor: theme.surfaceRaised, padding: 2, flexDirection: "column", gap: 1, zIndex: 20 }}>
    <text fg={theme.accent}><b>◈  MeshTalk telemetry</b></text>
    <text fg={theme.text}><b>Help improve MeshTalk?</b></text>
    <text fg={theme.muted} wrapMode="word">Share anonymous diagnostics to help us improve reliability and understand which transports work in the real world. No identifiers, message content, filenames, paths, usernames, or stored IP addresses are ever sent.</text>
    <text fg={theme.link} wrapMode="word">Read the privacy policy: {PRIVACY_URL}</text>
    <MouseSelect focused height={9} options={options} descriptionMode="panel" onSelect={choose} wrapSelection />
    <text fg={theme.subdued}>↑/↓ or j/k to move  ·  Enter to choose  ·  click an option</text>
  </box>;
}
