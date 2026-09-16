import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { HoverHighlight } from "./HoverHighlight"

test("hover highlight exposes a stable hover state without changing layout", async () => {
  const setup = await testRender(
    <box width={20} height={3} flexDirection="column">
      <HoverHighlight id="hover-target" width={10} height={1}>
        {hovered => <text>{hovered ? "Hovered" : "Idle"}</text>}
      </HoverHighlight>
    </box>,
    { width: 20, height: 3 },
  )

  try {
    await setup.renderOnce()
    const target = setup.renderer.root.findDescendantById("hover-target")!
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
