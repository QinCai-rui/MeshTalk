import { PRIVACY_URL, markPrompted, writeConsent } from "../../common/telemetry";
import { chatTheme as theme } from "./chatTheme";
export function TelemetryConsent({ version, done }: { version: string; done: () => void }) {
  const choose = (_: number, option: { value?: string } | null) => { const value = option?.value; writeConsent(value === "accept" ? "accepted" : value === "never" ? "never_ask_again" : "declined"); markPrompted(version); done(); };
  return <box style={{ position: "absolute", left: 2, right: 2, top: 2, bottom: 2, border: true, borderColor: theme.accent, backgroundColor: theme.surfaceRaised, padding: 2, flexDirection: "column", zIndex: 20 }}>
    <text fg={theme.text}><b>Help improve MeshTalk?</b></text><text fg={theme.muted} wrapMode="word">Send anonymous version, usage, and stability statistics. This is optional and contains no identifiers, message content, filenames, paths, or IP addresses.</text><text fg={theme.link} wrapMode="word">Privacy policy: {PRIVACY_URL}</text>
    <select focused options={[{ name: "Accept", description: "Enable anonymous telemetry", value: "accept" }, { name: "Decline", description: "Keep telemetry off", value: "decline" }, { name: "Never ask me again", description: "Keep telemetry off permanently", value: "never" }]} onSelect={choose} />
  </box>;
}
