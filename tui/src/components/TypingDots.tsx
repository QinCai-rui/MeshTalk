import { extend } from "@opentui/react"
import { SpinnerRenderable } from "opentui-spinner"
import { chatTheme } from "../chatTheme"

extend({ spinner: SpinnerRenderable })

export function TypingDots() {
  return <spinner name="simpleDotsScrolling" color={chatTheme.accent} />
}
