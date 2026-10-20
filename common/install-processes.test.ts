import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeInstallationProcesses, installationProcessController, installationProcessPids, parseUnixInstallationProcesses, parseWindowsInstallationProcesses, type InstallationProcess, type InstallationProcessProvider } from "./install-processes"

function row(pid: number, executable = "/install/meshtalk", extra: Partial<InstallationProcess> = {}): InstallationProcess {
  return { pid, parentPid: 1, executable, identity: `start-${pid}`, sameUser: true, canClose: true, ...extra }
}

function fixture(initial: InstallationProcess[], platform: NodeJS.Platform = "linux") {
  let rows = [row(100, "/temporary/meshtalk"), ...initial]
  let clock = 0
  const closed: number[] = []
  const provider: InstallationProcessProvider = {
    platform,
    currentPid: 100,
    canonical: (path) => path,
    list: () => rows.map((value) => ({ ...value })),
    close: (target) => { closed.push(target.pid); rows = rows.filter((value) => value.pid !== target.pid) },
    now: () => clock,
    wait: async (ms) => { clock += ms },
  }
  return { provider, controller: installationProcessController(provider), closed, setRows: (next: InstallationProcess[]) => { rows = [row(100, "/temporary/meshtalk"), ...next] } }
}

describe("installation process closing", () => {
  test("background waits retry inspection failures and running snapshots without closing anything", async () => {
    const f = fixture([row(2)])
    const list = f.provider.list
    let calls = 0
    f.provider.list = () => {
      if (++calls === 1) throw new Error("process exited during inspection")
      if (calls === 3) f.setRows([])
      return list()
    }
    expect(await f.controller.waitUntilStopped("/install", [], 1000)).toBe(true)
    expect(calls).toBe(3)
    expect(f.closed).toEqual([])
  })

  test("persistent inspection failure reaches the background deadline without permission to update", async () => {
    const f = fixture([])
    let calls = 0
    f.provider.list = () => { calls++; throw new Error("inspection unavailable") }
    expect(await f.controller.waitUntilStopped("/install", [], 1000)).toBe(false)
    expect(calls).toBe(3)
    expect(f.closed).toEqual([])
    expect(() => f.controller.pids("/install")).toThrow("inspection unavailable")
    await expect(f.controller.close("/install")).rejects.toThrow("inspection unavailable")
  })

  test("closes every exact installation executable, not other names or installations", async () => {
    const f = fixture([
      row(2), row(3, "/install/versions/release/meshtalk-backend"),
      row(4, "/install-else/meshtalk"), row(5, "/other/meshtalk"),
      row(6, "/install/meshtalk-helper"), row(7, "/install/bash"),
    ])
    expect(f.controller.pids("/install")).toEqual([2, 3])
    await f.controller.close("/install")
    expect(f.closed).toEqual([2, 3])
  })

  test("explicit additional canonical roots include external release stores", async () => {
    const f = fixture([row(2, "/store/release/meshtalk-backend"), row(3, "/other/meshtalk")])
    await f.controller.close("/install", ["/store"])
    expect(f.closed).toEqual([2])
  })

  test("resolves installation aliases but does not follow an escaping executable symlink", async () => {
    const f = fixture([row(2, "/install/meshtalk"), row(3, "/physical/meshtalk-backend")])
    f.provider.canonical = (path) => path === "/alias" ? "/physical" : path === "/install/meshtalk" ? "/elsewhere/meshtalk" : path
    await f.controller.close("/alias")
    expect(f.closed).toEqual([3])
  })

  test("always excludes the current downloaded helper", async () => {
    const f = fixture([row(2)])
    await f.controller.close("/", [])
    expect(f.closed).toEqual([2])
  })

  test("a still-running installation ancestor aborts before any signal", async () => {
    const f = fixture([row(2), row(1)])
    await expect(f.controller.close("/install")).rejects.toThrow("launched this updater")
    expect(f.closed).toEqual([])
  })

  test("another user's target aborts before any signal", async () => {
    const f = fixture([row(2), row(3, "/install/meshtalk-backend", { sameUser: false })])
    await expect(f.controller.close("/install")).rejects.toThrow("another user")
    expect(f.closed).toEqual([])
  })

  test("another user's unrelated installation is left alone", async () => {
    const f = fixture([row(2), row(3, "/other/meshtalk", { sameUser: false })])
    await f.controller.close("/install")
    expect(f.closed).toEqual([2])
  })

  test("inaccessible relevant executable fails closed", async () => {
    const f = fixture([row(2), row(3)])
    f.provider.canonical = (path) => { if (path === "/install/meshtalk") throw new Error("EACCES"); return path }
    await expect(f.controller.close("/install")).rejects.toThrow("Cannot verify")
    expect(f.closed).toEqual([])
  })

  test("deleted executable cannot disappear from the safety check", async () => {
    const f = fixture([row(2, "/install/meshtalk (deleted)")])
    await expect(f.controller.close("/install")).rejects.toThrow("deleted executable")
    expect(f.closed).toEqual([])
  })

  test("PID reuse with a different executable never receives a signal", async () => {
    const f = fixture([row(2)])
    const original = f.provider.list
    let calls = 0
    f.provider.list = () => { if (++calls === 2) f.setRows([row(2, "/other/meshtalk", { identity: "reused" })]); return original() }
    await f.controller.close("/install")
    expect(f.closed).toEqual([])
  })

  test("PID reuse with the same executable is not signalled either", async () => {
    const f = fixture([row(2)])
    const original = f.provider.list
    let calls = 0
    f.provider.list = () => { if (++calls === 2) f.setRows([row(2, "/install/meshtalk", { identity: "reused" })]); return original() }
    await expect(f.controller.close("/install", [], 1)).rejects.toThrow("still running")
    expect(f.closed).toEqual([])
  })

  test("only requests graceful close once and reports timeout without escalation", async () => {
    const f = fixture([row(2)])
    f.provider.close = (target) => { f.closed.push(target.pid) }
    await expect(f.controller.close("/install", [], 250)).rejects.toThrow("no forced termination")
    expect(f.closed).toEqual([2])
  })

  test("waits for exit, not just successful signal delivery", async () => {
    const f = fixture([row(2)])
    f.provider.close = (target) => { f.closed.push(target.pid) }
    let waits = 0
    f.provider.wait = async () => { if (++waits === 3) f.setRows([]) }
    await f.controller.close("/install")
    expect(waits).toBe(3)
  })

  test("newly started installation processes prevent success", async () => {
    const f = fixture([row(2)])
    f.provider.close = (target) => { f.closed.push(target.pid); f.setRows([row(3)]) }
    await expect(f.controller.close("/install", [], 0)).rejects.toThrow("PID 3")
    expect(f.closed).toEqual([2])
  })

  test("malformed or incomplete list aborts before any signal", async () => {
    for (const list of [[], [row(2)], [row(100), row(2), row(2)]]) {
      const f = fixture([])
      f.provider.list = () => list
      await expect(f.controller.close("/install")).rejects.toThrow(/malformed|incomplete/)
      expect(f.closed).toEqual([])
    }
  })

  test("enumeration failure does not masquerade as no running processes", async () => {
    const f = fixture([row(2)])
    f.provider.list = () => { throw new Error("native enumeration failed") }
    await expect(f.controller.close("/install")).rejects.toThrow("native enumeration failed")
    expect(f.closed).toEqual([])
  })

  test("Windows console-only targets abort the whole preflight", async () => {
    const f = fixture([row(2), row(3, "/install/meshtalk-backend.exe", { canClose: false })], "win32")
    await expect(f.controller.close("/install")).rejects.toThrow("no graceful window-close support")
    expect(f.closed).toEqual([])
  })

  test("Windows GUI targets request close and wait", async () => {
    const f = fixture([row(2, "/INSTALL/MeshTalk.exe")], "win32")
    await f.controller.close("/install")
    expect(f.closed).toEqual([2])
  })
})

describe("native process output parsing", () => {
  test("parses Unix paths containing spaces without reading argv", () => {
    expect(parseUnixInstallationProcesses("  123 1 1000 /a path/meshtalk\n")).toEqual([{ pid: 123, parentPid: 1, uid: 1000, name: "/a path/meshtalk" }])
  })
  test("rejects malformed, truncated, empty and duplicate Unix rows", () => {
    for (const value of ["", "123 1", "123 1 user meshtalk", "123 1 2 meshtalk\nbad", "123 1 2 meshtalk\n123 1 2 meshtalk"]) {
      expect(() => parseUnixInstallationProcesses(value)).toThrow()
    }
  })
  test("requires complete structured Windows output", () => {
    expect(parseWindowsInstallationProcesses(JSON.stringify([row(2)]))).toEqual([row(2)])
    for (const value of ["", "[]", "{}", "null", '[{"pid":2}]', JSON.stringify([row(2), row(2)])]) {
      expect(() => parseWindowsInstallationProcesses(value)).toThrow()
    }
  })
})

const directories: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test.skipIf(process.platform !== "linux").each([
  { uid: "foreign", error: "EACCES", refused: false },
  { uid: "foreign", error: "EPERM", refused: false },
  { uid: "same", error: "EACCES", refused: true },
  { uid: "same", error: "EPERM", refused: true },
  { uid: "foreign", error: "EIO", refused: true },
  { uid: "foreign", error: "", refused: true },
])("native Linux inspection respects process ownership: %j", scenario => {
  const root = mkdtempSync(join(tmpdir(), "meshtalk-native-inspection-"))
  directories.push(root)
  writeFileSync(join(root, "meshtalk"), "fixture")
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test"
    import * as fs from "node:fs"
    import * as childProcess from "node:child_process"
    const read = fs.readFileSync, link = fs.readlinkSync, stat = fs.statSync
    const executable = ${JSON.stringify(join(root, "meshtalk"))}
    const uid = process.getuid()
    const foreignUid = ${JSON.stringify(scenario.uid)} === "foreign" ? uid + 1 : uid
    const ownPid = 214214213, foreignPid = 214214214
    let alive = true
    const closed = []
    const fields = Array(20).fill("0"); fields[0] = "S"; fields[19] = "100"
    mock.module("node:child_process", () => ({ ...childProcess, execFileSync: () =>
      process.pid + " 0 " + uid + " bun\\n" +
      (alive ? ownPid + " 0 " + uid + " meshtalk\\n" : "") +
      foreignPid + " 0 " + foreignUid + " meshtalk\\n"
    }))
    mock.module("node:fs", () => ({ ...fs,
      readFileSync: (path, ...args) => {
        if (path === "/proc/" + ownPid + "/stat" || path === "/proc/" + foreignPid + "/stat") return "1 (meshtalk) " + fields.join(" ")
        return read(path, ...args)
      },
      readlinkSync: (path, ...args) => {
        if (path === "/proc/" + foreignPid + "/exe" && ${JSON.stringify(scenario.error)}) throw Object.assign(new Error("fixture permission"), { code: ${JSON.stringify(scenario.error)} })
        if (path === "/proc/" + ownPid + "/exe" || path === "/proc/" + foreignPid + "/exe") return executable
        return link(path, ...args)
      },
      statSync: (path, ...args) => {
        if (path === "/proc/" + ownPid || path === "/proc/" + ownPid + "/exe") return { uid, dev: 1, ino: ownPid }
        if (path === "/proc/" + foreignPid || path === "/proc/" + foreignPid + "/exe") return { uid: foreignUid, dev: 1, ino: foreignPid }
        return stat(path, ...args)
      },
    }))
    process.kill = (pid, signal) => {
      if (pid !== ownPid || signal !== "SIGTERM") throw new Error("Unexpected signal target")
      closed.push(pid); alive = false; return true
    }
    const { installationProcessPids, closeInstallationProcesses } = await import(${JSON.stringify(new URL("./install-processes.ts", import.meta.url).href)})
    try {
      const pids = installationProcessPids(${JSON.stringify(root)})
      await closeInstallationProcesses(${JSON.stringify(root)})
      console.log(JSON.stringify({ pids, closed }))
    } catch (error) { console.log(JSON.stringify({ error: error.message, closed })) }
  `], { stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  const output = JSON.parse(result.stdout.toString())
  if (scenario.refused) {
    expect(output.error).toContain(scenario.error ? "Cannot verify" : "another user")
    expect(output.closed).toEqual([])
  } else {
    expect(output).toEqual({ pids: [214214213], closed: [214214213] })
  }
})

test("Windows inspection errors remain blocking and explain possible cross-user access", () => {
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test"
    import * as childProcess from "node:child_process"
    Object.defineProperty(process, "platform", { value: "win32" })
    mock.module("node:child_process", () => ({ ...childProcess, execFileSync: () => { throw new Error("inaccessible executable") } }))
    const { installationProcessPids } = await import(${JSON.stringify(new URL("./install-processes.ts", import.meta.url).href)})
    try { console.log(JSON.stringify({ pids: installationProcessPids("unused") })) }
    catch (error) { console.log(JSON.stringify({ error: error.message })) }
  `], { stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  const output = JSON.parse(result.stdout.toString())
  expect(output.pids).toBeUndefined()
  expect(output.error).toMatch(/another user's session/i)
  expect(output.error).toContain("The installation was not changed")
})

test.skipIf(process.platform !== "linux")("native executable verification closes only isolated fixture binaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshtalk-process-test-"))
  directories.push(directory)
  const root = join(directory, "install")
  const other = join(directory, "other")
  mkdirSync(root)
  mkdirSync(other)
  const source = join(directory, "fixture.c")
  writeFileSync(source, "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n")
  execFileSync("cc", [source, "-o", join(root, "meshtalk")])
  copyFileSync(join(root, "meshtalk"), join(root, "meshtalk-backend"))
  copyFileSync(join(root, "meshtalk"), join(other, "meshtalk"))
  const link = join(directory, "alias")
  symlinkSync(root, link, "dir")
  for (const executable of [join(root, "meshtalk"), join(root, "meshtalk-backend"), join(other, "meshtalk")]) {
    chmodSync(executable, 0o755)
    children.push(Bun.spawn([executable], { stdout: "ignore", stderr: "ignore" }))
  }
  const [launcher, backend, unrelated] = children
  expect(installationProcessPids(realpathSync(link)).sort((a, b) => a - b)).toEqual([launcher!.pid, backend!.pid].sort((a, b) => a - b))
  await closeInstallationProcesses(link)
  await Promise.all([launcher!.exited, backend!.exited])
  expect(unrelated!.exitCode).toBeNull()
  expect(installationProcessPids(root)).toEqual([])
}, 15000)
