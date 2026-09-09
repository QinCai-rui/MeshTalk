/** Privacy-preserving release telemetry shared by the launcher and TUI. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TELEMETRY_URL = "https://meshtalk-telemetry.raymont.workers.dev/v1/telemetry";
export const TIMEOUT_MS = 3_000;
export const PRIVACY_URL = "https://github.com/QinCai-rui/MeshTalk/blob/main/PRIVACY.md";
export const TIER0_ALLOW = { os: ["darwin", "linux", "win32"], arch: ["arm64", "x64"] } as const;
export const ALLOWED_EVENTS = new Set(["msg.sent", "msg.received", "file.sent", "file.completed", "room.created", "room.joined", "group.created", "transport.lan_ok", "transport.udp_ok", "transport.relay_fallback", "transport.stun_fail"]);
export type Consent = "pending" | "accepted" | "declined" | "never_ask_again";
export type ConsentState = { consent: Consent; seenVersions: string[] };

function settingsPath(dataDir = process.env.MESHTALK_DATA_DIR): string {
  return join(dataDir || `${process.env.HOME || process.env.USERPROFILE || ""}/.meshtalk`, "settings.json");
}
export function readConsent(dataDir?: string): ConsentState {
  try {
    const value = JSON.parse(readFileSync(settingsPath(dataDir), "utf8"));
    const consent: Consent = ["accepted", "declined", "never_ask_again"].includes(value.telemetry_consent) ? value.telemetry_consent : "pending";
    return { consent, seenVersions: Array.isArray(value.telemetry_seen_versions) ? value.telemetry_seen_versions.filter((v: unknown) => typeof v === "string") : [] };
  } catch { return { consent: "pending", seenVersions: [] }; }
}
export function writeConsent(consent: Consent, seenVersions?: string[], dataDir?: string): void {
  const path = settingsPath(dataDir); let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch {}
  data.telemetry_consent = consent;
  data.telemetry_seen_versions = [...new Set(seenVersions ?? readConsent(dataDir).seenVersions)];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.telemetry.tmp`; writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, path);
}
export function promptedVersions(dataDir?: string): string[] {
  try { const value = JSON.parse(readFileSync(settingsPath(dataDir), "utf8")); return Array.isArray(value.telemetry_prompted_versions) ? value.telemetry_prompted_versions.filter((v: unknown) => typeof v === "string") : []; } catch { return []; }
}
export function shouldPrompt(version: string, state = readConsent(), prompts = promptedVersions()): boolean { return state.consent !== "accepted" && state.consent !== "never_ask_again" && !prompts.includes(version); }
export function markPrompted(version: string, dataDir?: string): void {
  const path = settingsPath(dataDir); let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch {}
  data.telemetry_prompted_versions = [...new Set([...promptedVersions(dataDir), version])];
  mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.telemetry.tmp`; writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, path);
}
export function isTelemetryAllowed(releaseBuild: boolean, consent = readConsent().consent, dryRun = false): boolean {
  if (!releaseBuild || dryRun || process.env.MESHTALK_NO_TELEMETRY === "1" || process.env.DO_NOT_TRACK === "1" || process.env.CI || process.env.GITHUB_ACTIONS) return false;
  return process.env.MESHTALK_TELEMETRY === "1" || consent === "accepted";
}
export function tier0Payload(version: string) { return { tier: 0, app_version: version, os: process.platform, arch: process.arch, release: true as const }; }
export function validTier0Payload(payload: ReturnType<typeof tier0Payload>) { return TIER0_ALLOW.os.includes(payload.os as never) && TIER0_ALLOW.arch.includes(payload.arch as never); }
export async function sendTier0(version: string): Promise<boolean> {
  const payload = tier0Payload(version); if (!validTier0Payload(payload)) return false;
  try { const response = await fetch(TELEMETRY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) }); return response.ok; } catch { return false; }
}
