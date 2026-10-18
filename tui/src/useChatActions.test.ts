import { expect, mock, test } from "bun:test"
import { useChatActions } from "./useChatActions"
import type { Dialog } from "./types"

test.each([
  { kind: "storage-dir", storageDir: "/srv/meshtalk", expected: "/srv/meshtalk" },
  { kind: "storage-dir", storageDir: undefined, expected: "/data" },
  { kind: "files-dir", storageDir: "/srv/meshtalk", expected: "/custom/files" },
  { kind: "files-settings", storageDir: "/srv/meshtalk", expected: "" },
] as const)("storage save preserves the $kind draft ($storageDir)", async ({ kind, storageDir, expected }) => {
  const response = { files_dir: "/custom/files", storage_dir: storageDir, data_dir: "/data", note: "Already set" }
  const send = mock(async () => response)
  const setDialog = mock((_dialog: Dialog) => {})
  const setDialogDraft = mock((_draft: string) => {})
  const setDialogError = mock((_error: string) => {})
  const statusResetRef = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const actions = useChatActions({
    ipc: { send },
    dialog: { kind } as Dialog,
    dialogActionRef: { current: 0 },
    dialogBusyRef: { current: false },
    statusResetRef,
    setDialog,
    setDialogDraft,
    setDialogError,
    setDialogBusy: () => {},
    setStatus: () => {},
  } as unknown as Parameters<typeof useChatActions>[0])
  try {
    await actions.setStorageDir(" /srv/meshtalk ")
    expect(send).toHaveBeenCalledWith("storage", { path: "/srv/meshtalk" })
    expect(setDialogError.mock.calls).toEqual([[""], [""]])
    expect(setDialog).toHaveBeenCalledWith(expect.objectContaining({ kind }))
    expect(setDialogDraft).toHaveBeenLastCalledWith(expected)
  } finally {
    clearTimeout(statusResetRef.current)
  }
})
