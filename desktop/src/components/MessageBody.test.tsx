import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageBody } from "./MessageBody"

test("mention display names containing URLs render as plain text", () => {
  const html = renderToStaticMarkup(<MessageBody content="Hello <@alice>" name={() => "x https://evil.test"} />)
  expect(html).not.toContain("<a")
  expect(html.replace(/\u200b/g, "")).toContain("x https://evil.test")
})

test("plain URLs outside mentions still link", () => {
  const html = renderToStaticMarkup(<MessageBody content="see https://example.test" name={id => id} />)
  expect(html).toContain('href="https://example.test"')
})

test("non-http links render as plain text without an href", () => {
  for (const content of ["[x](javascript:alert(1))", "[y](data:text/html,<b>hi</b>)", "[z](mailto:a@example.test)", "[w](/relative/path)"]) {
    const html = renderToStaticMarkup(<MessageBody content={content} name={id => id} />)
    expect(html).not.toContain("href=")
  }
})
