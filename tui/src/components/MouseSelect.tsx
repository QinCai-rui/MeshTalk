import { type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, type SelectProps } from "@opentui/react"
import type { SelectOption } from "@opentui/core"
import { useContext, useEffect, useRef, useState } from "react"
import { SettingsBusyContext, SettingsPanelContext } from "./dialogs/SettingsInteraction"
import { terminalWidth } from "../utils"
import { MarqueeText } from "./MarqueeText"
import { chatTheme as theme } from "../chatTheme"

export type MouseSelectOption = SelectOption & {
  section?: string
  status?: string
  tone?: "default" | "success" | "warning" | "danger" | "accent"
}

type MouseSelectProps = Omit<SelectProps, "options" | "onChange" | "onSelect"> & {
  options?: MouseSelectOption[]
  marqueeNames?: boolean
  descriptionMode?: "row" | "panel" | "hidden"
  onChange?: (index: number, option: MouseSelectOption) => void
  onSelect?: (index: number, option: MouseSelectOption | null) => void
}

export function MouseSelect(props: MouseSelectProps) {
  const renderer = useRenderer()
  const busy = useContext(SettingsBusyContext)
  const inSettings = useContext(SettingsPanelContext)
  const options = props.options ?? []
  const [selectedIndex, setSelectedIndex] = useState(() => Math.min(props.selectedIndex ?? 0, Math.max(0, options.length - 1)))
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [descriptionOffset, setDescriptionOffset] = useState(0)
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const descriptionRef = useRef<ScrollBoxRenderable>(null)
  const menuId = useRef(crypto.randomUUID()).current
  const showDescription = props.showDescription ?? true
  const descriptionMode = props.descriptionMode ?? (showDescription ? inSettings ? "panel" : "row" : "hidden")
  const showSelectionIndicator = props.showSelectionIndicator ?? true
  const descriptionPrefix = showSelectionIndicator ? "   " : " "
  const activeIndex = hoveredIndex ?? selectedIndex
  const activeDescription = options[activeIndex]?.description ?? ""
  // Descriptive options consume two rows, so reserve room for at least two.
  // Dialog content scrollboxes shrink before action menus do.
  const menuHeight = typeof props.height === "number" ? Math.max(1, props.height) : props.height
  const optionWidth = typeof props.width === "number" ? props.width : 64
  const nameWidth = Math.max(1, optionWidth - (showSelectionIndicator ? 3 : 1))

  useEffect(() => {
    if (descriptionMode !== "row" || !activeDescription) return
    let offset = 0
    let pauseTicks = 10
    let endPauseTicks = 0
    setDescriptionOffset(0)
    const timer = setInterval(() => {
      const viewportWidth = scrollboxRef.current?.viewport.width ?? 0
      const descriptionWidth = Math.max(0, viewportWidth - terminalWidth(descriptionPrefix))
      const maxOffset = Math.max(0, terminalWidth(activeDescription) - descriptionWidth)
      if (!maxOffset) return
      if (pauseTicks > 0) pauseTicks--
      else if (offset < maxOffset) offset++
      else if (endPauseTicks < 10) endPauseTicks++
      else { offset = 0; pauseTicks = 10; endPauseTicks = 0 }
      setDescriptionOffset(offset)
    }, 125)
    return () => clearInterval(timer)
  }, [activeDescription, descriptionMode, showSelectionIndicator])

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, options.length - 1)))
    setHoveredIndex(null)
  }, [options.length])
  useEffect(() => { descriptionRef.current?.scrollTo(0) }, [activeDescription])
  useEffect(() => {
    if (!props.focused) return
    const reveal = () => {
      const id = `${menuId}-${selectedIndex}`
      scrollboxRef.current?.scrollChildIntoView(id)
      // A short settings pane may also clip the menu itself.
      if (inSettings) {
        let parent = scrollboxRef.current?.parent
        while (parent) {
          if ("scrollChildIntoView" in parent) (parent as ScrollBoxRenderable).scrollChildIntoView(id)
          parent = parent.parent
        }
      }
    }
    renderer.once("frame", reveal)
    return () => { renderer.off("frame", reveal) }
  }, [renderer, selectedIndex, menuId, props.focused, inSettings, menuHeight])

  function changeSelection(index: number) {
    if (!options.length) return
    const nextIndex = props.wrapSelection ? (index + options.length) % options.length : Math.max(0, Math.min(index, options.length - 1))
    setSelectedIndex(nextIndex)
    props.onChange?.(nextIndex, options[nextIndex])
    scrollboxRef.current?.scrollChildIntoView(`${menuId}-${nextIndex}`)
  }
  function selectOption(index: number) { if (busy || !options[index]) return; changeSelection(index); props.onSelect?.(index, options[index]) }

  const listHeight = typeof menuHeight === "number" && descriptionMode === "panel" ? Math.max(1, menuHeight - (menuHeight >= 7 ? 3 : 2)) : "100%"
  const descriptionHeight = typeof menuHeight === "number" && menuHeight >= 7 ? 3 : 2
  const toneColor = (tone: MouseSelectOption["tone"]) => tone === "success" ? theme.success : tone === "warning" ? theme.warning : tone === "danger" ? theme.danger : tone === "accent" ? theme.accent : theme.text

  return <box width={props.width} height={menuHeight} style={{ ...props.style, flexShrink: 0, minHeight: 0, overflow: "hidden", flexDirection: "column", backgroundColor: props.style?.backgroundColor ?? theme.menu.background }}><scrollbox ref={scrollboxRef} focused={props.focused} width="100%" height={listHeight} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.menu.background } }} onKeyDown={(key) => {
    if (busy) { key.preventDefault(); return }
    if (key.ctrl || key.meta || key.super) return
    if (descriptionMode === "panel" && (key.name === "pagedown" || key.name === "pageup")) { key.preventDefault(); descriptionRef.current?.scrollBy(key.name === "pagedown" ? 1 : -1, "viewport"); return }
    if (key.name === "home") { key.preventDefault(); setHoveredIndex(null); changeSelection(0) }
    else if (key.name === "end") { key.preventDefault(); setHoveredIndex(null); changeSelection(options.length - 1) }
    else if (key.name === "up" || key.name === "k") { key.preventDefault(); setHoveredIndex(null); changeSelection(selectedIndex - 1) }
    else if (key.name === "down" || key.name === "j") { key.preventDefault(); setHoveredIndex(null); changeSelection(selectedIndex + 1) }
    else if (key.name === "return" || key.name === "linefeed") { key.preventDefault(); setHoveredIndex(null); selectOption(selectedIndex) }
  }} onMouseScroll={(event) => {
    const pointerY = event.y
    // Native ScrollBox handling updates child coordinates before this timer runs.
    setTimeout(() => {
      const index = scrollboxRef.current?.getChildren().findIndex((child) => pointerY >= child.y && pointerY < child.y + child.height) ?? -1
      setHoveredIndex(index >= 0 ? index : null)
    }, 0)
  }}>
    {options.map((option, index) => {
      const highlighted = index === activeIndex
      const nameColor = highlighted ? props.selectedTextColor ?? theme.menu.selectedText : option.tone ? toneColor(option.tone) : props.textColor ?? theme.text
      let descriptionText = option.description
      if (highlighted && showDescription && descriptionOffset > 0) {
        const fullText = option.description
        let currentWidth = 0
        let startIndex = 0
        for (let i = 0; i < fullText.length && currentWidth < descriptionOffset; i++) {
          const char = fullText[i]
          const codePoint = char.codePointAt(0)
          if (codePoint === undefined) continue
          const isCombining = (codePoint >= 0x0300 && codePoint <= 0x036F) || (codePoint >= 0x1AB0 && codePoint <= 0x1AFF) || (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) || (codePoint >= 0x20D0 && codePoint <= 0x20FF) || (codePoint >= 0xFE20 && codePoint <= 0xFE2F)
          if (!isCombining) {
            currentWidth += codePoint > 0xff ? 2 : 1
            if (currentWidth <= descriptionOffset) startIndex = i + 1
          }
        }
        descriptionText = fullText.substring(startIndex)
      }
      const sectionChanged = option.section && option.section !== options[index - 1]?.section
      const rowHeight = (descriptionMode === "row" ? 2 : 1) + (sectionChanged ? 1 : 0)
      return <box id={`${menuId}-${index}`} key={index} width="100%" height={rowHeight} flexShrink={0} overflow="hidden" backgroundColor={highlighted ? props.selectedBackgroundColor ?? theme.selected : undefined} onMouseMove={() => setHoveredIndex(index)} onMouseOut={() => setHoveredIndex(null)} onMouseDown={(event) => { if (event.button === 0) { selectOption(index); event.stopPropagation() } }}>
        {sectionChanged ? <text fg={theme.subdued}><b>{option.section!.toUpperCase()}</b></text> : null}
        {props.marqueeNames ? <box style={{ flexDirection: "row", width: "100%", height: 1, overflow: "hidden" }}>
          <box width={showSelectionIndicator ? 3 : 1} height={1} overflow="hidden"><text wrapMode="none" fg={nameColor}>{showSelectionIndicator ? highlighted ? " ▶" : "  " : ""}</text></box>
          <MarqueeText width={nameWidth} fg={nameColor} text={option.name} />
        </box> : <box style={{ width: "100%", height: 1, flexDirection: "row", paddingRight: 1 }}>
          <text fg={nameColor} style={{ flexGrow: 1, flexShrink: 1 }} truncate>{showSelectionIndicator ? highlighted ? " > " : "   " : " "}{option.name}</text>
          {option.status ? <text fg={toneColor(option.tone)} flexShrink={0}>[{option.status}]</text> : null}
        </box>}
        {descriptionMode === "row" && <text wrapMode="none" fg={highlighted ? props.selectedDescriptionColor ?? theme.menu.selectedDescription : props.descriptionColor ?? theme.muted}>{descriptionPrefix}{descriptionText}</text>}
      </box>
    })}
  </scrollbox>{descriptionMode === "panel" && activeDescription ? <scrollbox ref={descriptionRef} height={descriptionHeight} flexShrink={0} style={{ width: "100%", paddingLeft: 1, paddingRight: 1, backgroundColor: theme.surfaceRaised }} verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.line, backgroundColor: theme.surfaceRaised } }}><text fg={theme.menu.selectedDescription} wrapMode="word">{activeDescription}</text></scrollbox> : null}</box>
}
