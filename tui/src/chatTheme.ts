export const chatTheme = {
  canvas: "#141b24",
  surface: "#1c2633",
  surfaceRaised: "#111923",
  overlay: "#080b1099",
  selected: "#2b4050",
  text: "#e1e8ef",
  muted: "#a4b2c2",
  subdued: "#718096",
  accent: "#8bd5ca",
  link: "#65a9ff",
  line: "#435568",
  warning: "#f0c674",
  danger: "#ff9292",
  dangerSurface: "#3a2022",
  success: "#66dd88",
  successSurface: "#1a3320",
  caution: "#ff9f43",
  presence: {
    active: "#66dd88",
    away: "#f0c674",
    offline: "#a4b2c2",
    self: "#65a9ff",
  },
  markdown: {
    default: "#d6deeb",
    heading: "#7aa2d6",
    link: "#65a9ff",
    raw: "#a5d6ff",
    list: "#ff9f43",
    keyword: "#ff7b72",
    comment: "#8b949e",
    number: "#79c0ff",
    function: "#d2a8ff",
    type: "#ffa657",
    punctuation: "#c9d1d9",
  },
  menu: {
    background: "#1c2633",
    selectedText: "#e1e8ef",
    selectedDescription: "#a4b2c2",
  },
  splash: {
    canvas: "#070a0f",
    logCanvas: "#05070c",
    surface: "#0c111b",
    border: "#4a5f8a",
    title: "#9db4e8",
    muted: "#5c7196",
    dim: "#2e3a52",
    accent: "#65d6b4",
    accentLight: "#ecfff9",
    violet: "#a997ff",
    pink: "#f0d7ff",
    gold: "#ffd98a",
    text: "#d5deed",
    notice: "#9aa8bd",
    subtle: "#687386",
    build: "#354867",
    buildLabel: "#3f516f",
    white: "#ffffff",
    divider: "#2e3f5c",
    mesh: "#b3a3ff",
    talk: "#45c2b8",
    progressTrack: "#141d2e",
    phaseMuted: "#5c6f92",
    phaseText: "#e4eaf7",
    phaseActiveText: "#c7d3e8",
    phaseInactiveText: "#4a5773",
    connector: "#232e44",
    version: "#8fa7c9",
    bootSuccess: "#3ddc97",
    wordmark: ["#d7e3ff", "#becff5", "#a4bbed", "#8aa6df", "#718fcf", "#5d7abd"],
  },
} as const

export const presenceIndicator = (presence: "active" | "away" | "offline") =>
  presence === "active" ? "●" : presence === "away" ? "~" : "○"

export function unreadMessageBackground(progress: number): string {
  const start = [103, 82, 40]
  const end = [40, 32, 24]
  const amount = Math.min(1, Math.max(0, progress))
  const channels = start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

export function chatLayout(width: number) {
  const stacked = width < 64
  const sidebarWidth = stacked ? width : width < 100 ? 25 : 30
  return { stacked, sidebarWidth, panelWidth: Math.max(1, width - (stacked ? 0 : sidebarWidth + 1)) }
}
