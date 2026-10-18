import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { mkdir, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { act, useState } from "react"
import { NativeImage } from "@opentui/core"
import { ImageAttachment, detectImageFormat, fittedImageSize, isFullyWithinViewport, isLocalFileMissing } from "./ImageAttachment"
import { ImageViewOverlay, imageViewerPropsEqual, imageViewOverlayPropsEqual } from "./DialogPanel"
import { goBack } from "../navigation"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JNNsAAAAASUVORK5CYII="
// Valid 1x1 RGBA PNG. The legacy PNG fixture above has a corrupt IDAT CRC:
// header sniffing accepts it, but the native decoder rejects it, so any test
// that must actually finish decoding has to use this one.
const VALID_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

test("identifies supported formats and fits an image within its terminal area", () => {
  expect(detectImageFormat(new Uint8Array(Buffer.from(PNG, "base64")))).toBe("png")
  expect(detectImageFormat(new Uint8Array([0x42, 0x4d]))).toBeUndefined()
  expect(fittedImageSize(1600, 900, 40, 12)).toEqual({ width: 40, height: 12 })
  expect(isFullyWithinViewport({ screenY: 6, height: 4 }, { screenY: 5, height: 8 })).toBe(true)
  expect(isFullyWithinViewport({ screenY: 4, height: 4 }, { screenY: 5, height: 8 })).toBe(false)
})

test("treats a directory as a missing local file", async () => {
  const directory = join(tmpdir(), `meshtalk-directory-test-${crypto.randomUUID()}`)
  await mkdir(directory)
  try { expect(isLocalFileMissing(directory)).toBe(true) }
  finally { await rm(directory, { recursive: true, force: true }) }
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

test("shows an unavailable state when an expected image cannot be loaded", async () => {
  const setup = await testRender(
    <ImageAttachment filePath={join(tmpdir(), `missing-${crypto.randomUUID()}.png`)} filename="missing.png" protocol="blocks" expectedImage lazy={false} maxWidth={20} maxHeight={8} />,
    { width: 30, height: 10 },
  )
  try {
    const frame = await setup.waitForFrame((value) => value.includes("unavailable)"))
    expect(frame).toContain("missing.png (image")
    expect(frame).toContain("unavailable)")
  } finally {
    setup.renderer.destroy()
  }
})

test("reloads the thumbnail once the transfer version advances", async () => {
  // Inbound transfers preallocate the destination file, so a thumbnail load
  // that races the transfer reads a half-written file and fails. The row must
  // retry once the transfer completes instead of sticking on "(image
  // unavailable)" until the conversation is revisited.
  const directory = join(tmpdir(), `meshtalk-image-retry-test-${crypto.randomUUID()}`)
  const filePath = join(directory, "photo.png")
  await mkdir(directory)
  await Bun.write(filePath, new Uint8Array(64))
  let advance: ((version: string) => void) | undefined
  function VersionedImage() {
    const [version, setVersion] = useState("transferring")
    advance = setVersion
    return <ImageAttachment filePath={filePath} filename="photo.png" protocol="blocks" expectedImage lazy={false} maxWidth={20} maxHeight={8} version={version} />
  }
  const setup = await testRender(<VersionedImage />, { width: 30, height: 10 })
  try {
    await setup.waitForFrame((value) => value.includes("unavailable)"))
    await Bun.write(filePath, Buffer.from(VALID_PNG, "base64"))
    await act(async () => { advance!("completed") })
    // waitForFrame stops polling once the renderer goes idle, which can win
    // the race against the async thumbnail decode. Poll explicitly instead,
    // and require the loaded state: right after the version change the row
    // briefly shows "Loading image...", which must not count as success.
    const settled = (value: string) => !value.includes("unavailable)") && !value.includes("Loading image")
    let frame = ""
    for (let attempt = 0; attempt < 40; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        await setup.renderOnce()
      })
      frame = setup.captureCharFrame()
      if (settled(frame)) break
    }
    expect(frame).not.toContain("unavailable)")
    expect(frame).not.toContain("Loading image")
  } finally {
    setup.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("memoizes the full-screen viewer until its display inputs change", () => {
  const props = { filePath: "/tmp/image.png", filename: "image.png", dialogWidth: 28, dialogHeight: 10, imageProtocol: "blocks" as const }
  expect(imageViewerPropsEqual(props, { ...props })).toBe(true)
  expect(imageViewerPropsEqual(props, { ...props, filePath: "/tmp/other.png" })).toBe(false)
  expect(imageViewerPropsEqual(props, { ...props, filename: "other.png" })).toBe(false)
  expect(imageViewerPropsEqual(props, { ...props, dialogWidth: 29 })).toBe(false)
  expect(imageViewerPropsEqual(props, { ...props, dialogHeight: 11 })).toBe(false)
  expect(imageViewerPropsEqual(props, { ...props, imageProtocol: "kitty" })).toBe(false)
})

test("treats different in-memory images as different full-screen viewers", () => {
  const props = { bytes: new Uint8Array([1]), filename: "pasted-image.png", dialogWidth: 28, dialogHeight: 10, imageProtocol: "blocks" as const }
  expect(imageViewerPropsEqual(props, { ...props, bytes: new Uint8Array([2]) })).toBe(false)
})

test("overlay comparator ignores close-callback identity but honors version", () => {
  const props = { filePath: "/tmp/image.png", filename: "image.png", dialogWidth: 28, dialogHeight: 10, imageProtocol: "blocks" as const, onClose: () => {} }
  expect(imageViewOverlayPropsEqual(props, { ...props, onClose: () => {} })).toBe(true)
  expect(imageViewOverlayPropsEqual(props, { ...props, filePath: "/tmp/other.png" })).toBe(false)
  expect(imageViewOverlayPropsEqual(props, { ...props, version: 42 })).toBe(false)
})

test("Escape navigation closes the full-screen image preview", () => {
  let closed = 0
  goBack({ dialog: { kind: "image-view", filePath: "/definitely/missing/image.png", filename: "image.png" }, selection: undefined, fileTransfers: [], closeDialog: () => { closed += 1 }, showDialog: () => {}, loadAdvancedConfig: async () => {}, loadRooms: async () => {}, loadFriendRequests: async () => {}, loadBlockedPeers: async () => {} })
  expect(closed).toBe(1)
})

test("fullscreen overlay survives unrelated parent updates without reloading", async () => {
  const directory = join(tmpdir(), `meshtalk-overlay-test-${crypto.randomUUID()}`)
  const filePath = join(directory, "photo.png")
  await mkdir(directory)
  await Bun.write(filePath, Buffer.from(VALID_PNG, "base64"))
  let bump: (() => void) | undefined
  function Parent() {
    const [count, setCount] = useState(0)
    bump = () => setCount((current) => current + 1)
    return <box><text>count {count}</text><ImageViewOverlay filePath={filePath} filename="photo.png" dialogWidth={28} dialogHeight={10} imageProtocol="blocks" onClose={() => {}} /></box>
  }
  const loadSpy = spyOn(NativeImage, "load")
  const setup = await testRender(<Parent />, { width: 30, height: 14 })
  try {
    for (let attempt = 0; attempt < 40 && loadSpy.mock.calls.length < 1; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        await setup.renderOnce()
      })
    }
    expect(loadSpy.mock.calls.length).toBe(1)
    await act(async () => {
      bump!()
      bump!()
      await setup.renderOnce()
      await setup.renderOnce()
    })
    expect(loadSpy.mock.calls.length).toBe(1)
  } finally {
    loadSpy.mockRestore()
    setup.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("clicking the fullscreen backdrop closes the viewer", async () => {
  let closed = 0
  const setup = await testRender(
    <ImageViewOverlay filePath="/definitely/missing/image.png" filename="image.png" dialogWidth={20} dialogHeight={6} imageProtocol="blocks" onClose={() => { closed += 1 }} />,
    { width: 30, height: 14 },
  )
  try {
    await act(async () => { await setup.renderOnce() })
    await setup.mockMouse.click(0, 0)
    expect(closed).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})

test("clicking inside the fullscreen dialog keeps the viewer open", async () => {
  let closed = 0
  const setup = await testRender(
    <ImageViewOverlay filePath="/definitely/missing/image.png" filename="image.png" dialogWidth={20} dialogHeight={6} imageProtocol="blocks" onClose={() => { closed += 1 }} />,
    { width: 30, height: 14 },
  )
  try {
    await act(async () => { await setup.renderOnce() })
    await setup.mockMouse.click(15, 7)
    expect(closed).toBe(0)
  } finally {
    setup.renderer.destroy()
  }
})
