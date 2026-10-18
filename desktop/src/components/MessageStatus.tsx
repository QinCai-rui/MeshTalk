import type { Row } from "../api"

export function MessageStatus({ message, own, restore, name }: { message: Row; own: boolean; restore: () => void; name: (id: string) => string }) {
  return <>
    {Boolean(message.failed) && <span className="msg-failed">Failed to send. <button onClick={restore}>Restore to draft</button></span>}
    {Boolean(message.pending) && <span className="msg-state">Sending…</span>}
    {Boolean(message.queued) && !message.pending && <span className="msg-state">Queued — will send on reconnect</span>}
    {own && (message.deliveries?.length ?? 0) > 0 && <details className="receipts"><summary>Delivered to {message.deliveries.filter((d: Row) => d.status === "delivered").length} of {message.deliveries.length}</summary>{message.deliveries.map((d: Row) => <div key={d.recipient_id}>{d.display_name ?? name(d.recipient_id)} · {d.status}</div>)}</details>}
  </>
}
