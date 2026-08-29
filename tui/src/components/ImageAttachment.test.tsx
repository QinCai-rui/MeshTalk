import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { mkdir, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { ImageAttachment, detectImageFormat, fittedImageSize } from "./ImageAttachment"
import { goBack } from "../navigation"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JNNsAAAAASUVORK5CYII="

test("identifies supported formats and fits an image within its terminal area", () => {
  expect(detectImageFormat(new Uint8Array(Buffer.from(PNG, "base64")))).toBe("png")
  expect(detectImageFormat(new Uint8Array([0x42, 0x4d]))).toBeUndefined()
  expect(fittedImageSize(1600, 900, 40, 12)).toEqual({ width: 40, height: 12 })
})

test("opens a loaded thumbnail with a mouse click", async () => {
  const directory = join(tmpdir(), `meshtalk-image-test-${crypto.randomUUID()}`)
  const filePath = join(directory, "image.png")
  await mkdir(directory)
  await Bun.write(filePath, Buffer.from(PNG, "base64"))
  let opened = 0
  const setup = await testRender(
    <ImageAttachment filePath={filePath} filename="image.png" protocol="blocks" expectedImage lazy={false} maxWidth={20} maxHeight={8} onOpen={() => { opened += 1 }} />,
    { width: 30, height: 10 },
  )
  try {
    const frame = await setup.waitForFrame((value) => value.includes("Loading image"))
    expect(frame).toContain("Loading image")
    await setup.mockMouse.click(1, 0)
    expect(opened).toBe(1)
  } finally {
    setup.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("Escape navigation closes the full-screen image preview", () => {
  let closed = 0
  goBack({ dialog: { kind: "image-view", filePath: "/definitely/missing/image.png", filename: "image.png" }, selection: undefined, fileTransfers: [], closeDialog: () => { closed += 1 }, showDialog: () => {}, loadAdvancedConfig: async () => {}, loadRooms: async () => {}, loadFriendRequests: async () => {}, loadBlockedPeers: async () => {} })
  expect(closed).toBe(1)
})
