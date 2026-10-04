import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { invoke } from "../api"

export function MessageBody({ content, name }: { content: string; name: (id: string) => string }) {
  // Escape names before Markdown parsing so display names cannot introduce links or formatting.
  // Backslash escapes alone do not stop GFM autolinks (micromark still matches
  // http(s) URLs through them), so URL punctuation also gets a zero-width space
  // that breaks autolink detection while rendering invisibly.
  const escapeMention = (value: string) => value
    .replace(/[\\`*_[\]<>~()!+|-]/g, "\\$&")
    .replace(/([:/.?#@])/g, "$1\u200b")
  const text = content.replace(/(?<!\\)<@([A-Za-z0-9_-]+)>/g, (_, id: string) => `@${escapeMention(id === "everyone" ? "everyone" : name(id))}`)
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[External image]"}</span>,
    a: ({ href, children }) => /^https?:\/\//i.test(href ?? "") ? <a href={href} onClick={e => { e.preventDefault(); void invoke("open_link", { url: href! }).catch(() => {}) }}>{children}</a> : <span>{children}</span>,
  }}>{text}</Markdown></div>
}
