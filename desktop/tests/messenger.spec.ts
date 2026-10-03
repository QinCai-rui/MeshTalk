import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, Function>()
    let callbackId = 0
    const messages = [
      { message_id: "one", sender_id: "alice", content: "Hey! Are we still meeting at the café?", created_at: 1789970400, failed: 0, queued: 0 },
      { message_id: "two", sender_id: "self", content: "Yes, I'll be there at 3. See you soon!", created_at: 1789970450, failed: 0, queued: 0 },
    ]
    const peers = [{ peer_id: "alice", display_name: "Alice", is_online: 1, presence: "active", is_friend: true, last_interaction: 1789970450, unread_count: 0, capability_gap: false }, { peer_id: "bob", display_name: "Bob", presence: "offline", is_online: 0, is_friend: true, unread_count: 2 }]
    localStorage.setItem("meshtalk-selection", JSON.stringify({ kind: "peer", id: "alice", name: "Alice" }))
    // Deliberately emulate the previously packaged backend: it lacks desktop_drafts.
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (callback: Function) => { const id = ++callbackId; callbacks.set(id, callback); return id },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any) => {
        if (command === "plugin:event|listen") return ++callbackId
        if (command === "preferences") return { close_mode: "tray", autostart: false, version: "test", update_channel: "stable" }
        if (command !== "request") return {}
        switch (args.action) {
          case "desktop_drafts": throw new Error("Unknown action: desktop_drafts")
          case "identity": return { peer_id: "self", display_name: "Ray", setup_dismissed: true }
          case "peers": return { peers }
          case "groups": return { groups: [] }
          case "friend_requests": return { requests: [] }
          case "muted_peers": return { muted_peers: {}, muted_groups: {} }
          case "control": return { url: "wss://example.test", connected: true, stun_server: "stun.example.test:3478" }
          case "analytics": return { analytics_level: "off" }
          case "notifications": return { delivery: "native", events: { messages: true } }
          case "blocked_peers": return { blocked: [] }
          case "rooms": return { rooms: [] }
          case "advanced_config": return { control_pinned_ips: [], stun_pinned_ips: [] }
          case "files": return { files: [] }
          case "messages": return { messages: [...messages] }
          case "send": {
            const row = { message_id: `sent-${messages.length}`, sender_id: "self", content: args.params.content, created_at: Date.now() / 1000, failed: 0, queued: 0 }
            messages.push(row)
            return { message_id: row.message_id }
          }
          default: return {}
        }
      },
    } })
  })
})

test("legacy backend still enables Enter and click-to-send; zero flags render nothing", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect(page.getByText("Connected", { exact: true })).toBeVisible()
  await expect(page.locator(".msg-state, .msg-failed")).toHaveCount(0)
  const composer = page.getByRole("textbox", { name: "Message", exact: true })
  await composer.fill("Sent with Enter")
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled()
  await composer.press("Enter")
  await expect(page.locator(".history")).toContainText("Sent with Enter")
  await composer.fill("Sent with button")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.locator(".history")).toContainText("Sent with button")
  await page.screenshot({ path: "test-results/messenger-light.png" })
})

test("narrow window keeps the composer visible without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 })
  await page.goto("/")
  await expect(page.getByText("Connected", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/messenger-narrow.png" })
})

test("settings use the desktop IPC bridge and keep appearance preferences", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Connected", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Connection", exact: true }).click()
  await expect(page.getByLabel("Server URL")).toHaveValue("wss://example.test")
  await page.getByRole("button", { name: "Appearance", exact: true }).click()
  await page.getByRole("button", { name: "Dark", exact: true }).click()
  await page.getByRole("button", { name: "Signal-inspired blue", exact: true }).click()
  expect(await page.evaluate(() => localStorage.getItem("meshtalk-accent"))).toBe('"blue"')
  await page.getByRole("button", { name: "Back to chats" }).click()
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue")
  await expect(page.getByText("Design demo", { exact: true })).not.toBeVisible()
})
