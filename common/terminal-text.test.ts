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

test("encodes bidirectional formatting marks that reorder displayed text", () => {
  for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    expect(terminalText(`a${String.fromCharCode(code)}b`)).toBe(`a\\u${code.toString(16).padStart(4, "0")}b`)
  }
  expect(terminalText("שלום عربي")).toBe("שלום عربي")
})
