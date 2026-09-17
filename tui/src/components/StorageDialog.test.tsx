import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { FilesDirDialogContent, FilesSettingsContent } from "./DialogPanel"
import type { Dialog, LocationPayload } from "../types"

const noop = () => {}

type LocationDialog = Extract<Dialog, { kind: "files-dir" } | { kind: "storage-dir" }>

function payload(): LocationPayload {
  return {
    filesDir: "/data/files",
    dataDir: "/data",
    storageDir: "/data",
    dbPath: "/data/meshtalk.db",
    storageHasContent: true,
    filesHasContent: true,
  }
}

function renderDialog(kind: LocationDialog["kind"], draft: string, onFilesDir: (path: string, migrate?: boolean) => void, onStorageDir: (path: string, migrate?: boolean) => void) {
  return testRender(
    <FilesDirDialogContent
      dialog={{ kind, ...payload() } as LocationDialog}
      dialogDraft={draft}
      setDialogDraft={noop}
      setFilesDir={onFilesDir}
      setStorageDir={onStorageDir}
      loadFiles={noop}
    />,
    { width: 100, height: 40 },
  )
}

async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => { await setup.flush(); await setup.renderOnce() })
}

async function pressEnter(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => { setup.mockInput.pressEnter(); await new Promise(resolve => setTimeout(resolve, 50)) })
  await settle(setup)
}

test("files scope asks before transferring on Enter", async () => {
  const filesCalls: { path: string; migrate?: boolean }[] = []
  const storageCalls: { path: string; migrate?: boolean }[] = []
  const setup = await renderDialog("files-dir", "/new/files", (path, migrate) => { filesCalls.push({ path, migrate }) }, (path, migrate) => { storageCalls.push({ path, migrate }) })
  try {
    await settle(setup)
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Files location")
    expect(frame).toContain("Save files location")
    expect(frame).not.toContain("Transfer existing files")
    await pressEnter(setup)
    frame = setup.captureCharFrame()
    expect(frame).toContain("Transfer existing files")
    expect(filesCalls).toEqual([])
    // Answering Yes transfers with migrate=true.
    await act(async () => { setup.mockInput.pressKey("y"); await new Promise(resolve => setTimeout(resolve, 50)) })
    await settle(setup)
    expect(filesCalls).toEqual([{ path: "/new/files", migrate: true }])
    expect(storageCalls).toEqual([])
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("storage scope edits the main storage location independently", async () => {
  const filesCalls: { path: string; migrate?: boolean }[] = []
  const storageCalls: { path: string; migrate?: boolean }[] = []
  const setup = await renderDialog("storage-dir", "/new/storage", (path, migrate) => { filesCalls.push({ path, migrate }) }, (path, migrate) => { storageCalls.push({ path, migrate }) })
  try {
    await settle(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Storage location")
    expect(frame).toContain("/data/meshtalk.db")
    expect(frame).toContain("Save storage location")
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("Transfer existing data")
    expect(filesCalls).toEqual([])
    await act(async () => { setup.mockInput.pressKey("y"); await new Promise(resolve => setTimeout(resolve, 50)) })
    await settle(setup)
    expect(storageCalls).toEqual([{ path: "/new/storage", migrate: true }])
    expect(filesCalls).toEqual([])
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("location change always asks, even when no existing content is reported", async () => {
  const calls: { path: string; migrate?: boolean }[] = []
  const setup = await testRender(
    <FilesDirDialogContent
      dialog={{ kind: "files-dir", ...payload(), filesHasContent: false, storageHasContent: false }}
      dialogDraft="/new/files"
      setDialogDraft={noop}
      setFilesDir={(path, migrate) => { calls.push({ path, migrate }) }}
      setStorageDir={noop}
      loadFiles={noop}
    />,
    { width: 100, height: 40 },
  )
  try {
    await settle(setup)
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("Transfer existing files")
    expect(calls).toEqual([])
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("unchanged path saves directly without asking", async () => {
  const calls: { path: string; migrate?: boolean }[] = []
  const setup = await renderDialog("files-dir", "/data/files", (path, migrate) => { calls.push({ path, migrate }) }, noop)
  try {
    await settle(setup)
    await pressEnter(setup)
    expect(calls).toEqual([{ path: "/data/files", migrate: undefined }])
    expect(setup.captureCharFrame()).not.toContain("Transfer existing files")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

function filesSettingsPayload(): LocationPayload {
  return payload()
}

async function renderFilesSettings(onFiles: (path: string, migrate?: boolean) => void = noop, onStorage: (path: string, migrate?: boolean) => void = noop, onManager: () => void = noop, editing?: { files?: boolean; storage?: boolean }) {
  return testRender(
    <FilesSettingsContent
      dialog={{ kind: "files-settings", ...filesSettingsPayload() } as Extract<Dialog, { kind: "files-settings" }>}
      dialogHeight={40}
      dialogBusy={false}
      loadFiles={onManager}
      setFilesDir={onFiles}
      setStorageDir={onStorage}
      initialEditingFiles={editing?.files}
      initialEditingStorage={editing?.storage}
    />,
    { width: 110, height: 70 },
  )
}

test("files-settings landing shows manager button and two sections with independent edit", async () => {
  const setup = await renderFilesSettings()
  try {
    await settle(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Open file manager")
    expect(frame).toContain("File location")
    expect(frame).toContain("Storage location")
    expect(frame).toContain("/data/files")
    expect(frame).toContain("/data/meshtalk.db")
    // Edit, Set to default, and Open buttons present for both sections
    expect(frame.match(/Edit/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(frame.match(/Set to default/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(frame.match(/Open/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    // Does not auto-open file manager
    expect(frame).not.toContain("File Manager")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("files-settings edit file location shows inline editor and keeps storage independent", async () => {
  const setup = await renderFilesSettings(noop, noop, noop, { files: true })
  try {
    await settle(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Save")
    expect(frame).toContain("Cancel")
    expect(frame).toContain("Examples:")
    // Storage section should still show its Edit, not its editor, when files is editing
    expect(frame).toContain("Storage location")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("files-settings open file manager button is noticeable and independent", async () => {
  const setup = await renderFilesSettings()
  try {
    await settle(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Open file manager")
    // Button is rendered with a bordered box – check that the border characters are present around it
    expect(frame).toContain("┌")
    expect(frame).toContain("└")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("files-settings storage edit shows inline editor independently", async () => {
  const setup = await renderFilesSettings(noop, noop, noop, { storage: true })
  try {
    await settle(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Save")
    expect(frame).toContain("Cancel")
    expect(frame).toContain("File location")
    expect(frame).toContain("Storage location")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
