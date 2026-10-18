import { useEffect, useState } from "react"
import { invoke, request, type Conversation, type Row } from "../api"
import { groupFiles } from "../chatState"
import { Dialog } from "./Dialog"

export type StagedFile = { token: string; name: string; size: number }
export type AttachmentBatch = { conversation: Conversation; files: StagedFile[] }
export function formatSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB` }

export function AttachmentComposer({ batch, onClose, onSent }: { batch: AttachmentBatch; onClose: () => void; onSent: (c: Conversation) => Promise<void> }) {
  const [caption, setCaption] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<Row>()
  useEffect(() => () => { void invoke("discard_attachments", { tokens: batch.files.map(f => f.token) }).catch(() => {}) }, [batch])
  return <Dialog title={`Send to ${batch.conversation.name}`} onClose={() => { if (!busy) onClose() }}>
    <ul>{batch.files.map(f => <li key={f.token}>{f.name} <small>{formatSize(f.size)}</small></li>)}</ul>
    <p>{batch.files.length} files · {formatSize(batch.files.reduce((sum, f) => sum + f.size, 0))}</p>
    {error && <p role="alert">{error}</p>}
    {result ? <><p>Sent {result.results?.length ?? 0} transfers.</p>{result.errors?.length > 0 && <p role="alert">Some files could not be sent. Review Files & transfers before sending them again.</p>}<button onClick={onClose}>Done</button></> : <><label>Caption<textarea maxLength={2000} value={caption} onChange={e => setCaption(e.target.value)} disabled={busy} /></label><div className="actions"><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={async () => {
      setBusy(true); setError("")
      try { const r = await invoke<Row>("send_attachments", { tokens: batch.files.map(f => f.token), target: batch.conversation.id, group: batch.conversation.kind === "group", caption }); setResult(r); await onSent(batch.conversation) } catch (e) { setError(String(e)) } finally { setBusy(false) }
    }}>{busy ? "Sending…" : "Send files"}</button></div></>}
  </Dialog>
}

export function ImagePreview({ file, onClose }: { file: Row; onClose: () => void }) {
  const [src, setSrc] = useState("")
  const [error, setError] = useState("")
  useEffect(() => { let active = true; void invoke<string>("preview_attachment", { fileId: file.file_id }).then(src => { if (active) setSrc(src) }).catch(e => { if (active) setError(String(e)) }); return () => { active = false } }, [file.file_id])
  return <Dialog title={file.filename} onClose={onClose} wide>{error ? <p role="alert">{error}</p> : src ? <img className="image-preview" src={src} alt={file.filename} /> : <p>Loading image…</p>}<button onClick={() => { void invoke("save_file", { fileId: file.file_id }).catch(e => setError(String(e))) }}>Save as…</button></Dialog>
}

export function Files({ onClose, onPreview, onRefresh }: { onClose: () => void; onPreview: (file: Row) => void; onRefresh: () => Promise<void> }) {
  const [files, setFiles] = useState<Row[]>([])
  const [directory, setDirectory] = useState<Row>({})
  const [filter, setFilter] = useState("all")
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<Row>()
  async function load() { const [f, dir] = await Promise.all([request("files"), request("files_dir")]); setFiles(groupFiles(f.files)); setDirectory(dir) }
  useEffect(() => { void load().catch(e => setError(String(e))); const timer = setInterval(() => { void load().catch(() => {}) }, 3000); return () => clearInterval(timer) }, [])
  async function act(work: () => Promise<unknown>) { setBusy(true); try { await work(); await load(); await onRefresh(); setError("") } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  return <Dialog title="Files & transfers" onClose={onClose} wide>
    <div className="search-fields"><input aria-label="Find file" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find file" /><select aria-label="Transfer filter" value={filter} onChange={e => setFilter(e.target.value)}>{["all", "incoming", "outgoing", "queued", "failed", "completed", "images"].map(f => <option key={f}>{f}</option>)}</select><button disabled={busy} onClick={() => act(load)}>Refresh</button></div>
    <details><summary>Download location</summary><p>{directory.files_dir}</p>{directory.env && <p>An environment variable overrides this setting: {directory.env}</p>}<button disabled={busy} onClick={() => act(() => invoke("choose_download_directory", { reset: false }))}>Choose folder…</button><button disabled={busy} onClick={() => act(() => invoke("choose_download_directory", { reset: true }))}>Reset to default</button></details>
    {error && <p role="alert">{error}</p>}
    {deleting && <section className="notice" role="alert"><p>Delete {deleting.filename} from local history and remove its local attachment copy? Other people's copies are retained.</p><button disabled={busy} onClick={() => act(async () => { await request("delete_message", { message_id: deleting.file_id, group_id: deleting.group_id, file: true }); setDeleting(undefined) })}>Delete locally</button><button onClick={() => setDeleting(undefined)}>Cancel</button></section>}
    {files.filter(f => f.filename.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || filter === "images" && /\.(png|jpe?g|gif|webp)$/i.test(f.filename) || f.direction === filter || f.status === filter || filter === "completed" && f.status === "sent")).map(f => <section className="card" key={f.file_id}>
      <strong>{f.filename}</strong><p>{formatSize(f.file_size)} · {f.direction} · {f.status} · {new Date(f.created_at * 1000).toLocaleString()}</p>
      {f.batch_id && <small>Batch attachment {(f.batch_index ?? 0) + 1} of {f.batch_count}</small>}
      {f.total_chunks > 0 && <progress aria-label="Transfer progress" max={f.total_chunks} value={f.received_chunks ?? 0} />}
      {f.caption && <p>{f.caption}</p>}
      <div className="actions"><button disabled={busy} onClick={() => act(() => invoke("save_file", { fileId: f.file_id }))}>Save as…</button>{/\.(png|jpe?g|gif|webp)$/i.test(f.filename) && <button onClick={() => onPreview(f)}>Preview</button>}<button disabled={busy || !f.file_path} onClick={() => act(() => invoke("reveal_attachment", { fileId: f.file_id }))}>Show in folder</button>{["failed", "blocked", "queued"].includes(f.status) && <button disabled={busy} onClick={() => act(() => request("file_retry", { file_id: f.file_id }))}>Retry</button>}<button onClick={() => setDeleting(f)}>Delete locally…</button></div>
      {f.deliveries?.length > 0 && <details><summary>Delivery to {f.deliveries.length} people</summary>{f.deliveries.map((d: Row) => <p key={d.recipient_id}>{d.display_name ?? d.recipient_id.slice(0, 12)} · {d.status}{["failed", "blocked", "queued"].includes(d.status) && <button disabled={busy} onClick={() => act(() => request("file_retry", { file_id: f.file_id, recipient_id: d.recipient_id }))}>Retry recipient</button>}</p>)}</details>}
    </section>)}
    {!files.length && <p>No transfers yet. Attach or drop files into a conversation.</p>}
  </Dialog>
}
