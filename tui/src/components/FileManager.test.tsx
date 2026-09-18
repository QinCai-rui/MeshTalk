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
    setDialogDraft: noop,
    showDialog: noop,
    closeDialog: noop,
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

test("file manager remains usable when narrow and preserves refresh, save, and delete keys", async () => {
  const directory = join(tmpdir(), `meshtalk-file-manager-${crypto.randomUUID()}`)
  const filePath = join(directory, "notes.txt")
  await mkdir(directory)
  await Bun.write(filePath, "notes")
  const transfer: FileTransfer = { file_id: "local-file", filename: "notes.txt", file_size: 5, sender_id: "peer-alex-long-id", recipient_id: "me", direction: "inbound", status: "completed", file_path: filePath, created_at: 20, completed_at: 21 }
  let refreshed = 0
  let draft = ""
  let shown: Dialog | undefined
  let deleted: FileTransfer | undefined
  const narrowProps = props([transfer])
  Object.assign(narrowProps, {
    dialogWidth: 56,
    loadFiles: () => { refreshed += 1 },
    setDialogDraft: (value: string) => { draft = value },
    showDialog: (dialog: Dialog) => { shown = dialog },
    onDeleteFile: (file: FileTransfer) => { deleted = file },
  })
  const setup = await testRender(<FileListDialogContent {...narrowProps} />, { width: 56, height: 28 })
  try {
    let frame = await settle(setup)
    expect(setup.renderer.root.findDescendantById("file-manager-details")).toBeUndefined()
    expect(frame).toContain("Received from Alex Morgan")
    expect(frame).toContain("meshtalk-file-")
    expect(frame).toContain("notes.txt")
    expect(frame).toContain("<")
    expect(frame).toContain("File Manager")

    await act(async () => { setup.mockInput.pressKey("r"); setup.mockInput.pressKey("s") })
    await settle(setup)
    expect(refreshed).toBe(1)
    expect(draft).toContain("copy-notes.txt")
    expect(shown).toMatchObject({ kind: "file-download", fileId: "local-file" })
    // Back button at top returns to settings, Location/G storage removed
    expect(frame).toContain("<")
    expect(frame).not.toContain("ocation")
    expect(frame).not.toContain("storage")

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

async function clickText(setup: Awaited<ReturnType<typeof testRender>>, needle: string, occurrence = 0) {
  const frame = setup.captureCharFrame()
  const lines = frame.split("\n")
  for (let row = 0; row < lines.length; row++) {
    let col = -1
    let seen = -1
    let from = 0
    while (seen < occurrence) {
      const at = lines[row]!.indexOf(needle, from)
      if (at < 0) break
      seen++
      col = at
      from = at + 1
    }
    if (seen === occurrence && col >= 0) {
      await act(async () => {
        await setup.mockMouse.click(col + 1, row)
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      return
    }
  }
  throw new Error(`text not found for click: ${needle}`)
}

function filterTransfers(): FileTransfer[] {
  return [
    { file_id: "f-alex", filename: "project-notes.pdf", file_size: 2048, sender_id: "peer-alex-long-id", recipient_id: "me", direction: "inbound", status: "completed", created_at: 30 },
    { file_id: "f-bob", filename: "bob-photo.png", file_size: 512, sender_id: "peer-bob-long-id", recipient_id: "me", direction: "inbound", status: "completed", created_at: 20 },
    { file_id: "f-group", filename: "team-plan.pdf", file_size: 1024, sender_id: "me", recipient_id: "peer-bob-long-id", direction: "outbound", group_id: "studio", status: "sent", created_at: 10 },
  ]
}

function filterPropsWithBob(transfers: FileTransfer[]) {
  const filterProps = props(transfers)
  Object.assign(filterProps, {
    peers: [...peers, { peer_id: "peer-bob-long-id", display_name: "Bob Jones", is_online: 1, last_seen: 0, last_interaction: 0, unread_count: 0, endpoints: [] }],
  })
  return filterProps
}

test("file manager peer picker filters, group picker clears peer", async () => {
  const setup = await testRender(<FileListDialogContent {...filterPropsWithBob(filterTransfers())} />, { width: 100, height: 28 })
  try {
    let frame = await settle(setup)
    expect(frame).toContain("Peer: All")
    expect(frame).toContain("Group: All")
    expect(frame).toContain("project-notes.pdf")
    expect(frame).toContain("team-plan.pdf")
    // Clicking Peer opens a picker dialogue instead of cycling.
    await clickText(setup, "Peer: All")
    frame = await settle(setup)
    expect(frame).toContain("Filter by peer")
    expect(frame).toContain("Alex Morgan")
    expect(frame).toContain("Bob Jones")
    // Pick Alex: only their transfer remains, group stays All.
    await clickText(setup, "Alex Morgan")
    frame = await settle(setup)
    expect(frame).toContain("Peer: Alex Morgan")
    expect(frame).toContain("Group: All")
    expect(frame).toContain("project-notes.pdf")
    expect(frame).not.toContain("bob-photo.png")
    expect(frame).not.toContain("team-plan.pdf")
    // Picking a group clears the peer filter (never both).
    await clickText(setup, "Group: All")
    frame = await settle(setup)
    expect(frame).toContain("Filter by group")
    await clickText(setup, "Design studio")
    frame = await settle(setup)
    expect(frame).toContain("Group: Design studio")
    expect(frame).toContain("Peer: All")
    expect(frame).toContain("team-plan.pdf")
    expect(frame).not.toContain("project-notes.pdf")
    // Picking All clears the group filter again (highlight starts on All).
    await clickText(setup, "Group: Design studio")
    await settle(setup)
    await act(async () => { setup.mockInput.pressEnter() })
    frame = await settle(setup)
    expect(frame).toContain("Group: All")
    expect(frame).toContain("project-notes.pdf")
    expect(frame).toContain("team-plan.pdf")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("file manager picker supports keyboard select and escape", async () => {
  const setup = await testRender(<FileListDialogContent {...filterPropsWithBob(filterTransfers())} />, { width: 100, height: 28 })
  try {
    await settle(setup)
    await clickText(setup, "Peer: All")
    let frame = await settle(setup)
    expect(frame).toContain("Filter by peer")
    // Down moves to Alex, Enter confirms without touching the file list.
    await act(async () => { setup.mockInput.pressArrow("down") })
    frame = await settle(setup)
    expect(frame).toContain("> Alex Morgan")
    await act(async () => { setup.mockInput.pressEnter() })
    frame = await settle(setup)
    expect(frame).toContain("Peer: Alex Morgan")
    expect(frame).not.toContain("Filter by peer")
    expect(frame).not.toContain("team-plan.pdf")
    // Escape closes an open picker.
    await clickText(setup, "Group: All")
    frame = await settle(setup)
    expect(frame).toContain("Filter by group")
    await act(async () => { setup.mockInput.pressEscape() })
    await settle(setup)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("file manager search narrows by filename phrase", async () => {
  const transfers: FileTransfer[] = [
    { file_id: "f-alex", filename: "project-notes.pdf", file_size: 2048, sender_id: "peer-alex-long-id", recipient_id: "me", direction: "inbound", status: "completed", created_at: 30 },
    { file_id: "f-bob", filename: "bob-photo.png", file_size: 512, sender_id: "peer-bob-long-id", recipient_id: "me", direction: "inbound", status: "completed", created_at: 20 },
    { file_id: "f-group", filename: "team-plan.pdf", file_size: 1024, sender_id: "me", recipient_id: "peer-bob-long-id", direction: "outbound", group_id: "studio", status: "sent", created_at: 10 },
  ]
  const searchProps = props(transfers)
  Object.assign(searchProps, {
    peers: [...peers, { peer_id: "peer-bob-long-id", display_name: "Bob Jones", is_online: 1, last_seen: 0, last_interaction: 0, unread_count: 0, endpoints: [] }],
  })
  const setup = await testRender(<FileListDialogContent {...searchProps} />, { width: 100, height: 28 })
  try {
    await settle(setup)
    await act(async () => { setup.mockInput.pressKey("/") })
    await settle(setup)
    for (const char of "plan") await act(async () => { setup.mockInput.pressKey(char) })
    const frame = await settle(setup)
    expect(frame).toContain("team-plan.pdf")
    expect(frame).not.toContain("project-notes.pdf")
    expect(frame).not.toContain("bob-photo.png")
    expect(frame).toContain("1 shown")
    // Enter blurs but keeps the filter applied.
    await act(async () => { setup.mockInput.pressEnter() })
    const blurred = await settle(setup)
    expect(blurred).toContain("team-plan.pdf")
    expect(blurred).not.toContain("project-notes.pdf")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("file manager details show caption, batch position, and retry for failed outbound files", async () => {
  const transfers: FileTransfer[] = [
    { file_id: "failed-batch", filename: "receipts.zip", file_size: 100, sender_id: "me", recipient_id: "peer-alex-long-id", direction: "outbound", status: "failed", created_at: 30, caption: "Trip receipts", batch_id: "batch-1", batch_index: 1, batch_count: 3 },
  ]
  let retried: string | undefined
  const retryProps = props(transfers)
  Object.assign(retryProps, { onRetryFile: (fileId: string) => { retried = fileId } })
  const setup = await testRender(<FileListDialogContent {...retryProps} />, { width: 100, height: 28 })
  try {
    const frame = await settle(setup)
    expect(frame).toContain("Trip receipts")
    expect(frame).toContain("Batch 2/3")
    expect(frame).toContain("Retry")
    expect(retried).toBeUndefined()
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
