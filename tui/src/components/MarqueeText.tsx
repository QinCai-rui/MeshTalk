import { useEffect, useState } from "react"
import { terminalWidth } from "../utils"

type MarqueeTextProps = {
  text: string
  width: number
  fg?: string
}

export function MarqueeText({ text, width, fg }: MarqueeTextProps) {
  const [offset, setOffset] = useState(0)
  const viewportWidth = Math.max(1, width)
  const characters = Array.from(text)
  const maxOffset = Math.max(0, terminalWidth(text) - viewportWidth)

  useEffect(() => {
    if (!maxOffset) {
      setOffset(0)
      return
    }
    let currentOffset = 0
    let pauseTicks = 10
    const timer = setInterval(() => {
      if (pauseTicks > 0) pauseTicks--
      else if (currentOffset < maxOffset) currentOffset++
      else {
        currentOffset = 0
        pauseTicks = 10
      }
      setOffset(currentOffset)
    }, 125)
    return () => clearInterval(timer)
  }, [maxOffset])

  return <box width={viewportWidth} height={1} overflow="hidden" flexShrink={0}><text wrapMode="none" fg={fg}>{characters.slice(offset, offset + viewportWidth).join("")}</text></box>
}
