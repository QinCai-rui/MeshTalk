import type { SVGProps } from "react"

const paths: Record<string, string> = {
  search: "m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  messages: "M21 11.5a8.4 8.4 0 0 1-8.7 8.4 9.6 9.6 0 0 1-4.3-1L3 20l1.4-4.1A8.2 8.2 0 0 1 3 11.5 8.4 8.4 0 0 1 11.7 3 8.4 8.4 0 0 1 21 11.5Z",
  group: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m13-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  plus: "M12 5v14M5 12h14", invite: "M14 3h7v7m0-7-10 10m-6-8H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2",
  people: "M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m15-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  files: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h8",
  help: "M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4m.1 4h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-12v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.51-6.51-1.42 1.42M6.91 17.09l-1.42 1.42m0-13.02 1.42 1.42m10.18 10.18 1.42 1.42",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 13h4",
  attach: "m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5",
  send: "m22 2-7 20-4-9-9-4Z M22 2 11 13",
  details: "M12 11v5m0-9h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  star: "m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L7 14.2 2 9.3l6.9-1Z",
  copy: "M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  trash: "M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-9 0 1 14h10l1-14",
  reply: "m9 17-5-5 5-5m-5 5h10a5 5 0 0 1 5 5v1",
  close: "m6 6 12 12M18 6 6 18",
}
export function Icon({ name, size = 18, ...props }: { name: keyof typeof paths; size?: number } & SVGProps<SVGSVGElement>) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>
}
