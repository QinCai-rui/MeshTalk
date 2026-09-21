import { useState } from "react"
import { Dialog } from "./Dialog"

export type QuickAction = { id: string; label: string; detail?: string; run: () => void }
export function QuickSwitcher({ actions, onClose }: { actions: QuickAction[]; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const matches = actions.filter(a => `${a.label} ${a.detail ?? ""}`.toLowerCase().includes(query.toLowerCase())).slice(0, 40)
  function choose(i: number) { const action = matches[i]; if (action) { onClose(); action.run() } }
  return <Dialog title="Jump to…" onClose={onClose}>
    <input autoFocus className="full-width" role="combobox" aria-label="Search conversations and actions" aria-expanded={true} aria-controls="quick-results" aria-activedescendant={matches[index] ? `quick-${index}` : undefined} placeholder="Search conversations and actions" value={query} onChange={e => { setQuery(e.target.value); setIndex(0) }} onKeyDown={e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setIndex(i => matches.length ? (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length : 0) }
      if (e.key === "Enter") { e.preventDefault(); choose(index) }
    }} />
    <div id="quick-results" role="listbox" className="quick-results">{matches.map((a, i) => <button id={`quick-${i}`} role="option" aria-selected={index === i} className={index === i ? "selected" : ""} key={a.id} onClick={() => choose(i)}><strong>{a.label}</strong><small>{a.detail}</small></button>)}</div>
    {!matches.length && <p>No matches.</p>}
  </Dialog>
}
