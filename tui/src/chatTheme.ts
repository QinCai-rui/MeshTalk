// Shared by the main chat and file manager. Other dialogs retain their existing presentation.
export const chatTheme = {
  canvas: "#141b24",
  surface: "#1c2633",
  selected: "#2b4050",
  text: "#e1e8ef",
  muted: "#a4b2c2",
  accent: "#8bd5ca",
  line: "#435568",
  warning: "#f0c674",
  danger: "#ff9292",
} as const

export function chatLayout(width: number) {
  const stacked = width < 64
  const sidebarWidth = stacked ? width : width < 100 ? 25 : 30
  return { stacked, sidebarWidth, panelWidth: Math.max(1, width - (stacked ? 0 : sidebarWidth + 1)) }
}
