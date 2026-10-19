import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { releaseFiles, stageReleaseDirectory } from "../common/release-install"

let temporary: string
let first: string
let second: string
let tools: string
const suffix = process.platform === "win32" ? ".exe" : ""

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), "meshtalk-compiled-update-"))
  tools = join(temporary, "tools")
  mkdirSync(tools)
  // Keep a developer's windows and parallel test runs out of these isolated
  // installation fixtures. Process/lease lifetime is tested in the module suite.
  const inspector = join(temporary, "process-list.ts")
  writeFileSync(inspector, `
    if (process.env.MESHTALK_TEST_PROCESS_LIST === "empty") process.exit(0)
    if (process.env.MESHTALK_TEST_PROCESS_LIST === "invalid") { console.log("unparseable"); process.exit(0) }
    const pid = process.ppid
    if (process.platform === "win32") console.log('"meshtalk.exe","' + pid + '","Console","1","1 K"')
    else console.log(pid + " meshtalk")
  `)
  const inspectorBuild = Bun.spawn([process.execPath, "build", inspector, "--compile", "--outfile", join(tools, process.platform === "win32" ? "tasklist.exe" : "ps")], { stdout: "ignore", stderr: "pipe" })
  const inspectorErrors = await new Response(inspectorBuild.stderr).text()
  if (await inspectorBuild.exited !== 0) throw new Error(inspectorErrors)
  for (const version of ["1.0.0", "2.0.0"]) {
    const source = join(temporary, version)
    mkdirSync(source)
    const build = Bun.spawn([
      process.execPath, "build", join(import.meta.dir, "meshtalk.ts"), "--compile",
      "--define", `APP_VERSION=${JSON.stringify(version)}`,
      "--define", "MESHTALK_RELEASE=true", "--define", "MESHTALK_PRERELEASE=false",
      "--outfile", join(source, `meshtalk${suffix}`),
    ], { stdout: "ignore", stderr: "pipe" })
    const errors = await new Response(build.stderr).text()
    if (await build.exited !== 0) throw new Error(errors)
    writeFileSync(join(source, releaseFiles[1]), `backend ${version}`)
  }
  first = join(temporary, "1.0.0")
  second = join(temporary, "2.0.0")
}, 60000)

afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
})

async function run(executable: string, args: string[], name: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([executable, ...args], {
    env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ""}`, MESHTALK_DATA_DIR: join(temporary, `data-${name}`), MESHTALK_ANALYTICS: "off", ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  return { stdout: stdout.trim(), stderr, code }
}

test("compiled installer protocol bypasses normal component lookup", async () => {
  expect(await run(join(first, releaseFiles[0]), ["--install-protocol"], "protocol")).toEqual({ stdout: "1", stderr: "", code: 0 })
})

test.each(["empty", "invalid"])("installer refuses an %s process list before changing an installation", async (mode) => {
  const root = join(temporary, `unsafe-${mode}`)
  const result = await run(join(first, releaseFiles[0]), ["--install-from", first, "--install-dir", root], mode, { MESHTALK_TEST_PROCESS_LIST: mode })
  expect(result.code).not.toBe(0)
  expect(existsSync(root)).toBe(false)
})

test("compiled bootstrap forwards arguments and reports the selected version after reinstall", async () => {
  const root = join(temporary, "managed install with spaces")
  const executable = join(root, releaseFiles[0])
  expect((await run(join(first, releaseFiles[0]), ["--install-from", first, "--install-dir", root], "managed")).code).toBe(0)
  const bootstrap = readFileSync(executable)
  expect(await run(executable, ["--version"], "managed")).toEqual({ stdout: "1.0.0", stderr: "", code: 0 })
  expect((await run(join(second, releaseFiles[0]), ["--install-from", second, "--install-dir", root], "managed")).code).toBe(0)
  expect(readFileSync(executable)).toEqual(bootstrap)
  expect(await run(executable, ["--version"], "managed")).toEqual({ stdout: "2.0.0", stderr: "", code: 0 })
  const failed = await run(executable, ["--splash=invalid"], "managed")
  expect(failed.code).not.toBe(0)
  expect(failed.stderr).toContain("Usage:")
}, 60000)

test("flat binaries installed by an older updater migrate without replacing their launcher", async () => {
  const root = join(temporary, "legacy")
  mkdirSync(root)
  for (const file of releaseFiles) copyFileSync(join(first, file), join(root, file))
  const executable = join(root, releaseFiles[0])
  const bootstrap = readFileSync(executable)
  expect((await run(executable, ["--version"], "legacy")).stdout).toBe("1.0.0")
  stageReleaseDirectory(second, root, "2.0.0")
  expect(await run(executable, ["--version"], "legacy")).toEqual({ stdout: "2.0.0", stderr: "", code: 0 })
  expect(readFileSync(executable)).toEqual(bootstrap)
}, 60000)

test("a compiled flat installation with no backend never falls back to uv", async () => {
  const root = join(temporary, "missing backend")
  mkdirSync(root)
  const executable = join(root, releaseFiles[0])
  copyFileSync(join(first, releaseFiles[0]), executable)
  const result = await run(executable, ["peers"], "missing")
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("bundled MeshTalk backend is missing")
  expect(result.stderr).not.toContain("uv_spawn")
})

test("compiled uninstall preserves unrelated version directories and removes backup selection", async () => {
  const root = join(temporary, "uninstall")
  expect((await run(join(first, releaseFiles[0]), ["--install-from", first, "--install-dir", root], "uninstall")).code).toBe(0)
  const unrelated = join(root, "versions", "another-tool")
  mkdirSync(unrelated)
  writeFileSync(join(unrelated, "keep"), "not MeshTalk")
  const executable = join(root, releaseFiles[0])
  expect((await run(executable, ["--version"], "uninstall")).code).toBe(0)
  expect((await run(join(first, releaseFiles[0]), ["--uninstall-releases", "--install-dir", root], "uninstall")).code).toBe(0)
  expect(readFileSync(join(unrelated, "keep"), "utf8")).toBe("not MeshTalk")
  expect(existsSync(join(root, ".meshtalk-install.json"))).toBe(false)
  expect(existsSync(join(root, ".meshtalk-install.json.bak"))).toBe(false)
}, 60000)
