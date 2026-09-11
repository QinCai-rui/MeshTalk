import { chatTheme as theme } from "../chatTheme"

export type EmptyStateAction = {
  id: string
  label: string
  hint?: string
  onSelect: () => void
}

type EmptyStateProps = {
  id: string
  message: string
  detail?: string
  actions: EmptyStateAction[]
  compact?: boolean
}

/**
 * Small reusable empty-state: 1-2 lines of wrapped text plus clickable
 * underlined actions. Never steals composer focus and never renders a modal,
 * so drafts keyed by selectionKey are preserved. Narrow-terminal safe via
 * wrapMode="word" and a compact column layout.
 */
export function EmptyState({ id, message, detail, actions, compact = false }: EmptyStateProps) {
  return <box id={id} style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1 }}>
    <text fg={theme.muted} wrapMode="word">{message}</text>
    {detail ? <text fg={theme.muted} wrapMode="word">{detail}</text> : null}
    {actions.length > 0 ? <box style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap" }} gap={compact ? 0 : 2}>
      {actions.map(action => <box key={action.id} id={`${id}-${action.id}`} onMouseDown={event => { if (event.button === 0) { event.stopPropagation(); action.onSelect() } }}><text fg={theme.accent} wrapMode={compact ? "word" : "none"}>{action.hint ? `${action.hint} ` : ""}<u>{action.label}</u></text></box>)}
    </box> : null}
  </box>
}
