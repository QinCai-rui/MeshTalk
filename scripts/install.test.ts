import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const roots: string[] = []
const installer = readFileSync(new URL("./install.sh", import.meta.url), "utf8").replace(/^main "\$@"$/m, "")
const powershellInstaller = readFileSync(new URL("./install.ps1", import.meta.url), "utf8")

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(launcher = "exit 2") {
  const root = mkdtempSync(join(tmpdir(), "meshtalk-install-test-"))
  roots.push(root)
  const destination = join(root, "shared bin")
  const extracted = join(root, "extracted")
  mkdirSync(destination)
  mkdirSync(extracted)
  writeFileSync(join(extracted, "meshtalk"), `#!/usr/bin/env bash\n${launcher}\n`)
  writeFileSync(join(extracted, "meshtalk-backend"), "new backend")
  writeFileSync(join(destination, "meshtalk"), "old launcher")
  writeFileSync(join(destination, "meshtalk-backend"), "old backend")
  writeFileSync(join(destination, "unrelated"), "keep me")
  return { root, destination, extracted }
}

function run(f: ReturnType<typeof fixture>, body = 'install_extracted "$EXTRACTED"', input?: string) {
  return Bun.spawnSync(["bash", "-c", `${installer}\nINSTALL_DIR=$DESTINATION\nPLATFORM=linux\nNON_INTERACTIVE=1\nLAUNCHER_NAME=meshtalk\nEXPECTED_FILES=(meshtalk meshtalk-backend)\n${body}`], {
    env: { ...process.env, DESTINATION: f.destination, EXTRACTED: f.extracted, TMPDIR: f.root },
    stdin: input === undefined ? "ignore" : Buffer.from(input),
  })
}

function uninstallFixture(marker = ".meshtalk-install.json", launcher?: string) {
  const f = fixture()
  mkdirSync(join(f.destination, "versions", "unknown"), { recursive: true })
  writeFileSync(join(f.destination, "versions", "unknown", "unrelated"), "keep release")
  mkdirSync(join(f.destination, ".meshtalk-usage"))
  writeFileSync(join(f.destination, ".meshtalk-usage", "unknown"), "keep usage")
  writeFileSync(join(f.destination, ".meshtalk-install-lock.sqlite"), "lock tombstone")
  if (marker) writeFileSync(join(f.destination, marker), "marker")
  if (launcher !== undefined) {
    writeFileSync(join(f.destination, "meshtalk"), `#!/usr/bin/env bash\n${launcher}\n`)
    chmodSync(join(f.destination, "meshtalk"), 0o700)
  }
  return f
}

function expectUnknownPreserved(f: ReturnType<typeof fixture>) {
  expect(readFileSync(join(f.destination, "versions", "unknown", "unrelated"), "utf8")).toBe("keep release")
  expect(readFileSync(join(f.destination, ".meshtalk-usage", "unknown"), "utf8")).toBe("keep usage")
  expect(readFileSync(join(f.destination, ".meshtalk-install-lock.sqlite"), "utf8")).toBe("lock tombstone")
  expect(readFileSync(join(f.destination, "unrelated"), "utf8")).toBe("keep me")
}

describe("Bash installer release handoff", () => {
  test.each(["", "--yes"])("asks before closing running instances and forwards consent without a user flag: %s", options => {
    const f = fixture('if [[ $1 == --install-protocol ]]; then echo 1; elif [[ $1 == --install-status ]]; then echo running; else printf "%s\\n" "$@" > "$DESTINATION/arguments"; fi')
    const result = run(f, `NON_INTERACTIVE=0; parse_arguments ${options}; prompt_read() { printf '%s|%s' "$2" "$ASSUME_YES" > "$DESTINATION/question"; printf -v "$1" yes; }; install_extracted "$EXTRACTED"; printf '%s' "$ASSUME_YES" > "$DESTINATION/assume-yes"`)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(f.destination, "question"), "utf8")).toContain("MeshTalk is running. Close all instances and continue?")
    expect(readFileSync(join(f.destination, "question"), "utf8")).toEndWith("|0")
    expect(readFileSync(join(f.destination, "arguments"), "utf8")).toBe(`--install-from\n${f.extracted}\n--install-dir\n${f.destination}\n--close-running\n`)
    expect(readFileSync(join(f.destination, "assume-yes"), "utf8")).toBe(options ? "1" : "0")
  })

  test.each(["no", ""])("declining or leaving the close question empty preserves installed files: %s", answer => {
    const f = fixture('if [[ $1 == --install-protocol ]]; then echo 1; elif [[ $1 == --install-status ]]; then echo running; else touch "$DESTINATION/helper-ran"; fi')
    const result = run(f, `NON_INTERACTIVE=0; ASSUME_YES=1; prompt_read() { printf -v "$1" '${answer}'; }; install_extracted "$EXTRACTED"`)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Cancelled")
    expect(existsSync(join(f.destination, "helper-ran"))).toBe(false)
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
  })

  test.each(["yes", "y", ""])("EOF without a completed answer never grants close permission: %j", answer => {
    const f = fixture('if [[ $1 == --install-protocol ]]; then echo 1; elif [[ $1 == --install-status ]]; then echo running; else touch "$DESTINATION/helper-ran"; fi')
    const result = run(f, 'NON_INTERACTIVE=0; ASSUME_YES=1; install_extracted "$EXTRACTED"', answer)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Cancelled")
    expect(existsSync(join(f.destination, "helper-ran"))).toBe(false)
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
  })

  test("a stopped installation continues without a close question", () => {
    const f = fixture('if [[ $1 == --install-protocol ]]; then echo 1; elif [[ $1 == --install-status ]]; then echo stopped; else printf "%s\\n" "$@" > "$DESTINATION/arguments"; fi')
    const result = run(f, 'NON_INTERACTIVE=0; prompt_read() { return 99; }; install_extracted "$EXTRACTED"')
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(f.destination, "arguments"), "utf8")).not.toContain("--close-running")
  })

  test.each(["exit 7", "echo invalid", "printf 'running\\nextra\\n'", "printf 'running\\n\\n'"])("status failures stop before asking or installing: %s", status => {
    const f = fixture(`if [[ $1 == --install-protocol ]]; then echo 1; elif [[ $1 == --install-status ]]; then ${status}; else touch "$DESTINATION/helper-ran"; fi`)
    const result = run(f, 'NON_INTERACTIVE=0; prompt_read() { touch "$DESTINATION/prompted"; }; install_extracted "$EXTRACTED"')
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(join(f.destination, "helper-ran"))).toBe(false)
    expect(existsSync(join(f.destination, "prompted"))).toBe(false)
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
  })

  test("managed uninstall also asks before closing without requiring a flag", () => {
    const f = uninstallFixture(".meshtalk-install.json", 'if [[ $1 == --install-protocol ]]; then echo 1; elif [[ $1 == --install-status ]]; then echo running; else printf "%s\\n" "$@" > "$DESTINATION/arguments"; fi')
    const result = run(f, 'NON_INTERACTIVE=0; ASSUME_YES=1; prompt_read() { printf -v "$1" yes; }; uninstall_meshtalk')
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(f.destination, "arguments"), "utf8")).toContain("--close-running")
  })

  test.each(["", "--yes", "-y", "--close-running", "--yes --close-running"])("forwards close-running only when explicitly selected: %s", options => {
    const f = fixture('if [[ $1 == --install-protocol ]]; then echo 1; else printf "%s\\n" "$@" > "$DESTINATION/arguments"; fi')
    const result = run(f, `parse_arguments ${options}; install_extracted "$EXTRACTED"`)
    expect(result.exitCode).toBe(0)
    const closeArgument = options.includes("--close-running") ? "--close-running\n" : ""
    expect(readFileSync(join(f.destination, "arguments"), "utf8")).toBe(`--install-from\n${f.extracted}\n--install-dir\n${f.destination}\n${closeArgument}`)
  })

  test("documents explicit process-close permission separately from yes", () => {
    const result = run(fixture(), "parse_arguments --help")
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("--close-running")
    expect(result.stdout.toString()).toContain("Not implied by --yes")
  })

  test.each(["", ".meshtalk-install.json"])("refuses historical install with close-running before fallback (marker: %s)", marker => {
    const f = fixture()
    if (marker) writeFileSync(join(f.destination, marker), "marker")
    const result = run(f, 'parse_arguments --yes --close-running; install_extracted "$EXTRACTED"')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("--close-running requires a supported installation helper")
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
  })

  test.each(["", ".meshtalk-install.json", ".meshtalk-install.json.bak"])("refuses unsupported uninstall with close-running without deleting files (marker: %s)", marker => {
    const f = uninstallFixture(marker)
    const result = run(f, "parse_arguments --yes --close-running; uninstall_meshtalk")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("--close-running requires a supported managed uninstall helper")
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
    if (marker) expect(readFileSync(join(f.destination, marker), "utf8")).toBe("marker")
    expectUnknownPreserved(f)
  })

  test.each(["--yes", "--yes --close-running"])("hands Windows managed uninstall to helper without script process checks: %s", options => {
    const f = uninstallFixture(".meshtalk-install.json", 'if [[ $1 == --install-protocol ]]; then echo 1; else printf "%s\\n" "$@" > "$DESTINATION/arguments"; fi')
    const result = run(f, `PLATFORM=windows; require_windows_stopped() { return 9; }; parse_arguments ${options}; uninstall_meshtalk`)
    expect(result.exitCode).toBe(0)
    const closeArgument = options.includes("--close-running") ? "--close-running\n" : ""
    expect(readFileSync(join(f.destination, "arguments"), "utf8")).toBe(`--uninstall-releases\n--install-dir\n${f.destination}\n${closeArgument}`)
  })

  test("runs the extracted managed installer with both paths and preserves managed state", () => {
    const f = fixture('if [[ $1 == --install-protocol ]]; then echo 1; else printf "%s\\n" "$@" > "$DESTINATION/arguments"; fi')
    writeFileSync(join(f.destination, ".meshtalk-install.json"), "marker")
    mkdirSync(join(f.destination, "versions"))
    writeFileSync(join(f.destination, "versions", "active"), "keep")
    const result = run(f)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(f.destination, "arguments"), "utf8")).toBe(`--install-from\n${f.extracted}\n--install-dir\n${f.destination}\n`)
    expect(readFileSync(join(f.destination, "versions", "active"), "utf8")).toBe("keep")
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
  })

  test("does not fall back after managed installation failure", () => {
    const f = fixture('if [[ $1 == --install-protocol ]]; then echo 1; else exit 9; fi')
    expect(run(f).exitCode).not.toBe(0)
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
  })

  test.each(["exit 2", "echo 1; exit 2", "echo '1 extra'", "printf '1\\nextra\\n'", "printf '1\\n\\n'"])("refuses historical release over managed marker: %s", launcher => {
    const f = fixture(launcher)
    writeFileSync(join(f.destination, ".meshtalk-install.json"), "marker")
    const result = run(f)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("explicitly uninstall")
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
  })

  test("refuses historical release when only the managed backup remains", () => {
    const f = fixture()
    writeFileSync(join(f.destination, ".meshtalk-install.json.bak"), "marker")
    const result = run(f)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("explicitly uninstall")
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
  })

  test("legacy install preserves unrelated files and the versions directory", () => {
    const f = fixture()
    mkdirSync(join(f.destination, "versions"))
    writeFileSync(join(f.destination, "versions", "unrelated"), "keep")
    expect(run(f).exitCode).toBe(0)
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("new backend")
    expect(readFileSync(join(f.destination, "versions", "unrelated"), "utf8")).toBe("keep")
    expect(readFileSync(join(f.destination, "unrelated"), "utf8")).toBe("keep me")
  })

  test("failed second staging copy leaves both old files untouched", () => {
    const f = fixture()
    const result = run(f, 'cp() { if [[ $1 == -p && $2 == "$EXTRACTED/meshtalk-backend" ]]; then return 1; fi; command cp "$@"; }; install_extracted "$EXTRACTED"')
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
  })

  test("failed second replacement restores the old launcher", () => {
    const f = fixture()
    const result = run(f, 'mv() { if [[ $2 == */new/meshtalk-backend ]]; then return 1; fi; command mv "$@"; }; install_extracted "$EXTRACTED"')
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
  })

  test("Windows legacy replacement refuses running processes", () => {
    const f = fixture()
    const tools = join(f.root, "tools")
    mkdirSync(tools)
    writeFileSync(join(tools, "powershell.exe"), "#!/usr/bin/env bash\nexit 1\n")
    chmodSync(join(tools, "powershell.exe"), 0o700)
    const result = run(f, `PLATFORM=windows; PATH="${tools}:$PATH"; install_extracted "$EXTRACTED"`)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Close all MeshTalk")
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("old launcher")
  })

  test.each(["", ".meshtalk-install.json", ".meshtalk-install.json.bak"])("uninstall without supported launcher preserves unknown directories (marker: %s)", marker => {
    const f = uninstallFixture(marker)
    for (const state of [".meshtalk-current.json", ".meshtalk-current.json.bak", ".meshtalk-pending.json"]) {
      writeFileSync(join(f.destination, state), "selector")
    }
    const result = run(f, "ASSUME_YES=1; uninstall_meshtalk")
    expect(result.exitCode).toBe(0)
    if (marker) expect(result.stderr.toString()).toContain("inspect them manually")
    expect(existsSync(join(f.destination, "meshtalk"))).toBe(false)
    expect(existsSync(join(f.destination, ".meshtalk-install.json"))).toBe(false)
    expect(existsSync(join(f.destination, ".meshtalk-install.json.bak"))).toBe(false)
    for (const state of [".meshtalk-current.json", ".meshtalk-current.json.bak", ".meshtalk-pending.json"]) {
      expect(existsSync(join(f.destination, state))).toBe(false)
    }
    expectUnknownPreserved(f)
  })

  test("backup-only managed uninstall without root launcher retains directories", () => {
    const f = uninstallFixture(".meshtalk-install.json.bak")
    rmSync(join(f.destination, "meshtalk"))
    rmSync(join(f.destination, "meshtalk-backend"))
    const result = run(f, "ASSUME_YES=1; uninstall_meshtalk")
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toContain("inspect them manually")
    expect(existsSync(join(f.destination, ".meshtalk-install.json.bak"))).toBe(false)
    expectUnknownPreserved(f)
  })

  test.each([".meshtalk-install.json", ".meshtalk-install.json.bak"])("copies root launcher and hands all managed removal to the copy (%s)", marker => {
    const f = uninstallFixture(marker, `if [[ $1 == --install-protocol ]]; then echo 1; exit; fi
[[ -f "$DESTINATION/meshtalk" && -f "$DESTINATION/meshtalk-backend" ]] || exit 7
[[ $0 != "$DESTINATION/meshtalk" && $0 == */meshtalk ]] || exit 8
printf '%s' "$0" > "$DESTINATION/uninstall-helper"
printf '%s\\n' "$@" > "$DESTINATION/uninstall-arguments"
rm -rf -- "$DESTINATION/versions/owned"
rm -f -- "$DESTINATION/.meshtalk-install.json" "$DESTINATION/.meshtalk-install.json.bak" "$DESTINATION/meshtalk" "$DESTINATION/meshtalk-backend"`)
    mkdirSync(join(f.destination, "versions", "owned"))
    const result = run(f, "ASSUME_YES=1; uninstall_meshtalk")
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(f.destination, "uninstall-arguments"), "utf8")).toBe(`--uninstall-releases\n--install-dir\n${f.destination}\n`)
    expect(existsSync(join(f.destination, "versions", "owned"))).toBe(false)
    expect(existsSync(join(f.destination, "meshtalk"))).toBe(false)
    expect(existsSync(join(f.destination, "meshtalk-backend"))).toBe(false)
    expect(existsSync(join(f.destination, marker))).toBe(false)
    const helper = readFileSync(join(f.destination, "uninstall-helper"), "utf8")
    expect(basename(helper)).toBe("meshtalk")
    expect(dirname(helper)).not.toBe(f.destination)
    expect(existsSync(dirname(helper))).toBe(false)
    expectUnknownPreserved(f)
  })

  test("failed managed uninstall aborts without deleting binaries or named state", () => {
    const f = uninstallFixture(".meshtalk-install.json", 'if [[ $1 == --install-protocol ]]; then echo 1; else printf "%s" "$0" > "$DESTINATION/uninstall-helper"; exit 9; fi')
    writeFileSync(join(f.destination, ".meshtalk-install.json.bak"), "backup")
    writeFileSync(join(f.destination, ".meshtalk-current.json"), "selector")
    const result = run(f, "ASSUME_YES=1; uninstall_meshtalk")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Managed uninstall failed")
    expect(existsSync(join(f.destination, "meshtalk"))).toBe(true)
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
    expect(readFileSync(join(f.destination, ".meshtalk-install.json"), "utf8")).toBe("marker")
    expect(readFileSync(join(f.destination, ".meshtalk-install.json.bak"), "utf8")).toBe("backup")
    expect(readFileSync(join(f.destination, ".meshtalk-current.json"), "utf8")).toBe("selector")
    const helper = readFileSync(join(f.destination, "uninstall-helper"), "utf8")
    expect(dirname(helper)).not.toBe(f.destination)
    expect(existsSync(dirname(helper))).toBe(false)
    expectUnknownPreserved(f)
  })

  test("failed helper copy cleans temporary directory and leaves installation untouched", () => {
    const f = uninstallFixture(".meshtalk-install.json", "echo 1")
    const result = run(f, 'cp() { return 1; }; ASSUME_YES=1; uninstall_meshtalk')
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(join(f.destination, "meshtalk"))).toBe(true)
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("old backend")
    expect(readFileSync(join(f.destination, ".meshtalk-install.json"), "utf8")).toBe("marker")
    expect(readdirSync(f.root).filter(name => name.startsWith("meshtalk-uninstaller."))).toEqual([])
    expectUnknownPreserved(f)
  })

  test("does not delete a new installation published after the managed helper returns", () => {
    const f = uninstallFixture(".meshtalk-install.json", `if [[ $1 == --install-protocol ]]; then echo 1; exit; fi
rm -f -- "$DESTINATION/meshtalk" "$DESTINATION/meshtalk-backend" "$DESTINATION/.meshtalk-install.json" "$DESTINATION/.meshtalk-current.json"`)
    // The helper's EXIT cleanup runs after the executable exits. Publish the
    // waiting installation there, before control returns to the outer script.
    const result = run(f, `rm() {
  if [[ $* == *meshtalk-uninstaller.* ]]; then
    command rm "$@"
    printf 'new launcher' > "$DESTINATION/meshtalk"
    printf 'new backend' > "$DESTINATION/meshtalk-backend"
    printf 'new marker' > "$DESTINATION/.meshtalk-install.json"
    printf 'new selector' > "$DESTINATION/.meshtalk-current.json"
  else
    command rm "$@"
  fi
}
ASSUME_YES=1; uninstall_meshtalk`)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(f.destination, "meshtalk"), "utf8")).toBe("new launcher")
    expect(readFileSync(join(f.destination, "meshtalk-backend"), "utf8")).toBe("new backend")
    expect(readFileSync(join(f.destination, ".meshtalk-install.json"), "utf8")).toBe("new marker")
    expect(readFileSync(join(f.destination, ".meshtalk-current.json"), "utf8")).toBe("new selector")
    expect(readdirSync(f.root).filter(name => name.startsWith("meshtalk-uninstaller."))).toEqual([])
    expectUnknownPreserved(f)
  })
})

describe("PowerShell installer close-running contract", () => {
  test("declares and documents a separate explicit switch", () => {
    expect(powershellInstaller).toContain("[switch]$CloseRunning,")
    expect(powershellInstaller).toContain("$script:CloseRunningFlag = [bool]$CloseRunning")
    expect(powershellInstaller).toContain(".PARAMETER CloseRunning")
    expect(powershellInstaller).toContain("Not implied by -Yes; requires a supported helper")
    expect(powershellInstaller.match(/\$script:CloseRunningFlag\s*=/g)).toHaveLength(2)
    expect(powershellInstaller).toContain("MeshTalk is running. Close all instances and continue?")
    expect(powershellInstaller).toContain("$script:AssumeYes = $false")
  })

  test("forwards close-running only after permission in both helpers", () => {
    expect(powershellInstaller).toContain("$helperArgs = @('--install-from', $ExtractDir, '--install-dir', $script:InstallDirSel)")
    expect(powershellInstaller).toContain("$helperArgs = @('--uninstall-releases', '--install-dir', $script:InstallDirSel)")
    expect(powershellInstaller.match(/if \(\$script:CloseRunningFlag\) \{ \$helperArgs \+= '--close-running' \}/g)).toHaveLength(2)
    expect(powershellInstaller).toContain("& $launcher @helperArgs")
    expect(powershellInstaller).toContain("& $helper @helperArgs")
  })

  test("refuses the option before historical fallback or process-name checks", () => {
    const installBody = powershellInstaller.split("function Install-Extracted {")[1].split("function Install-MeshTalk {")[0]
    const uninstallBody = powershellInstaller.split("function Uninstall-MeshTalk {")[1].split("function Main {")[0]
    expect(installBody).toContain("throw '-CloseRunning requires a supported installation helper")
    expect(uninstallBody).toContain("throw '-CloseRunning requires a supported managed uninstall helper")
    expect(installBody.indexOf("if ($script:CloseRunningFlag) {\n        throw")).toBeLessThan(installBody.indexOf("Confirm-MeshTalkStopped"))
    expect(uninstallBody.indexOf("Uninstall-ManagedReleases")).toBeLessThan(uninstallBody.indexOf("Confirm-MeshTalkStopped"))
    expect(uninstallBody.indexOf("if ($script:CloseRunningFlag) {\n        throw")).toBeLessThan(uninstallBody.indexOf("Confirm-MeshTalkStopped"))
  })
})
