import { useContext, useEffect, useState } from "react"
import { SettingsPanelContext } from "./dialogs/SettingsInteraction"
import type { SelectProps } from "@opentui/react"
import { terminalWidth, clipTextToWidth } from "../utils"

type MarqueeTextProps = {
  text: string
  width: number
  fg?: SelectProps["selectedTextColor"]
  segments?: Array<{ text: string; fg?: SelectProps["selectedTextColor"] }>
  animateInSettings?: boolean
}

export function MarqueeText({ text, width, fg, segments, animateInSettings = false }: MarqueeTextProps) {
  const inSettings = useContext(SettingsPanelContext)
  const shouldAnimate = !inSettings || animateInSettings
  const [offset, setOffset] = useState(0)
  const viewportWidth = Math.max(1, width)
  const fullText = segments?.map(segment => segment.text).join("") ?? text
  const maxOffset = Math.max(0, terminalWidth(fullText) - viewportWidth)

  useEffect(() => {
    if (!shouldAnimate) return
    if (!maxOffset) {
      setOffset(0)
      return
    }
    let currentOffset = 0
    let pauseTicks = 10
    let endPauseTicks = 0
    const timer = setInterval(() => {
      if (pauseTicks > 0) pauseTicks--
      else if (currentOffset < maxOffset) currentOffset++
      else if (endPauseTicks < 10) endPauseTicks++
      else {
        currentOffset = 0
        pauseTicks = 10
        endPauseTicks = 0
      }
      setOffset(currentOffset)
    }, 125)
    return () => clearInterval(timer)
  }, [maxOffset, shouldAnimate])

  let visibleText = fullText
  let startIndex = 0
  if (maxOffset > 0) {
    let currentWidth = 0
    for (let i = 0; i < fullText.length && currentWidth < offset; i++) {
      const char = fullText[i]
      const codePoint = char.codePointAt(0)
      if (codePoint === undefined) continue
      const isCombining = (codePoint >= 0x0300 && codePoint <= 0x036F) || (codePoint >= 0x1AB0 && codePoint <= 0x1AFF) || (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) || (codePoint >= 0x20D0 && codePoint <= 0x20FF) || (codePoint >= 0xFE20 && codePoint <= 0xFE2F)
      if (!isCombining) {
        currentWidth += codePoint > 0xff ? 2 : 1
        if (currentWidth <= offset) startIndex = i + 1
      }
    }
    visibleText = clipTextToWidth(fullText.substring(startIndex), viewportWidth)
  }

  const renderText = () => {
    if (!segments) return <span fg={fg}>{visibleText}</span>
    let position = 0
    return segments.map((segment, index) => {
      const segmentStart = position
      const segmentEnd = position + segment.text.length
      position = segmentEnd
      const visibleStart = Math.max(segmentStart, startIndex)
      const visibleEnd = Math.min(segmentEnd, startIndex + visibleText.length)
      if (visibleEnd <= visibleStart) return null
      return <span key={index} fg={segment.fg}>{segment.text.slice(visibleStart - segmentStart, visibleEnd - segmentStart)}</span>
    })
  }

  if (!shouldAnimate) return <text wrapMode="word">{segments ? segments.map((segment, index) => <span key={index} fg={segment.fg}>{segment.text}</span>) : <span fg={fg}>{text}</span>}</text>
  return <box width={viewportWidth} height={1} overflow="hidden" flexShrink={0}><text wrapMode="none">{renderText()}</text></box>
}
