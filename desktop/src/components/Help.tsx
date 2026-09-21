import { Dialog } from "./Dialog"

export function Help({ onClose }: { onClose: () => void }) {
  const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl"
  return <Dialog title="Keyboard shortcuts" onClose={onClose}>
    <dl className="shortcut-list">{[
      [`${mod}+K`, "Jump to a conversation or action"], [`${mod}+F`, "Search messages"], [`${mod}+,`, "Settings"], [`${mod}+Shift+P`, "People and friend requests"], [`${mod}+U`, "Attach files"], [`${mod}+Shift+F`, "Files and transfers"], [`Alt+↑ / Alt+↓`, "Previous / next conversation"], ["Enter", "Send message"], ["Shift+Enter", "New line"], ["↑ / ↓ in mentions", "Choose mention; Enter or Tab inserts"], ["Tab", "Move between controls and message actions"], ["Escape", "Close dialog or cancel reply"], [`${mod}+/`, "Keyboard shortcuts"],
    ].map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
  </Dialog>
}
