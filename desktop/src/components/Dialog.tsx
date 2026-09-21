import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { Icon } from "./Icon"

export function Dialog({ title, onClose, children, wide = false, className = "" }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.showModal()
    return () => { previous?.focus() }
  }, [])
  return <dialog ref={ref} className={`dialog native-dialog ${wide ? "wide" : ""} ${className}`} aria-label={title} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose() }}>
    <header className="panel-title"><h2>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><Icon name="close" /></button></header>
    {children}
  </dialog>
}
