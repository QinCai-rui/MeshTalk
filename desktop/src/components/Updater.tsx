import { useEffect, useState } from "react"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { invoke } from "../api"

export function Updater({ channel }: { channel: string }) {
  const [configured, setConfigured] = useState(false)
  const [update, setUpdate] = useState<Update>()
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState(false)
  useEffect(() => { void invoke<boolean>("updater_available").then(setConfigured).catch(() => {}) }, [])
  useEffect(() => () => { void update?.close() }, [update])
  if (!configured) return <p className="muted">Signed in-app updates are not configured for this build. Use the release downloads below.</p>
  return <section className="card"><h3>Signed desktop updates</h3><p role="status">{status || "Updates are verified before installation."}</p>
    {!installed && <button disabled={busy} onClick={async () => {
      setBusy(true)
      try { const result = await check({ headers: { "X-MeshTalk-Channel": channel } }); setUpdate(result ?? undefined); setStatus(result ? `Version ${result.version} available` : "Up to date") } catch (e) { setStatus(String(e)) } finally { setBusy(false) }
    }}>Check signed update</button>}
    {update && !installed && <><pre>{update.body}</pre><button disabled={busy} onClick={async () => {
      setBusy(true)
      try { let received = 0; await update.downloadAndInstall(event => { if (event.event === "Started") setStatus("Downloading update…"); if (event.event === "Progress") { received += event.data.chunkLength; setStatus(`Downloaded ${(received / 1024 / 1024).toFixed(1)} MB`) } if (event.event === "Finished") setStatus("Verifying and installing…") }); setInstalled(true); setStatus("Update installed. Restart when ready.") } catch (e) { setStatus(String(e)) } finally { setBusy(false) }
    }}>Install update</button></>}
    {installed && <button onClick={() => { void relaunch().catch(e => setStatus(String(e))) }}>Restart now</button>}
  </section>
}
