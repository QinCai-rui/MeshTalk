import { expect, test } from "bun:test"
import { notify, windowsNotificationCommand, type NotificationPreferences } from "./notifications"
import { terminalText } from "../../common/terminal-text"

test("Windows notification script contains only encoded data, including Unicode quote delimiters", () => {
  for (const text of ["", "你好 👩🏽‍💻", "'‘’‚‛\"“”`; $(dummy); #\n\u009c\u001b]0;dummy\u0007"]) {
    const command = windowsNotificationCommand(text, text)
    expect(command.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    const script = Buffer.from(command[4]!, "base64").toString("utf16le")
    const data = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)![1]!
    expect(JSON.parse(Buffer.from(data, "base64").toString("utf8"))).toEqual([text, text])
    const fixed = script.replace(data, "DATA")
    expect(fixed).toBe(Buffer.from(windowsNotificationCommand("other", "title")[4]!, "base64").toString("utf16le").replace(/FromBase64String\('[A-Za-z0-9+/=]+'\)/, "FromBase64String('DATA')"))
    expect(script).toContain("$icon.ShowBalloonTip(5000, $data[0], $data[1],")
    expect(script).not.toMatch(/Invoke-Expression|ScriptBlock|\beval\b/)
  }
})

test("terminal notifications encode every control and respect delivery and event gates", async () => {
  const preferences: NotificationPreferences = { setup_dismissed: true, delivery: "terminal", events: { messages: true, friend_requests: true, file_offers: true, file_completed: true } }
  const received: string[] = []
  const renderer = { capabilities: { notifications: true }, triggerNotification: (message: string) => { received.push(message) } }
  const text = "你好\n\t" + Array.from({ length: 0xa0 }, (_, code) => code < 0x20 || code >= 0x7f ? String.fromCharCode(code) : "").join("")
  for (const event of ["messages", "friend_requests", "file_offers", "file_completed"] as const) {
    await notify(preferences, event, renderer, text)
    expect(received.at(-1)).toBe(terminalText(text, false))
    expect(received.at(-1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    await notify(preferences, event, renderer, text, true)
    await notify({ ...preferences, delivery: "disabled" }, event, renderer, text)
    await notify({ ...preferences, events: { ...preferences.events, [event]: false } }, event, renderer, text)
    await notify(preferences, event, { ...renderer, capabilities: {} }, text)
  }
  expect(received).toHaveLength(4)
  await notify(preferences, "messages", renderer, "")
  expect(received.at(-1)).toBe("")
})
