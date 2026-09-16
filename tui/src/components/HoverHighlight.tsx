import type { ReactNode } from "react"
import { useState } from "react"
import type { BoxProps } from "@opentui/react"
import type { BoxRenderable } from "@opentui/core"
import { chatTheme as theme } from "../chatTheme"

type HoverHighlightProps = Omit<BoxProps, "children"> & {
  active?: boolean
  disabled?: boolean
  hoverBackgroundColor?: string
  children?: ReactNode | ((hovered: boolean) => ReactNode)
}

/**
 * Gives mouse-activated controls a consistent, layout-stable hover affordance.
 * `active` preserves stronger selected states and `disabled` suppresses hover.
 */
export function HoverHighlight({ active = false, disabled = false, hoverBackgroundColor = theme.hover, children, style, onMouseOver, onMouseMove, onMouseOut, ...props }: HoverHighlightProps) {
  const [hovered, setHovered] = useState(false)
  const highlighted = !disabled && hovered

  return <box
    {...props}
    style={{ ...style, backgroundColor: highlighted && !active ? hoverBackgroundColor : style?.backgroundColor }}
    onMouseOver={(event) => { if (!disabled) setHovered(true); onMouseOver?.call(event.currentTarget as BoxRenderable, event) }}
    onMouseMove={(event) => { if (!disabled) setHovered(true); onMouseMove?.call(event.currentTarget as BoxRenderable, event) }}
    onMouseOut={(event) => { setHovered(false); onMouseOut?.call(event.currentTarget as BoxRenderable, event) }}
  >
    {typeof children === "function" ? children(highlighted) : children}
  </box>
}
