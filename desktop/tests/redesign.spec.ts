import { expect, test, type Locator, type Page } from "@playwright/test"

async function overflowingSendHistory(page: Page, archiveCount = 18) {
  const rows = (sender: string, prefix: string, count: number, start: number) => Array.from({ length: count }, (_, index) => ({
    message_id: `${prefix}-${index}`,
    sender_id: sender,
    content: `${prefix} message ${index + 1}. A longer sample message for checking scrolling through the conversation.`,
    created_at: start + index * 90,
  }))
  const latest = rows("alice", "Latest", 36, 1700000000)
  const archived = rows("alice", "Archive", archiveCount, 1600000000)
  const sam = rows("sam", "Sam", 36, 1700000000)
  await page.route("**/src/demo.ts*", async route => {
    const response = await route.fetch()
    const original = await response.text()
    expect(original).toContain("const preferences =")
    expect(original).toContain('case "history_page": return')
    expect(original).toContain("const id = params.recipient_id ?? params.group_id;")
    const body = original
      .replace("const preferences =", `messages.alice = ${JSON.stringify(latest)}; messages.sam = ${JSON.stringify(sam)}; const archived = ${JSON.stringify(archived)};\nconst preferences =`)
      .replace('case "history_page": return', 'case "history_page": if (params.around) return { messages: archived, next_before: null }; return')
      .replace("const id = params.recipient_id ?? params.group_id;", `
        if (params.content === "Failed scroll send") throw new Error("Sample send failure");
        if (params.content === "Delayed scroll send") {
          document.documentElement.dataset.sendPending = "true";
          await new Promise(resolve => window.addEventListener("finish-demo-send", resolve, { once: true }));
          delete document.documentElement.dataset.sendPending;
        }
        const id = params.recipient_id ?? params.group_id;`)
    await route.fulfill({ response, body })
  })
  await page.reload()
  await expect(page.locator(".history .msg")).toHaveCount(latest.length)
  return latest
}

async function readEarlier(page: Page, archive: boolean) {
  if (archive) {
    await page.getByRole("button", { name: "Search messages", exact: true }).click()
    await page.getByRole("textbox", { name: "Search text", exact: true }).fill("Latest message 1.")
    await page.getByRole("button", { name: "Search", exact: true }).click()
    await page.locator(".search-result").first().click()
    await expect(page.locator("#message-Archive-0")).toContainText("Archive message 1.")
    await expect(page.getByRole("button", { name: "Return to latest messages", exact: true })).toBeVisible()
  }
  const history = page.locator(".history")
  expect(await history.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500)
  await history.evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll")) })
  await expect.poll(() => history.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(400)
}

async function expectLatestSend(page: Page, content: string) {
  const history = page.locator(".history")
  const message = history.locator(".msg").filter({ hasText: content })
  await expect(message).toBeVisible()
  await expect.poll(() => history.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3)
  await expect(page.locator(".jump-latest")).toHaveCount(0)
  const messageBox = (await message.boundingBox())!
  const historyBox = (await history.boundingBox())!
  expect(messageBox.y).toBeGreaterThanOrEqual(historyBox.y)
  expect(messageBox.y + messageBox.height).toBeLessThanOrEqual(historyBox.y + historyBox.height)
}

test.beforeEach(async ({ page }, testInfo) => {
  if (/sending returns|failed sends still|equal-count archive/.test(testInfo.title)) test.setTimeout(180_000)
  if (testInfo.title === "settings save failures retain the edited value and allow retry") {
    await page.route("**/src/demo.ts*", async route => {
      const response = await route.fetch()
      const original = await response.text()
      expect(original).toContain("identity.display_name = params.display_name;")
      const body = original.replace('identity.display_name = params.display_name;', 'if (params.display_name === "Fail") throw new Error("Sample save failure"); identity.display_name = params.display_name;')
      await route.fulfill({ response, body })
    })
  }
  await page.goto("/?demo=teal")
  await expect(page.getByRole("heading", { name: "Alice Chen", exact: true })).toBeVisible()
})

test("demo variants, message sending, and search use sample data", async ({ page }) => {
  await expect(page.getByText("Design demo", { exact: true })).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-accent", "teal")
  await page.screenshot({ path: "test-results/demo-teal.png" })
  await page.getByRole("button", { name: "Blue", exact: true }).click()
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue")
  await page.screenshot({ path: "test-results/demo-blue.png" })
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A sample message")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.locator(".history")).toContainText("A sample message")
  await page.getByRole("button", { name: "Search messages", exact: true }).click()
  await page.getByRole("textbox", { name: "Search text" }).fill("Saturday")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await page.locator(".search-result").first().click()
  await expect(page.getByRole("heading", { name: "Alice Chen", exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("meshtalk-selection"))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem("meshtalk-accent"))).toBeNull()
})

test("settings fill the window, save changes, preserve edits, and restore focus", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings).toBeVisible()
  const box = await settings.boundingBox()
  expect(box?.width).toBe(1100)
  expect(box?.height).toBe(760)
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible()
  await page.screenshot({ path: "test-results/settings-profile.png" })
  await page.getByLabel("Display name", { exact: true }).fill("Casey")
  await page.getByRole("button", { name: "Save name" }).click()
  await expect(page.getByRole("status", { name: "Settings status" })).toContainText("Display name saved")
  await page.getByLabel("Display name", { exact: true }).fill("Unsaved edit")
  await page.getByRole("switch", { name: "Launch at login" }).check()
  await expect(page.getByRole("status", { name: "Settings status" })).toContainText("Changes saved")
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Unsaved edit")
  await page.getByRole("button", { name: "Appearance", exact: true }).click()
  await page.getByRole("button", { name: "Dark", exact: true }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.getByRole("button", { name: "Signal-inspired blue", exact: true }).click()
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue")
  await page.screenshot({ path: "test-results/settings-appearance-dark.png" })
  await page.getByRole("button", { name: "Notifications", exact: true }).click()
  await page.screenshot({ path: "test-results/settings-notifications.png" })
  await page.getByRole("switch", { name: "Enable notifications", exact: true }).uncheck()
  await expect(page.getByRole("switch", { name: "Messages", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Privacy", exact: true }).click()
  await expect(page.getByLabel("Analytics level")).toHaveValue("off")
  await page.getByRole("button", { name: "Back to chats" }).click()
  await expect(settings).not.toBeVisible()
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused()
  await expect(page.locator(".user-panel")).toContainText("Casey")
  await page.screenshot({ path: "test-results/demo-dark.png" })
})

test("technical connection controls remain visible and functional", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Connection", exact: true }).click()
  await expect(page.getByLabel("Server URL")).toHaveValue("wss://meshtalk-control.qincai.xyz/v1/rendezvous")
  await expect(page.getByText("Remote discovery connected", { exact: true })).toBeVisible()
  await page.screenshot({ path: "test-results/settings-connection.png" })
  await page.getByRole("switch", { name: "Enable remote discovery" }).uncheck()
  await expect(page.getByText("Local network only", { exact: true })).toBeVisible()
  await page.getByRole("switch", { name: "Enable remote discovery" }).check()
  await expect(page.getByText("Remote discovery connected", { exact: true })).toBeVisible()
  await page.getByLabel("Manual control addresses").fill("203.0.113.10")
  await page.getByRole("button", { name: "Save addresses" }).first().click()
  await expect(page.getByText("203.0.113.10", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click()
  await page.getByRole("button", { name: "Refresh diagnostics", exact: true }).click()
  await expect(page.locator(".diagnostic-output")).toContainText('"demo": true')
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).not.toBeVisible()
})

test("narrow settings and dialogs remain usable with keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Connection", exact: true }).click()
  await page.getByLabel("Manual STUN addresses").scrollIntoViewIfNeeded()
  await expect(page.getByLabel("Manual STUN addresses")).toBeVisible()
  expect(await page.locator(".settings-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: "test-results/settings-narrow.png" })
  await page.getByRole("button", { name: "Rooms", exact: true }).click()
  await page.getByRole("button", { name: "Leave…", exact: true }).click()
  const confirm = page.getByRole("dialog", { name: "Leave Weekend plans?" })
  await expect(confirm).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(confirm).not.toBeVisible()
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "New conversation", exact: true }).click()
  await page.getByRole("button", { name: /Create a group/ }).click()
  await expect(page.getByRole("dialog", { name: "Create a group", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible()
})

test("empty conversation searches explain how to recover", async ({ page }) => {
  await page.getByRole("textbox", { name: "Search conversations" }).fill("Nobody with this name")
  await expect(page.getByRole("heading", { name: "No matches", exact: true })).toBeVisible()
  await expect(page.getByText("Try a different name.")).toBeVisible()
})

// Browser checks verify CSS and wheel routing, not macOS native rubber-banding.
test("scroll panels disable boundary effects without blocking wheel scrolling", async ({ page }) => {
  async function wheelOver(panel: Locator, delta: number) {
    await panel.evaluate(el => {
      el.removeAttribute("data-wheel-settled")
      el.addEventListener("wheel", () => {
        requestAnimationFrame(() => requestAnimationFrame(() => el.setAttribute("data-wheel-settled", "true")))
      }, { once: true, passive: true })
    })
    await page.mouse.wheel(0, delta)
    await expect(panel).toHaveAttribute("data-wheel-settled", "true")
  }
  const rows = Array.from({ length: 28 }, (_, index) => ({
    message_id: `scroll-${index}`,
    sender_id: "alice",
    content: index === 0 ? Array.from({ length: 18 }, (_, line) => `Sample checklist line ${line + 1}`).join("\n") : `Sample message ${index + 1}`,
    created_at: 1791626400 + index * 90,
  }))
  await page.route("**/src/demo.ts*", async route => {
    const response = await route.fetch()
    const original = await response.text()
    expect(original).toContain("const preferences =")
    await route.fulfill({ response, body: original.replace("const preferences =", `messages.alice = ${JSON.stringify(rows)};\nconst preferences =`) })
  })
  await page.reload()
  const history = page.locator(".history")
  await expect(history.locator(".msg")).toHaveCount(rows.length)
  const maximum = await history.evaluate(el => el.scrollHeight - el.clientHeight)
  expect(maximum).toBeGreaterThan(1000)
  for (const selector of ["html", "body", "#root", ".sidebar nav", ".history"]) {
    await expect(page.locator(selector)).toHaveCSS("overscroll-behavior-y", "none")
  }
  await history.evaluate(el => { el.scrollTop = 0 })
  const box = (await history.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await wheelOver(history, 180)
  await expect.poll(() => history.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await history.evaluate(el => { el.scrollTop = el.scrollHeight })
  await wheelOver(history, 180)
  expect(await history.evaluate(el => el.scrollTop)).toBe(maximum)
  await wheelOver(history, -180)
  await expect.poll(() => history.evaluate(el => el.scrollTop)).toBeLessThan(maximum)
  await history.evaluate(el => { el.scrollTop = 0 })
  await wheelOver(history, -180)
  expect(await history.evaluate(el => el.scrollTop)).toBe(0)

  await page.getByRole("button", { name: "Search messages", exact: true }).click()
  await page.getByRole("textbox", { name: "Search text", exact: true }).fill("Sample")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  const result = page.locator(".search-result p").first()
  const dialog = page.getByRole("dialog", { name: "Search messages", exact: true })
  await expect(result).toBeVisible()
  await expect(result).toHaveCSS("overscroll-behavior-y", "none")
  await expect(dialog).toHaveCSS("overscroll-behavior-y", "none")
  const resultMaximum = await result.evaluate(el => el.scrollHeight - el.clientHeight)
  expect(resultMaximum).toBeGreaterThan(0)
  expect(await dialog.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0)
  const resultBox = (await result.boundingBox())!
  await page.mouse.move(resultBox.x + resultBox.width / 2, resultBox.y + resultBox.height / 2)
  await wheelOver(result, 60)
  await expect.poll(() => result.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await result.evaluate(el => { el.scrollTop = el.scrollHeight })
  await wheelOver(result, 240)
  expect(await result.evaluate(el => el.scrollTop)).toBe(resultMaximum)
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(0)
})

test("settings save failures retain the edited value and allow retry", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByLabel("Display name", { exact: true }).fill("Fail")
  await page.getByRole("button", { name: "Save name" }).click()
  await expect(page.getByRole("alert")).toContainText("Sample save failure")
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Fail")
  await expect(page.getByRole("button", { name: "Save name" })).toBeEnabled()
  await page.getByLabel("Display name", { exact: true }).fill("Recovered")
  await page.getByRole("button", { name: "Save name" }).click()
  await expect(page.getByRole("status", { name: "Settings status" })).toContainText("Display name saved")
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("sending returns scrolled history and archive to latest with Enter and the send button", async ({ page }, testInfo) => {
  await overflowingSendHistory(page)
  for (const variant of ["light", "dark", "narrow"] as const) {
    await page.setViewportSize(variant === "narrow" ? { width: 640, height: 480 } : { width: 1100, height: 760 })
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("button", { name: "Appearance", exact: true }).click()
    await page.getByRole("button", { name: variant === "dark" ? "Dark" : "Light", exact: true }).click()
    await page.getByRole("button", { name: "Back to chats", exact: true }).click()
    for (const archive of [false, true]) {
      for (const method of ["enter", "button"] as const) {
        await readEarlier(page, archive)
        const content = `${variant} ${archive ? "archive" : "history"} ${method} send`
        const path = testInfo.outputPath(`${variant}-${archive ? "archive" : "history"}-${method}`)
        const composer = page.getByRole("textbox", { name: "Message", exact: true })
        await composer.fill(content)
        await page.screenshot({ path: `${path}-before.png` })
        if (method === "enter") await composer.press("Enter")
        else await page.getByRole("button", { name: "Send message", exact: true }).click()
        await expectLatestSend(page, content)
        await expect(page.locator(".history")).toContainText("Latest message 36.")
        await expect(page.locator(".history").getByText("Sending…", { exact: true })).toHaveCount(0)
        await page.screenshot({ path: `${path}-after.png` })
      }
    }
  }
})

test("failed sends still show the latest message and delayed sends do not move another chat", async ({ page }) => {
  await overflowingSendHistory(page)
  await readEarlier(page, true)
  const composer = page.getByRole("textbox", { name: "Message", exact: true })
  await composer.fill("Failed scroll send")
  await composer.press("Enter")
  await expectLatestSend(page, "Failed scroll send")
  await expect(page.getByRole("alert")).toContainText("Sample send failure")
  await expect(page.locator(".history .msg").filter({ hasText: "Failed scroll send" })).toContainText("Failed")

  await composer.fill("Delayed scroll send")
  await composer.press("Enter")
  await expect(page.locator("html")).toHaveAttribute("data-send-pending", "true")
  await page.locator(".conversation").filter({ hasText: "Sam Rivera" }).click()
  await expect(page.locator(".history .msg")).toHaveCount(36)
  await page.getByRole("button", { name: "Load older messages", exact: true }).click()
  await expect(page.getByRole("button", { name: "Return to latest messages", exact: true })).toBeVisible()
  const history = page.locator(".history")
  await history.evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll")) })
  await composer.fill("Sam's unsent draft")
  await history.focus()
  await page.evaluate(() => window.dispatchEvent(new Event("finish-demo-send")))
  await expect(page.locator("html")).not.toHaveAttribute("data-send-pending", "true")
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.locator(".conversation").filter({ hasText: "Alice Chen" })).toContainText("Delayed scroll send")
  await expect(page.getByRole("heading", { name: "Sam Rivera", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Return to latest messages", exact: true })).toBeVisible()
  await expect(history).not.toContainText("Delayed scroll send")
  await expect.poll(() => history.evaluate(el => el.scrollTop)).toBe(100)
  await expect(composer).toHaveValue("Sam's unsent draft")
  await expect(history).toBeFocused()
})

test("equal-count archive sends scroll before completion with Enter and the send button", async ({ page }, testInfo) => {
  await overflowingSendHistory(page, 37)
  for (const method of ["enter", "button"] as const) {
    if (method === "button") {
      await page.reload()
      await expect(page.locator(".history .msg")).toHaveCount(36)
    }
    await readEarlier(page, true)
    await expect(page.locator(".history .msg")).toHaveCount(37)
    const composer = page.getByRole("textbox", { name: "Message", exact: true })
    await composer.fill("Delayed scroll send")
    await page.screenshot({ path: testInfo.outputPath(`equal-count-${method}-before.png`) })
    if (method === "enter") await composer.press("Enter")
    else await page.getByRole("button", { name: "Send message", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("data-send-pending", "true")
    await expect(page.locator(".history .msg")).toHaveCount(37)
    await expectLatestSend(page, "Delayed scroll send")
    await expect(page.locator("#message-Latest-35")).toContainText("Latest message 36.")
    await expect(page.locator("#message-Archive-0")).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`equal-count-${method}-after.png`) })
    await page.evaluate(() => window.dispatchEvent(new Event("finish-demo-send")))
    await expect(page.locator(".history").getByText("Sending…", { exact: true })).toHaveCount(0)
  }
})
