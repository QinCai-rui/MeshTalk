import { expect, test } from "bun:test"
import { act, createRef } from "react"
import { testRender } from "@opentui/react/test-utils"
import type { BoxRenderable } from "@opentui/core"
import { HoverHighlight } from "./HoverHighlight"

test("hover highlight exposes a stable hover state without changing layout", async () => {
  const targetRef = createRef<BoxRenderable>()
  const setup = await testRender(
    <box width={20} height={3} flexDirection="column">
      <HoverHighlight id="hover-target" ref={targetRef} width={10} height={1}>
        {hovered => <text>{hovered ? "Hovered" : "Idle"}</text>}
      </HoverHighlight>
    </box>,
    { width: 20, height: 3 },
  )

  try {
    await setup.renderOnce()
    const target = setup.renderer.root.findDescendantById("hover-target")!
    expect(targetRef.current?.id).toBe(target.id)
    const originalWidth = target.width
    expect(setup.captureCharFrame()).toContain("Idle")

    await act(async () => {
      await setup.mockMouse.moveTo(target.screenX, target.screenY)
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("Hovered")
    expect(target.width).toBe(originalWidth)

  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("active and disabled controls suppress hover presentation", async () => {
  const setup = await testRender(
    <box width={24} height={3} flexDirection="column">
      <HoverHighlight id="active-target" active width={16} height={1}>
        {hovered => <text>{hovered ? "Active hovered" : "Active stable"}</text>}
      </HoverHighlight>
      <HoverHighlight id="disabled-target" disabled width={16} height={1}>
        {hovered => <text>{hovered ? "Disabled hovered" : "Disabled stable"}</text>}
      </HoverHighlight>
    </box>,
    { width: 24, height: 3 },
  )

  try {
    await setup.renderOnce()
    for (const id of ["active-target", "disabled-target"]) {
      const target = setup.renderer.root.findDescendantById(id)!
      await act(async () => {
        await setup.mockMouse.moveTo(target.screenX, target.screenY)
        await setup.renderOnce()
      })
    }
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Active stable")
    expect(frame).toContain("Disabled stable")
    expect(frame).not.toContain("hovered")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
