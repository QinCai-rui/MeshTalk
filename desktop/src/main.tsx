import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./style.css"

function showBootError(error: unknown) {
  const root = document.getElementById("root")
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
  if (root) {
    root.innerHTML = ""
    const pre = document.createElement("pre")
    pre.style.cssText = "padding:24px;white-space:pre-wrap;word-break:break-word;font-size:13px;"
    pre.textContent = `MeshTalk failed to start:\n\n${detail}`
    root.appendChild(pre)
  }
  document.title = "MeshTalk failed to start"
}

window.addEventListener("error", (event) => showBootError(event.error ?? event.message))
window.addEventListener("unhandledrejection", (event) => showBootError(event.reason))

try {
  createRoot(document.getElementById("root")!).render(<App />)
} catch (error) {
  showBootError(error)
}
