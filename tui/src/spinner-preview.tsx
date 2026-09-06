import { createCliRenderer } from "@opentui/core"
import { createRoot, extend, useKeyboard, useRenderer } from "@opentui/react"
import { useState } from "react"
import { SpinnerRenderable } from "opentui-spinner"
import { chatTheme as theme } from "./chatTheme"
extend({ spinner: SpinnerRenderable })

const spinnerNames = [
  "dots", "dots2", "dots3", "dots4", "dots5", "dots6", "dots7", "dots8", "dots9", "dots10", "dots11", "dots12", "dots13", "dots14", "dots8Bit", "dotsCircle", "sand",
  "line", "line2", "rollingLine", "pipe", "simpleDots", "simpleDotsScrolling", "star", "star2", "flip", "hamburger", "growVertical", "growHorizontal",
  "balloon", "balloon2", "noise", "bounce", "boxBounce", "boxBounce2", "triangle", "binary", "arc", "circle", "squareCorners", "circleQuarters", "circleHalves", "squish",
  "toggle", "toggle2", "toggle3", "toggle4", "toggle5", "toggle6", "toggle7", "toggle8", "toggle9", "toggle10", "toggle11", "toggle12", "toggle13",
  "arrow", "arrow2", "arrow3", "bouncingBar", "bouncingBall", "smiley", "monkey", "hearts", "clock", "earth", "material", "moon", "runner", "pong", "shark", "dqpb",
  "weather", "christmas", "grenade", "point", "layer", "betaWave", "fingerDance", "fistBump", "soccerHeader", "mindblown", "speaker", "orangePulse", "bluePulse", "orangeBluePulse", "timeTravel", "aesthetic", "dwarfFortress",
] as const

function SpinnerPreview() {
  const renderer = useRenderer()
  const [index, setIndex] = useState(0)
  const name = spinnerNames[index]

  useKeyboard((key) => {
    if (key.name === "left") setIndex((current) => (current - 1 + spinnerNames.length) % spinnerNames.length)
    if (key.name === "right" || key.name === "space") setIndex((current) => (current + 1) % spinnerNames.length)
    if (key.name === "q" || key.name === "escape") renderer.destroy()
  })

  return <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 1 }}>
    <text fg={theme.muted}>OpenTUI Spinner Preview</text>
    <box style={{ flexDirection: "row", alignItems: "center", gap: 1 }}>
      <spinner name={name as never} color={theme.markdown.heading} />
      <text>{name}</text>
    </box>
    <text fg={theme.muted}>{index + 1} / {spinnerNames.length}   Left/Right or Space: next   Q/Esc: quit</text>
  </box>
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<SpinnerPreview />)
