import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { physicalPath } from "../common/install-paths"

const powershell = Bun.which("powershell.exe") ?? Bun.which("pwsh")
const installer = fileURLToPath(new URL("./install.ps1", import.meta.url))
const roots: string[] = []
const prompt = "MeshTalk is running. Close all instances and continue?"

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Options = {
  status?: string
  answer?: string
  yes?: boolean
  nonInteractive?: boolean
  closeRunning?: boolean
}

function run(action: "install" | "uninstall", options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "meshtalk-powershell-test-"))
  roots.push(root)
  const destination = join(root, "installed files")
  const extracted = join(root, "downloaded files")
  mkdirSync(destination)
  mkdirSync(extracted)
  const helper = `
Add-Content -LiteralPath $env:CALLS -Value (ConvertTo-Json -InputObject @{ path = $PSCommandPath; args = @($args) } -Compress)
if ($args[0] -eq '--install-protocol') { Write-Output '1'; exit 0 }
if ($args[0] -eq '--install-status') {
    switch ($env:STATUS) {
        'error' { Write-Output 'running'; exit 9 }
        'empty' { exit 0 }
        'extra' { Write-Output 'running'; Write-Output 'extra'; exit 0 }
        'blank-line' { Write-Output 'running'; Write-Output ''; exit 0 }
        default { Write-Output $env:STATUS; exit 0 }
    }
}
exit 0
`
  writeFileSync(join(extracted, "meshtalk.ps1"), helper)
  writeFileSync(join(destination, "meshtalk.ps1"), helper)
  writeFileSync(join(destination, "meshtalk-backend"), "old backend")
  writeFileSync(join(destination, "unrelated"), "keep me")
  const harness = join(root, "test.ps1")
  writeFileSync(harness, `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Load only these definitions, never the installer's top-level code or Main.
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$names = @('Test-InstallProtocol', 'Confirm-InstallClosePermission', 'Install-Extracted', 'Uninstall-ManagedReleases')
$functions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names }, $false))
if ($functions.Count -ne $names.Count) { throw 'Missing installer function.' }
foreach ($definition in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }
function Read-Confirmation {
    param([string]$Prompt, [string]$Default)
    Write-Host $Prompt
    if ($Default -ne 'n' -or $script:AssumeYes) { throw 'Unsafe confirmation defaults.' }
    switch ($env:ANSWER) {
        'yes' { return $true }
        'eof' { return $null }
        'read-error' { throw 'Input stream closed.' }
        default { return $false }
    }
}
$script:PlatformName = 'windows'
$script:LauncherName = 'meshtalk.ps1'
$script:InstallDirSel = $env:DESTINATION
$script:NonInteractive = $env:NON_INTERACTIVE -eq 'true'
$script:AssumeYes = $env:ASSUME_YES -eq 'true'
$script:CloseRunningFlag = $env:CLOSE_RUNNING -eq 'true'
$code = 0
try {
    if ($env:ACTION -eq 'install') { Install-Extracted -ExtractDir $env:EXTRACTED }
    else { Uninstall-ManagedReleases }
} catch {
    Write-Host "FAILURE: $_"
    $code = 1
} finally {
    Write-Host "ASSUME_YES=$script:AssumeYes"
    Write-Host "CLOSE_RUNNING=$script:CloseRunningFlag"
}
exit $code
`)
  const callsFile = join(root, "calls.jsonl")
  const result = Bun.spawnSync([powershell!, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
    env: {
      ...process.env,
      INSTALLER: installer,
      DESTINATION: destination,
      EXTRACTED: extracted,
      CALLS: callsFile,
      ACTION: action,
      STATUS: options.status ?? "running",
      ANSWER: options.answer ?? "no",
      ASSUME_YES: String(options.yes ?? false),
      NON_INTERACTIVE: String(options.nonInteractive ?? false),
      CLOSE_RUNNING: String(options.closeRunning ?? false),
    },
  })
  const calls: { path: string; args: string[] }[] = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, "")))
    : []
  expect(readFileSync(join(destination, "meshtalk.ps1"), "utf8")).toBe(helper)
  expect(readFileSync(join(destination, "meshtalk-backend"), "utf8")).toBe("old backend")
  expect(readFileSync(join(destination, "unrelated"), "utf8")).toBe("keep me")
  return { result, calls, output: result.stdout.toString() + result.stderr.toString(), destination, extracted }
}

if (!powershell) console.warn("Skipping executable PowerShell installer tests: neither pwsh nor powershell.exe is available.")

describe.skipIf(!powershell)("PowerShell installer close permission", () => {
  for (const action of ["install", "uninstall"] as const) {
    const mutation = action === "install" ? "--install-from" : "--uninstall-releases"
    const mutations = (calls: { path: string; args: string[] }[]) => calls.filter(call => call.args[0] === mutation)

    test(`${action}: yes grants permission through the managed helper`, () => {
      const f = run(action, { answer: "yes" })
      expect(f.result.exitCode).toBe(0)
      expect(f.output).toContain(prompt)
      expect(f.output).toContain("interrupts active sessions and file transfers")
      const status = f.calls.find(call => call.args[0] === "--install-status")!
      expect(status.args).toEqual(["--install-status", "--install-dir", f.destination])
      expect(mutations(f.calls).map(call => call.args)).toEqual([
        [...(action === "install" ? [mutation, f.extracted] : [mutation]), "--install-dir", f.destination, "--close-running"],
      ])
      expect(status.path).toBe(mutations(f.calls)[0]!.path)
      if (action === "install") expect(physicalPath(status.path)).toBe(physicalPath(join(f.extracted, "meshtalk.ps1")))
      else {
        expect(status.path).not.toBe(join(f.destination, "meshtalk.ps1"))
        expect(existsSync(status.path)).toBe(false)
      }
    })

    test.each(["no", "eof", "read-error"])(`${action}: %s cancels before mutation`, answer => {
      const f = run(action, { answer, yes: true })
      expect(f.result.exitCode).toBe(1)
      expect(f.output).toContain(prompt)
      expect(f.output).toContain("Installed files were left unchanged")
      expect(f.output).toContain("ASSUME_YES=True")
      expect(f.output).toContain("CLOSE_RUNNING=False")
      expect(mutations(f.calls)).toEqual([])
    })

    test(`${action}: stopped skips confirmation and does not grant close permission`, () => {
      const f = run(action, { status: "stopped" })
      expect(f.result.exitCode).toBe(0)
      expect(f.output).not.toContain(prompt)
      expect(mutations(f.calls)).toHaveLength(1)
      expect(mutations(f.calls)[0]!.args).not.toContain("--close-running")
    })

    test.each(["error", "empty", "extra", "blank-line", "unknown", "Running", "stopped "])(`${action}: invalid status %s fails closed`, status => {
      const f = run(action, { status, answer: "yes" })
      expect(f.result.exitCode).toBe(1)
      expect(f.output).toContain("Unable to inspect running MeshTalk processes")
      expect(f.output).toContain("Installed files were left unchanged")
      expect(f.output).not.toContain(prompt)
      expect(mutations(f.calls)).toEqual([])
    })

    test.each([
      { nonInteractive: true },
      { closeRunning: true },
      { nonInteractive: true, closeRunning: true },
    ])(`${action}: automation preserves existing helper behavior with %j`, options => {
      const f = run(action, { ...options, status: "error" })
      expect(f.result.exitCode).toBe(0)
      expect(f.calls.some(call => call.args[0] === "--install-status")).toBe(false)
      expect(f.output).not.toContain(prompt)
      expect(mutations(f.calls)).toHaveLength(1)
      expect(mutations(f.calls)[0]!.args.includes("--close-running")).toBe(!!options.closeRunning)
    })

    test(`${action}: generic Yes still prompts and is restored after approval`, () => {
      const f = run(action, { yes: true, answer: "yes" })
      expect(f.result.exitCode).toBe(0)
      expect(f.output).toContain(prompt)
      expect(f.output).toContain("ASSUME_YES=True")
      expect(mutations(f.calls)[0]!.args).toContain("--close-running")
    })
  }
})
