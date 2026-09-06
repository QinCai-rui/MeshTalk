import { expect, test } from "bun:test"
import { act, type ComponentProps } from "react"
import { testRender } from "@opentui/react/test-utils"
import { mkdir, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { FileListDialogContent } from "./DialogPanel"
import type { Dialog, FileTransfer, Peer } from "../types"

const noop = () => {}
const peers: Peer[] = [
  { peer_id: "peer-alex-long-id", display_name: "Alex Morgan", is_online: 1, last_seen: 0, last_interaction: 0, unread_count: 0, endpoints: [] },
]

function props(files: FileTransfer[]): ComponentProps<typeof FileListDialogContent> {
  return {
    dialog: { kind: "file-list", files },
    dialogHeight: 28,
    dialogWidth: 100,
    imageProtocol: "blocks",
    peers,
    groups: [{ group_id: "studio", name: "Design studio", member_count: 4, unread_count: 0 }],
    loadFiles: noop,
    loadFilesDir: noop,
    setDialogDraft: noop,
    showDialog: noop,
    defaultDownloadPath: filename => join(tmpdir(), `copy-${filename}`),
  }
}

async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => { await setup.flush(); await setup.renderOnce() })
  return setup.captureCharFrame()
}

test("file manager uses peer names, keeps ID fallbacks, and exposes a wide detail pane", async () => {
  const transfers: FileTransfer[] = [
    { file_id: "received-file", filename: "project-notes.pdf", file_size: 2048, sender_id: "peer-alex-long-id", recipient_id: "me", direction: "inbound", status: "completed", created_at: 20 },
    { file_id: "sent-file", filename: "archive.zip", file_size: 8192, sender_id: "me", recipient_id: "unknown-peer-id", direction: "outbound", status: "queued", created_at: 10 },
  ]
  const setup = await testRender(<FileListDialogContent {...props(transfers)} />, { width: 100, height: 28 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("File Manager")
    expect(frame).toContain("2 transfers")
    expect(frame).toContain("Received from Alex Morgan")
    expect(frame).toContain("Sent to unknown-")
    expect(frame).toContain("cannot be saved in its current state")
    expect(setup.renderer.root.findDescendantById("file-manager-details")).toBeDefined()
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("file manager remains usable when narrow and preserves refresh, location, save, and delete keys", async () => {
  const directory = join(tmpdir(), `meshtalk-file-manager-${crypto.randomUUID()}`)
  const filePath = join(directory, "notes.txt")
  await mkdir(directory)
  await Bun.write(filePath, "notes")
  const transfer: FileTransfer = { file_id: "local-file", filename: "notes.txt", file_size: 5, sender_id: "peer-alex-long-id", recipient_id: "me", direction: "inbound", status: "completed", file_path: filePath, created_at: 20, completed_at: 21 }
  let refreshed = 0
  let locations = 0
  let draft = ""
  let shown: Dialog | undefined
  let deleted: FileTransfer | undefined
  const narrowProps = props([transfer])
  Object.assign(narrowProps, {
    dialogWidth: 56,
    loadFiles: () => { refreshed += 1 },
    loadFilesDir: () => { locations += 1 },
    setDialogDraft: (value: string) => { draft = value },
    showDialog: (dialog: Dialog) => { shown = dialog },
    onDeleteFile: (file: FileTransfer) => { deleted = file },
  })
  const setup = await testRender(<FileListDialogContent {...narrowProps} />, { width: 56, height: 28 })
  try {
    let frame = await settle(setup)
    expect(setup.renderer.root.findDescendantById("file-manager-details")).toBeUndefined()
    expect(frame).toContain("Received from Alex Morgan")
    expect(frame).toContain("meshtalk-file-manager-")
    expect(frame).toContain("notes.txt")

    await act(async () => { setup.mockInput.pressKey("r"); setup.mockInput.pressKey("l"); setup.mockInput.pressKey("s") })
    await settle(setup)
    expect(refreshed).toBe(1)
    expect(locations).toBe(1)
    expect(draft).toContain("copy-notes.txt")
    expect(shown).toMatchObject({ kind: "file-download", fileId: "local-file" })

    await act(async () => setup.mockInput.pressKey("d"))
    frame = await settle(setup)
    expect(frame).toContain("Delete notes.txt locally?")
    await act(async () => { setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 80)) })
    frame = await settle(setup)
    expect(frame).not.toContain("Delete notes.txt locally?")
    await act(async () => setup.mockInput.pressKey("d"))
    await settle(setup)
    await act(async () => setup.mockInput.pressEnter())
    await settle(setup)
    expect(deleted?.file_id).toBe("local-file")
  } finally {
    await act(async () => setup.renderer.destroy())
    await rm(directory, { recursive: true, force: true })
  }
})
