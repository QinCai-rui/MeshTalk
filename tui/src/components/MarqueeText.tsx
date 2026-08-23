import { useEffect, useState } from "react"
import { terminalWidth, clipTextToWidth } from "../utils"

type MarqueeTextProps = {
  text: string
  width: number
  fg?: string
}

export function MarqueeText({ text, width, fg }: MarqueeTextProps) {
  const [offset, setOffset] = useState(0)
  const viewportWidth = Math.max(1, width)
  const maxOffset = Math.max(0, terminalWidth(text) - viewportWidth)

  useEffect(() => {
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
  }, [maxOffset])

  let visibleText = text
  if (maxOffset > 0) {
    let currentWidth = 0
    let startIndex = 0
    for (let i = 0; i < text.length && currentWidth < offset; i++) {
      const char = text[i]
      const codePoint = char.codePointAt(0)
      if (codePoint === undefined) continue
      const isCombining = (codePoint >= 0x0300 && codePoint <= 0x036F) || (codePoint >= 0x1AB0 && codePoint <= 0x1AFF) || (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) || (codePoint >= 0x20D0 && codePoint <= 0x20FF) || (codePoint >= 0xFE20 && codePoint <= 0xFE2F)
      if (!isCombining) {
        currentWidth += codePoint > 0xff ? 2 : 1
        if (currentWidth <= offset) startIndex = i + 1
      }
    }
    visibleText = clipTextToWidth(text.substring(startIndex), viewportWidth)
  }

  return <box width={viewportWidth} height={1} overflow="hidden" flexShrink={0}><text wrapMode="none" fg={fg}>{visibleText}</text></box>
}
