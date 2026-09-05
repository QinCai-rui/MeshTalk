import { MouseSelect, type MouseSelectOption } from "../MouseSelect"
import { chatTheme as theme } from "../../chatTheme"

export type SettingsTone = "default" | "success" | "warning" | "danger" | "accent"

export function toneColor(tone: SettingsTone = "default") {
  if (tone === "success") return theme.success
  if (tone === "warning") return theme.warning
  if (tone === "danger") return theme.danger
  if (tone === "accent") return theme.accent
  return theme.text
}

export function SettingsScreen({ breadcrumb, description, dialogHeight, children }: { breadcrumb: string[]; description?: string; dialogHeight: number; children: React.ReactNode }) {
  const compact = dialogHeight < 12
  return <box style={{ width: "100%", height: "100%", minHeight: 0, flexDirection: "column", gap: compact ? 0 : 1 }}>
    <box flexShrink={0} minHeight={1}>
      <text wrapMode="word"><span fg={theme.subdued}>Settings</span>{breadcrumb.map((part, index) => <span key={`${part}-${index}`} fg={index === breadcrumb.length - 1 ? theme.accent : theme.muted}> / {index === breadcrumb.length - 1 ? <b>{part}</b> : part}</span>)}</text>
    </box>
    {!compact && description ? <text fg={theme.muted} wrapMode="word">{description}</text> : null}
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}>{children}</box>
  </box>
}

export function SettingsMenu({ dialogHeight, headerRows = 3, options, onSelect, selectedIndex }: { dialogHeight: number; headerRows?: number; options: MouseSelectOption[]; onSelect: (option: MouseSelectOption) => void; selectedIndex?: number }) {
  return <MouseSelect
    focused
    height={Math.max(4, dialogHeight - headerRows - 8)}
    options={options}
    selectedIndex={selectedIndex}
    descriptionMode="panel"
    onSelect={(_, option) => { if (option) onSelect(option) }}
    wrapSelection
  />
}

export function SettingsNotice({ tone = "default", children }: { tone?: SettingsTone; children: React.ReactNode }) {
  const label = tone === "danger" ? "Warning" : tone === "warning" ? "Note" : tone === "success" ? "Ready" : "Info"
  return <box style={{ width: "100%", flexDirection: "row", gap: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: tone === "danger" ? theme.dangerSurface : tone === "success" ? theme.successSurface : theme.surface }}>
    <text fg={toneColor(tone)} flexShrink={0}><b>{label}:</b></text>
    <text fg={theme.text} wrapMode="word">{children}</text>
  </box>
}

export function SettingsSummary({ label, value, tone = "default" }: { label: string; value: string; tone?: SettingsTone }) {
  return <box style={{ width: "100%", flexDirection: "row", gap: 1 }}>
    <text fg={theme.muted} flexShrink={0}>{label}</text>
    <text fg={toneColor(tone)} wrapMode="word">{value}</text>
  </box>
}

export function SettingsField({ label, description, value, placeholder, maxLength, submitHint = "Enter saves", onInput, onSubmit }: { label: string; description: string; value: string; placeholder: string; maxLength: number; submitHint?: string; onInput: (value: string) => void; onSubmit: (value: string) => void }) {
  return <box style={{ width: "100%", flexDirection: "column", gap: 1 }}>
    <text><span fg={theme.accent}><b>{label}</b></span><span fg={theme.muted}> — {description}</span></text>
    <box style={{ width: "100%", height: 3, border: true, borderColor: theme.line, backgroundColor: theme.surface, paddingLeft: 1, paddingRight: 1 }}>
      <input focused textColor={theme.text} backgroundColor={theme.surface} focusedTextColor={theme.text} focusedBackgroundColor={theme.selected} placeholderColor={theme.muted} value={value} placeholder={placeholder} onInput={onInput} onSubmit={(submitted) => onSubmit(typeof submitted === "string" ? submitted : value)} maxLength={maxLength} />
    </box>
    <text fg={theme.muted}>{submitHint} · Esc cancels</text>
  </box>
}

export function SettingsConfirm({ question, detail, confirmLabel, cancelLabel = "Cancel", destructive = false, onConfirm, onCancel }: { question: React.ReactNode; detail: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const options: MouseSelectOption[] = [
    { name: confirmLabel, description: detail, value: "confirm", tone: destructive ? "danger" : "accent" },
    { name: cancelLabel, description: "Go back without making a change", value: "cancel" },
  ]
  return <box style={{ width: "100%", height: "100%", minHeight: 0, flexDirection: "column", gap: 1 }}>
    <text wrapMode="word"><b>{question}</b></text>
    {destructive ? <SettingsNotice tone="danger">{detail}</SettingsNotice> : <text fg={theme.muted} wrapMode="word">{detail}</text>}
    <MouseSelect focused selectedIndex={destructive ? 1 : 0} height={7} options={options} descriptionMode="panel" onSelect={(_, option) => option?.value === "confirm" ? onConfirm() : onCancel()} wrapSelection />
  </box>
}
