import { type ScrollBoxRenderable } from "@opentui/core"
import { type SelectProps } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { terminalWidth } from "../utils"

export function MouseSelect(props: SelectProps) {
  const options = props.options ?? []
  const [selectedIndex, setSelectedIndex] = useState(() => Math.min(props.selectedIndex ?? 0, Math.max(0, options.length - 1)))
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [descriptionOffset, setDescriptionOffset] = useState(0)
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const menuId = useRef(crypto.randomUUID()).current
  const showDescription = props.showDescription ?? true
  const showSelectionIndicator = props.showSelectionIndicator ?? true
  const activeIndex = hoveredIndex ?? selectedIndex
  const activeDescription = options[activeIndex]?.description ?? ""

  useEffect(() => {
    if (!showDescription || !activeDescription) return
    let offset = 0
    let pauseTicks = 10
    setDescriptionOffset(0)
    const timer = setInterval(() => {
      const viewportWidth = scrollboxRef.current?.viewport.width ?? 0
      const text = `${showSelectionIndicator ? "  " : ""}${activeDescription}`
      const maxOffset = Math.max(0, terminalWidth(text) - viewportWidth)
      if (!maxOffset) return
      if (pauseTicks > 0) pauseTicks--
      else if (offset < maxOffset) offset++
      else { offset = 0; pauseTicks = 10 }
      setDescriptionOffset(offset)
    }, 125)
    return () => clearInterval(timer)
  }, [activeDescription, showDescription, showSelectionIndicator])

  function changeSelection(index: number) {
    if (!options.length) return
    const nextIndex = props.wrapSelection ? (index + options.length) % options.length : Math.max(0, Math.min(index, options.length - 1))
    setSelectedIndex(nextIndex)
    props.onChange?.(nextIndex, options[nextIndex])
    scrollboxRef.current?.scrollChildIntoView(`${menuId}-${nextIndex}`)
  }
  function selectOption(index: number) { changeSelection(index); props.onSelect?.(index, options[index] ?? null) }

  return <box width={props.width} height={props.height} style={{ ...props.style, flexShrink: 1, minHeight: 0, overflow: "hidden", backgroundColor: props.style?.backgroundColor ?? "#1a1a1a" }}><scrollbox ref={scrollboxRef} focused={props.focused} width="100%" height="100%" style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} onKeyDown={(key) => {
    if (key.name === "up" || key.name === "k") { key.preventDefault(); setHoveredIndex(null); changeSelection(selectedIndex - 1) }
    else if (key.name === "down" || key.name === "j") { key.preventDefault(); setHoveredIndex(null); changeSelection(selectedIndex + 1) }
    else if (key.name === "return" || key.name === "linefeed") { key.preventDefault(); setHoveredIndex(null); selectOption(selectedIndex) }
  }}>
    {options.map((option, index) => { const highlighted = index === activeIndex; return <box id={`${menuId}-${index}`} key={index} width="100%" height={showDescription ? 2 : 1} flexShrink={0} overflow="hidden" backgroundColor={highlighted ? props.selectedBackgroundColor ?? "#334455" : undefined} onMouseMove={() => setHoveredIndex(index)} onMouseOut={() => setHoveredIndex(null)} onMouseDown={(event) => { if (event.button === 0) { selectOption(index); event.stopPropagation() } }}>
      <text fg={highlighted ? props.selectedTextColor ?? "#FFFF00" : props.textColor ?? "#FFFFFF"}>{showSelectionIndicator ? highlighted ? " ▶ " : "   " : " "}{option.name}</text>
      {showDescription && <text wrapMode="none" fg={highlighted ? props.selectedDescriptionColor ?? "#CCCCCC" : props.descriptionColor ?? "#888888"}>{showSelectionIndicator ? "   " : " "}{highlighted ? Array.from(option.description).slice(descriptionOffset).join("") : option.description}</text>}
    </box> })}
  </scrollbox></box>
}
