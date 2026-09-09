/** Optional aggregate release telemetry shared by the launcher and TUI. Off by default, privacy-minimised. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TELEMETRY_URL = "https://meshtalk-telemetry.raymont.workers.dev/v1/telemetry";
export const TIMEOUT_MS = 3_000;
export const PRIVACY_URL = "https://github.com/QinCai-rui/MeshTalk/blob/main/PRIVACY.md";
export const TIER0_ALLOW = { os: ["darwin", "linux", "win32"], arch: ["arm64", "x64"] } as const;
// No msg.*/file.* counters. Room/group + transport-path only. No transport.stun_fail (never emitted).
export const ALLOWED_EVENTS = new Set(["room.created", "room.joined", "group.created", "transport.lan_ok", "transport.udp_ok", "transport.relay_fallback"]);
export type Consent = "pending" | "accepted" | "declined" | "never_ask_again";
export type ConsentState = { consent: Consent; seenVersions: string[] };
/** Telemetry level: `extended` (Tier 0 + Tier 1), `basic` (Tier 0 only), `off`. */
export type TelemetryLevel = "extended" | "basic" | "off";
export const DEFAULT_TELEMETRY_LEVEL: TelemetryLevel = "off";

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
export function readLevel(dataDir?: string): TelemetryLevel {
  try {
    const value = JSON.parse(readFileSync(settingsPath(dataDir), "utf8"));
    if (value.telemetry_level === "extended" || value.telemetry_level === "basic" || value.telemetry_level === "off") return value.telemetry_level;
    // Migrate legacy consent: accepted -> extended, declined/never -> off, missing -> default.
    if (value.telemetry_consent === "accepted") return "extended";
    if (value.telemetry_consent === "declined" || value.telemetry_consent === "never_ask_again") return "off";
  } catch {}
  return DEFAULT_TELEMETRY_LEVEL;
}
export function writeLevel(level: TelemetryLevel, dataDir?: string): void {
  const path = settingsPath(dataDir); let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch {}
  data.telemetry_level = level;
  // Keep legacy consent in sync so older builds interpret the choice sanely:
  // extended/basic count as opted-in (no re-prompt), off counts as declined.
  data.telemetry_consent = level === "off" ? "declined" : "accepted";
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.telemetry.tmp`; writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, path);
}
function envLevel(): TelemetryLevel | null {
  const raw = (process.env.MESHTALK_TELEMETRY ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "disabled") return "off";
  if (raw === "basic" || raw === "tier0" || raw === "minimal") return "basic";
  if (raw === "1" || raw === "true" || raw === "extended" || raw === "tier1") return "extended";
  return null;
}
function telemetryDisabledByEnv(): boolean {
  return process.env.MESHTALK_NO_TELEMETRY === "1" || process.env.DO_NOT_TRACK === "1" || Boolean(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS);
}
export function hasExplicitTelemetryChoice(dataDir?: string): boolean {
  // An explicit choice is recorded via legacy consent: writeLevel() stores
  // `accepted` for extended/basic and `declined` for off (soft off, re-asked
  // on upgrade by design). A bare `telemetry_level` key alone does not count:
  // the backend persists its default level on unrelated saves.
  const consent = readConsent(dataDir).consent;
  if (consent === "never_ask_again") return true;
  // The short-lived default-on build wrote accepted/extended without a prompt
  // marker. Treat that shape as implicit so affected installs see the dialog.
  if (consent === "accepted" && promptedVersions(dataDir).length === 0) return false;
  return consent === "accepted";
}
export function shouldPrompt(version: string, state = readConsent(), prompts = promptedVersions()): boolean { return state.consent !== "accepted" && state.consent !== "never_ask_again" && !prompts.includes(version); }
export function markPrompted(version: string, dataDir?: string): void {
  const path = settingsPath(dataDir); let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch {}
  data.telemetry_prompted_versions = [...new Set([...promptedVersions(dataDir), version])];
  mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.telemetry.tmp`; writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, path);
}
export function isTelemetryAllowed(releaseBuild: boolean, consent = readConsent().consent, dryRun = false): boolean {
  return isTier1Allowed(releaseBuild, undefined, dryRun, consent);
}
export function isTier0Allowed(releaseBuild: boolean, dataDir?: string, dryRun = false, consent?: Consent): boolean {
  if (!releaseBuild || dryRun || telemetryDisabledByEnv()) return false;
  const override = envLevel();
  const level = override ?? readLevel(dataDir);
  void consent;
  return level === "extended" || level === "basic";
}
export function isTier1Allowed(releaseBuild: boolean, dataDir?: string, dryRun = false, consent?: Consent): boolean {
  if (!releaseBuild || dryRun || telemetryDisabledByEnv()) return false;
  const override = envLevel();
  if (override) return override === "extended";
  void consent;
  return readLevel(dataDir) === "extended";
}
export function tier0Payload(version: string) { return { tier: 0, app_version: version, os: process.platform, arch: process.arch, release: true as const }; }
export function validTier0Payload(payload: ReturnType<typeof tier0Payload>) { return TIER0_ALLOW.os.includes(payload.os as never) && TIER0_ALLOW.arch.includes(payload.arch as never); }
export async function sendTier0(version: string): Promise<boolean> {
  const payload = tier0Payload(version); if (!validTier0Payload(payload)) return false;
  try { const response = await fetch(TELEMETRY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) }); return response.ok; } catch { return false; }
}
