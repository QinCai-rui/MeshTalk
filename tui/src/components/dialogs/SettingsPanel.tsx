import { useEffect, useRef, useState, type ReactNode } from "react"
import { useKeyboard, useRenderer } from "@opentui/react"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { chatTheme as theme } from "../../chatTheme"
import { dialogUsesTextInput } from "../../navigation"
import type { Dialog } from "../../types"
import { SettingsBusyContext, SettingsPanelContext } from "./SettingsInteraction"

const categories = [
  ["rename", "Profile"],
  ["customisation", "Appearance"],
  ["notifications", "Notifications"],
  ["accessibility", "Accessibility"],
  ["control", "Connection"],
  ["friends", "Friends"],
  ["rooms", "Private rooms"],
  ["files", "Files & transfers"],
  ["advanced", "Advanced"],
  ["debug", "Diagnostics"],
  ["about", "About & updates"],
] as const

export function settingsCategory(kind: Dialog["kind"]) {
  if (kind.startsWith("advanced")) return "advanced"
  if (kind.startsWith("control")) return "control"
  if (kind.startsWith("customisation")) return "customisation"
  if (kind.startsWith("notification") || kind.startsWith("mute") || kind.startsWith("unmute")) return "notifications"
  if (kind.includes("friend") || kind.startsWith("block")) return "friends"
  if (kind.startsWith("room")) return "rooms"
  if (kind.startsWith("debug")) return "debug"
  if (kind.startsWith("file") || kind === "files-dir") return "files"
  if (kind.startsWith("update")) return "about"
  return kind
}

export function usesSettingsPanel(dialog: Dialog) {
  return !["file-send", "file-list", "image-view", "delivery-details", "group-detail"].includes(dialog.kind)
}

export function SettingsPanel({ dialog, width, height, busy, error, runCommand, goBack, children }: {
  dialog: Dialog; width: number; height: number; busy: boolean; error: string
  runCommand: (command: string) => void; goBack: () => void; children: ReactNode
}) {
  const renderer = useRenderer()
  const rail = useRef<ScrollBoxRenderable>(null)
  const body = useRef<ScrollBoxRenderable>(null)
  const lastFocus = useRef<Renderable | null>(null)
  const [railFocused, setRailFocused] = useState(false)
  const category = settingsCategory(dialog.kind)
  const active = categories.findIndex(([id]) => id === category)
  const [railIndex, setRailIndex] = useState(Math.max(0, active))
  const firstRun = "firstRun" in dialog && dialog.firstRun
  const wide = width >= 76 && !firstRun
  const [showCategories, setShowCategories] = useState(false)
  const showRail = !firstRun && (wide || showCategories)

  function focusContent() {
    setRailFocused(false)
    setShowCategories(false)
    if (lastFocus.current && !lastFocus.current.isDestroyed) lastFocus.current.focus()
  }
  function focusRail() {
    lastFocus.current = renderer.currentFocusedRenderable
    setShowCategories(true)
    setRailFocused(true)
  }
  useEffect(() => { if (railFocused) rail.current?.focus() }, [railFocused, showRail])
  useEffect(() => {
    setRailIndex(Math.max(0, active))
    setRailFocused(false)
    setShowCategories(false)
    lastFocus.current = null
    body.current?.scrollTo(0)
  }, [dialog.kind])

  useEffect(() => {
    let previous: Renderable | null = null
    const revealFocus = () => {
      const focused = renderer.currentFocusedRenderable
      if (focused === previous || !focused) return
      previous = focused
      if (focused !== rail.current) body.current?.scrollChildIntoView(focused.id)
    }
    renderer.on("frame", revealFocus)
    return () => { renderer.off("frame", revealFocus) }
  }, [renderer])

  useKeyboard(key => {
    if (busy || firstRun || key.defaultPrevented) return
    if (key.name === "tab") {
      key.preventDefault()
      if (railFocused) focusContent()
      else focusRail()
    }
    if (key.name === "left" && !dialogUsesTextInput(dialog) && !railFocused) { key.preventDefault(); focusRail() }
  })
  const selectCategory = (index: number) => {
    if (busy) return
    focusContent()
    setRailFocused(false)
    setShowCategories(false)
    runCommand(categories[index]![0])
  }
  return <SettingsPanelContext.Provider value={true}><SettingsBusyContext.Provider value={busy}><box id="settings-panel" width="100%" height="100%" flexDirection="column" minHeight={0}>
    <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
      <text fg={theme.accent}><b>{firstRun ? "Welcome to MeshTalk" : "Settings"}</b></text>
      <box onMouseDown={() => { if (!busy) goBack() }}><text fg={theme.muted}>{dialogUsesTextInput(dialog) ? "Cancel [Esc]" : "Back [Esc]"}</text></box>
    </box>
    {!wide && !firstRun && <box height={1} flexShrink={0} onMouseDown={() => railFocused ? focusContent() : focusRail()}><text fg={theme.accent}>Categories [Tab] / {active >= 0 ? categories[active]![1] : "Choose a section"}</text></box>}
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} marginTop={height > 12 ? 1 : 0}>
      {showRail && <scrollbox id="settings-categories" ref={rail} focused={railFocused} width={wide ? 21 : "100%"} flexShrink={0} backgroundColor={theme.surface}
        contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.surface } }}
        onKeyDown={key => {
          if (busy || key.ctrl || key.meta) return
          let next = railIndex
          if (key.name === "up" || key.name === "k") next = (railIndex + categories.length - 1) % categories.length
          else if (key.name === "down" || key.name === "j") next = (railIndex + 1) % categories.length
          else if (key.name === "return" || key.name === "linefeed") { key.preventDefault(); selectCategory(railIndex); return }
          else if (key.name === "right") { key.preventDefault(); focusContent(); return }
          else return
          key.preventDefault()
          setRailIndex(next)
          rail.current?.scrollChildIntoView("settings-category-" + next)
        }}>
        {categories.map(([id, label], index) => <box id={"settings-category-" + index} key={id} height={2} flexShrink={0} paddingLeft={1} paddingRight={1}
          backgroundColor={(railFocused ? railIndex === index : category === id) ? theme.selected : theme.surface}
          onMouseDown={event => { if (event.button === 0) selectCategory(index) }}>
          <text fg={category === id ? theme.accent : theme.text}>{railFocused && railIndex === index ? "> " : category === id ? "• " : "  "}{label}</text>
        </box>)}
      </scrollbox>}
      <scrollbox visible={wide || !showRail} id="settings-content" ref={body} key={dialog.kind} flexGrow={1} flexBasis={0} minWidth={0} minHeight={0} paddingLeft={wide ? 2 : 0}
        contentOptions={{ flexDirection: "column", gap: 1 }}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.surfaceRaised } }}>
        {error && <text fg={theme.danger} wrapMode="word">Error: {error}</text>}
        <box minHeight={Math.max(1, height - 6)} flexDirection="column" gap={1}>
          {children}
        </box>
      </scrollbox>
    </box>
    <text fg={busy ? theme.warning : theme.muted} flexShrink={0} wrapMode="word">{busy ? "Working…" : dialogUsesTextInput(dialog) ? "Enter save · Esc cancel · Tab categories" : width < 50 ? "↑↓/JK · Enter · Esc back · Tab" : "↑↓/JK · Enter · Esc/Bksp back · Tab categories · PgUp/Dn details"}</text>
  </box></SettingsBusyContext.Provider></SettingsPanelContext.Provider>
}
