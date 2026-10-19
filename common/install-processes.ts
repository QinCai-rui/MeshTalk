import { execFileSync } from "node:child_process"
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, relative, sep } from "node:path"

export type InstallationProcess = {
  pid: number
  parentPid: number
  executable: string | null
  identity: string
  sameUser: boolean
  canClose?: boolean
}

// The provider boundary lets tests exercise refusal paths without signalling
// a developer's running installation.
export type InstallationProcessProvider = {
  platform: NodeJS.Platform
  currentPid: number
  canonical(path: string): string
  list(): InstallationProcess[]
  close(process: InstallationProcess): void
  now(): number
  wait(ms: number): Promise<void>
}

function command(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 10000, windowsHide: true })
  } catch {
    throw new Error("Cannot enumerate or verify running MeshTalk processes. Close MeshTalk manually and retry; the installation was not changed.")
  }
}

function named(value: string, platform: NodeJS.Platform): boolean {
  return /^(meshtalk|meshtalk-backend)(\.exe)?$/.test(platform === "win32" ? value.toLowerCase() : value)
}

function possiblyNamed(value: string, platform: NodeJS.Platform): boolean {
  const name = basename(value)
  return named(name, platform) || (platform === "linux" && name === "meshtalk-backen")
}

function gone(error: unknown): boolean {
  return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
}

export function parseUnixInstallationProcesses(text: string): { pid: number; parentPid: number; uid: number; name: string }[] {
  if (!text.trim()) throw new Error("The native process list is empty; refusing to update.")
  const seen = new Set<number>()
  return text.trim().split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) throw new Error("The native process list is malformed; refusing to update.")
    const [, pid, parentPid, uid, name] = match
    const id = Number(pid)
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id) || !Number.isSafeInteger(Number(parentPid)) || !Number.isSafeInteger(Number(uid))) {
      throw new Error("The native process list is malformed; refusing to update.")
    }
    seen.add(id)
    return { pid: id, parentPid: Number(parentPid), uid: Number(uid), name: name! }
  })
}

function unixList(): InstallationProcess[] {
  const platform = process.platform
  const rows = parseUnixInstallationProcesses(command("ps", ["-A", "-o", "pid=,ppid=,uid=,comm="]))
  return rows.map((row) => {
    let executable: string | null = null
    let identity = ""
    let sameUser = row.uid === process.getuid!()
    try {
      if (platform === "linux") {
        // Read start time on both sides of the executable lookup: a PID that
        // changed hands during enumeration must never become a signal target.
        const before = readFileSync(`/proc/${row.pid}/stat`, "utf8")
        const fields = before.slice(before.lastIndexOf(")") + 2).split(" ")
        if (fields[0] === "Z" || fields[0] === "X") return { ...row, executable: null, identity: "exited", sameUser: row.uid === process.getuid!() }
        const path = readlinkSync(`/proc/${row.pid}/exe`)
        executable = path
        const info = statSync(`/proc/${row.pid}/exe`)
        sameUser = sameUser && statSync(`/proc/${row.pid}`).uid === process.getuid!()
        const after = readFileSync(`/proc/${row.pid}/stat`, "utf8")
        if (before.slice(before.lastIndexOf(")") + 2).split(" ")[19] !== after.slice(after.lastIndexOf(")") + 2).split(" ")[19]) {
          throw new Error("A process changed during enumeration. Retry the update.")
        }
        identity = `${fields[19]}:${info.dev}:${info.ino}`
        executable = path
      } else {
        // macOS ps comm reports the executable path, not argv[0].
        executable = row.name
        if (possiblyNamed(row.name, platform)) {
          identity = command("ps", ["-p", String(row.pid), "-o", "lstart="]).trim()
          if (!identity) throw new Error("Cannot verify a process start time. Retry the update.")
        }
      }
    } catch (error) {
      if (!gone(error)) {
        if (possiblyNamed(row.name, platform) || (executable && possiblyNamed(executable.replace(/ \(deleted\)$/, ""), platform))) throw new Error(`Cannot verify MeshTalk process ${row.pid}. Close it manually and retry.`)
        // Inaccessible kernel / other-user executables are not candidates
        // unless ps identifies them as MeshTalk.
      }
      if (gone(error)) {
        if (platform === "linux") {
          try {
            const stat = readFileSync(`/proc/${row.pid}/stat`, "utf8")
            const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
            if (state !== "Z" && state !== "X" && (possiblyNamed(row.name, platform) || (executable && possiblyNamed(executable.replace(/ \(deleted\)$/, ""), platform)))) throw new Error(`Cannot verify MeshTalk process ${row.pid}. Close it manually and retry.`)
          } catch (probe) { if (!gone(probe)) throw probe }
        } else if (possiblyNamed(row.name, platform)) throw error
      }
      executable = null
    }
    return { pid: row.pid, parentPid: row.parentPid, executable, identity, sameUser }
  })
}

const windowsPrelude = `$ErrorActionPreference = 'Stop'; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `

function powershell(script: string): string {
  return command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
}

export function parseWindowsInstallationProcesses(text: string): InstallationProcess[] {
  const rows: unknown = JSON.parse(text.replace(/^\uFEFF/, ""))
  if (!Array.isArray(rows) || !rows.length) throw new Error("The native process list is incomplete; refusing to update.")
  const seen = new Set<number>()
  return rows.map((value) => {
    const row = value as InstallationProcess
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || seen.has(row.pid) || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 ||
      !(row.executable === null || typeof row.executable === "string") || typeof row.identity !== "string" || typeof row.sameUser !== "boolean" || typeof row.canClose !== "boolean") {
      throw new Error("The native process list is malformed; refusing to update.")
    }
    seen.add(row.pid)
    return row
  })
}

function windowsList(): InstallationProcess[] {
  return parseWindowsInstallationProcesses(powershell(windowsPrelude + `
    $rows = @(Get-CimInstance Win32_Process | ForEach-Object {
      $p = $_; $same = $false; $close = $false
      if ($p.Name -match '^(meshtalk|meshtalk-backend)(\\.exe)?$') {
        if (-not $p.ExecutablePath) { throw 'MeshTalk executable path is inaccessible' }
        $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0) { throw 'MeshTalk owner is inaccessible' }
        $same = $owner.Sid -eq $sid
        $close = (Get-Process -Id $p.ProcessId -ErrorAction Stop).MainWindowHandle -ne 0
      }
      $identity = ''; if ($p.CreationDate) { $identity = [string]$p.CreationDate.ToUniversalTime().Ticks }
      [pscustomobject]@{ pid = [int]$p.ProcessId; parentPid = [int]$p.ParentProcessId; executable = $p.ExecutablePath; identity = $identity; sameUser = $same; canClose = $close }
    }); ConvertTo-Json -InputObject $rows -Compress
  `))
}

const nativeProvider: InstallationProcessProvider = {
  platform: process.platform,
  currentPid: process.pid,
  canonical: realpathSync,
  list: () => {
    if (process.platform === "win32") return windowsList()
    if (process.platform === "linux" || process.platform === "darwin") return unixList()
    throw new Error("Automatic MeshTalk closing is not supported on this platform. Close it manually and retry.")
  },
  close: (target) => {
    if (process.platform !== "win32") {
      try { process.kill(target.pid, "SIGTERM") } catch (error) { if (!gone(error)) throw error }
      return
    }
    // taskkill without /F can still terminate console applications. Never use
    // it as a supposedly graceful fallback. Recheck CIM identity in the same
    // command that requests the GUI window close.
    const encoded = Buffer.from(JSON.stringify(target)).toString("base64")
    const script = windowsPrelude + `
      $target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
      $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $target.pid)
      if (-not $p) { exit 0 }
      $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
      if ([string]$p.CreationDate.ToUniversalTime().Ticks -ne $target.identity -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid -or $p.ExecutablePath -ne $target.executable) { throw 'Process identity changed' }
      $process = Get-Process -Id $target.pid -ErrorAction Stop
      if (-not $process.CloseMainWindow()) { throw 'No graceful window close is available; close MeshTalk manually' }
    `
    powershell(script)
  },
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export function installationProcessController(provider: InstallationProcessProvider) {
  const normalize = (path: string) => provider.platform === "win32" ? path.toLowerCase() : path
  function roots(root: string, additional: string[]): string[] {
    return [root, ...additional].map((path) => normalize(provider.canonical(path)))
  }
  function targets(rows: InstallationProcess[], allowed: string[]): InstallationProcess[] {
    const seen = new Set<number>()
    for (const row of rows) {
      if (!Number.isSafeInteger(row.pid) || row.pid < 0 || seen.has(row.pid) || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0) throw new Error("The native process list is malformed; refusing to update.")
      seen.add(row.pid)
    }
    if (!seen.has(provider.currentPid)) throw new Error("The native process list is incomplete; refusing to update.")
    return rows.filter((row) => {
      if (row.pid === provider.currentPid || !row.executable) return false
      if (row.executable.endsWith(" (deleted)") && named(basename(row.executable.slice(0, -10)), provider.platform)) throw new Error(`MeshTalk process ${row.pid} is using a deleted executable. Close it manually and retry.`)
      if (!named(basename(row.executable), provider.platform)) return false
      if (!isAbsolute(row.executable) || !row.identity) throw new Error(`Cannot verify MeshTalk process ${row.pid}. Close it manually and retry.`)
      let path: string
      try { path = normalize(provider.canonical(row.executable)) } catch { throw new Error(`Cannot verify MeshTalk process ${row.pid}. Close it manually and retry.`) }
      if (!allowed.some((root) => { const part = relative(root, path); return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part) })) return false
      if (!row.sameUser) throw new Error(`MeshTalk process ${row.pid} belongs to another user. Ask that user to close it, then retry.`)
      return true
    })
  }
  return {
    pids(root: string, additional: string[] = []): number[] {
      return targets(provider.list(), roots(root, additional)).map((row) => row.pid)
    },
    async close(root: string, additional: string[] = [], timeoutMs = 10000): Promise<void> {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid MeshTalk close timeout.")
      const allowed = roots(root, additional)
      const initial = provider.list()
      const pending = targets(initial, allowed)
      const ancestors = new Set<number>()
      let parent = initial.find((row) => row.pid === provider.currentPid)?.parentPid
      while (parent && !ancestors.has(parent)) {
        ancestors.add(parent)
        parent = initial.find((row) => row.pid === parent)?.parentPid
      }
      // Preflight the entire snapshot before closing even one process.
      for (const row of pending) {
        if (ancestors.has(row.pid)) throw new Error(`MeshTalk process ${row.pid} launched this updater and is still running. Close it and run the installer from a separate terminal.`)
        if (provider.platform === "win32" && !row.canClose) throw new Error(`MeshTalk process ${row.pid} has no graceful window-close support. Close it manually and retry.`)
      }
      const deadline = provider.now() + timeoutMs
      for (const target of pending) {
        const rows = provider.list()
        targets(rows, allowed)
        const current = rows.find((row) => row.pid === target.pid)
        if (!current || current.identity !== target.identity || current.executable !== target.executable) continue
        if (!current.sameUser) throw new Error("MeshTalk process ownership changed. Close it manually and retry.")
        provider.close(current)
      }
      while (true) {
        const remaining = targets(provider.list(), allowed)
        if (!remaining.length) return
        if (provider.now() >= deadline) throw new Error(`MeshTalk is still running (PID ${remaining.map((row) => row.pid).join(", ")}). Close it manually and retry; no forced termination was attempted.`)
        await provider.wait(Math.min(100, Math.max(1, deadline - provider.now())))
      }
    },
  }
}

export function installationProcessPids(root: string, additionalRoots: string[] = []): number[] {
  return installationProcessController(nativeProvider).pids(root, additionalRoots)
}

export async function closeInstallationProcesses(root: string, additionalRoots: string[] = [], timeoutMs = 10000): Promise<void> {
  await installationProcessController(nativeProvider).close(root, additionalRoots, timeoutMs)
}
