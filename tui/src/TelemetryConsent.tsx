import { PRIVACY_URL, markPrompted, writeLevel, type TelemetryLevel } from "../../common/telemetry";
import { chatTheme as theme } from "./chatTheme";
export function TelemetryConsent({ version, done }: { version: string; done: () => void }) {
  const choose = (_: number, option: { value?: string } | null) => {
    const value = option?.value;
    const level: TelemetryLevel = value === "basic" ? "basic" : value === "off" ? "off" : "extended";
    writeLevel(level); markPrompted(version); done();
  };
  return <box style={{ position: "absolute", left: 2, right: 2, top: 2, bottom: 2, border: true, borderColor: theme.accent, backgroundColor: theme.surfaceRaised, padding: 2, flexDirection: "column", zIndex: 20 }}>
    <text fg={theme.text}><b>Help improve MeshTalk?</b></text><text fg={theme.muted} wrapMode="word">Send anonymous version, usage, and stability statistics. This is optional and off until you choose an option. There are no identifiers, message content, filenames, paths, or stored IP addresses. You can change this anytime in Settings {"»"} Diagnostics.</text><text fg={theme.link} wrapMode="word">Privacy policy: {PRIVACY_URL}</text>
    <select focused options={[{ name: "Enable extended telemetry", description: "Version ping + aggregate usage counters", value: "extended" }, { name: "Enable basic telemetry", description: "Version ping only", value: "basic" }, { name: "Decline", description: "Send nothing", value: "off" }]} onSelect={choose} />
  </box>;
}
