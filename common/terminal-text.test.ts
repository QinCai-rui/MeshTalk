import { expect, test } from "bun:test"
import { terminalText } from "./terminal-text"

test("encodes every C0, DEL and C1 control except intended line and tab layout", () => {
  for (let code = 0; code <= 0x9f; code++) {
    const character = String.fromCharCode(code)
    const control = code < 0x20 || code >= 0x7f
    expect(terminalText(character)).toBe(control && code !== 9 && code !== 10
      ? `\\u${code.toString(16).padStart(4, "0")}` : character)
    if (control) expect(terminalText(character, false)).toBe(`\\u${code.toString(16).padStart(4, "0")}`)
  }
})

test("preserves Unicode, formatting and empty text without changing the source", () => {
  const text = "你好 café 👩🏽‍💻 e\u0301 ‘quoted’\n\tsecond line"
  expect(terminalText(text)).toBe(text)
  expect(terminalText("")).toBe("")
  const hostile = "dummy\u001b]0;dummy\u0007\u009c\rtext"
  expect(terminalText(hostile)).toBe("dummy\\u001b]0;dummy\\u0007\\u009c\\u000dtext")
  expect(hostile).toContain("\u001b")
})
