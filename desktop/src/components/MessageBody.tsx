import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { invoke } from "../api"

export function MessageBody({ content, name }: { content: string; name: (id: string) => string }) {
  // Escape names before Markdown parsing so display names cannot introduce links or formatting.
  const text = content.replace(/(?<!\\)<@([A-Za-z0-9_-]+)>/g, (_, id: string) => `@${(id === "everyone" ? "everyone" : name(id)).replace(/[\\`*_[\]<>~]/g, "\\$&")}`)
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[External image]"}</span>,
    a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//i.test(href)) void invoke("open_link", { url: href }).catch(() => {}) }}>{children}</a>,
  }}>{text}</Markdown></div>
}
