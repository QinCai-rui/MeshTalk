import { expect, test } from "bun:test"
import { act, type ComponentProps } from "react"
import { testRender } from "@opentui/react/test-utils"
import { mkdir, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { FileConfirmDialogContent } from "./DialogPanel"
import type { Dialog, Peer } from "../types"

const peer: Peer = {
  peer_id: "peer-alex-long-id",
  display_name: "Alex Morgan",
  is_online: 1,
  last_seen: 0,
  last_interaction: 0,
  unread_count: 0,
  endpoints: [],
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function baseProps(dialog: Extract<Dialog, { kind: "file-confirm" }>): ComponentProps<typeof FileConfirmDialogContent> {
  return {
    dialog,
    dialogWidth: 72,
    dialogHeight: 18,
    screenWidth: 80,
    screenHeight: 20,
    imageProtocol: "blocks",
    peers: [peer],
    groups: [],
    selection: { kind: "peer", id: peer.peer_id },
    closeDialog: () => {},
    showDialog: () => {},
    confirmPendingFileSend: () => {},
  }
}

async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => { await setup.flush(); await setup.renderOnce() })
  return setup.captureCharFrame()
}

test("shows compact file confirmation metadata", async () => {
  const directory = join(tmpdir(), `meshtalk-file-confirm-${crypto.randomUUID()}`)
  const filePath = join(directory, "notes.txt")
  await mkdir(directory)
  await Bun.write(filePath, "notes")
  const setup = await testRender(<FileConfirmDialogContent {...baseProps({ kind: "file-confirm", paths: [filePath], source: "picker" })} />, { width: 80, height: 20 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Send file to Alex Morgan?")
    expect(frame).toContain("notes.txt")
    expect(frame).toContain("text/plain")
    expect(frame).toContain("5 B")
  } finally {
    await act(async () => setup.renderer.destroy())
    await rm(directory, { recursive: true, force: true })
  }
})

test("previews an image file and opens its full-screen viewer", async () => {
  const directory = join(tmpdir(), `meshtalk-image-confirm-${crypto.randomUUID()}`)
  const filePath = join(directory, "photo.png")
  await mkdir(directory)
  await Bun.write(filePath, Buffer.from(PNG, "base64"))
  let opened: Dialog | undefined
  const props = baseProps({ kind: "file-confirm", paths: [filePath], source: "drop" })
  props.showDialog = (dialog) => { opened = dialog }
  const setup = await testRender(<FileConfirmDialogContent {...props} />, { width: 80, height: 20 })
  try {
    await settle(setup)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
    await settle(setup)
    const preview = setup.renderer.root.findDescendantById("file-confirm-image-preview")
    expect(preview).toBeDefined()
    await act(async () => setup.mockMouse.click(preview!.screenX + 1, preview!.screenY))
    expect(opened).toMatchObject({ kind: "image-view", filePath, filename: "photo.png" })
  } finally {
    await act(async () => setup.renderer.destroy())
    await rm(directory, { recursive: true, force: true })
  }
})

test("shows pasted image metadata and opens its full-screen viewer", async () => {
  let opened: Dialog | undefined
  const image = new Uint8Array(Buffer.from(PNG, "base64"))
  const props = baseProps({ kind: "file-confirm", paths: [], source: "image", image: { bytes: image, mimeType: "image/png" } })
  props.showDialog = (dialog) => { opened = dialog }
  const setup = await testRender(<FileConfirmDialogContent {...props} />, { width: 80, height: 20 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Send image to Alex Morgan?")
    expect(frame).toContain("pasted-image.png")
    expect(frame).toContain("image/png")
    expect(frame).toContain(`${image.byteLength} B`)
    expect(opened).toBeUndefined()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
    const loadedFrame = await settle(setup)
    expect(loadedFrame).not.toContain("image unavailable")
    const preview = setup.renderer.root.findDescendantById("file-confirm-image-preview")
    expect(preview).toBeDefined()
    expect(preview!.width).toBeGreaterThan(1)
    await act(async () => setup.mockMouse.click(preview!.screenX + 1, preview!.screenY))
    expect(opened).toMatchObject({ kind: "image-view", filename: "pasted-image.png", bytes: image })
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
