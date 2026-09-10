import { expect, test } from "bun:test"
import { goBack } from "./navigation"
import type { Dialog } from "./types"

test("returns from a confirmation image viewer to the original file confirmation", () => {
  const confirmation: Extract<Dialog, { kind: "file-confirm" }> = {
    kind: "file-confirm",
    paths: ["/tmp/meshtalk-drops/abc/Screenshot.png"],
    source: "drop",
  }
  let opened: Dialog | undefined
  let closed = false

  goBack({
    dialog: { kind: "image-view", filePath: confirmation.paths[0], filename: "Screenshot.png", returnTo: "file-confirm", returnDialog: confirmation },
    selection: undefined,
    fileTransfers: [],
    closeDialog: () => { closed = true },
    showDialog: (dialog) => { opened = dialog },
    loadAdvancedConfig: async () => {},
    loadRooms: async () => {},
    loadFriendRequests: async () => {},
    loadBlockedPeers: async () => {},
  })

  expect(closed).toBe(false)
  expect(opened).toEqual(confirmation)
})
