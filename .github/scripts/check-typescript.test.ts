import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const directories: string[] = []
const script = fileURLToPath(new URL("./check-typescript.sh", import.meta.url))

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test.each(["runner", "system", "default", "failed build"])("launcher check uses and cleans a unique temporary directory: %s", mode => {
  const root = mkdtempSync(join(tmpdir(), "meshtalk-check-script-"))
  directories.push(root)
  const tools = join(root, "bin")
  const runner = join(root, "runner")
  const temporary = join(root, "temporary")
  for (const directory of [tools, runner, temporary]) mkdirSync(directory)
  const output = join(root, "output-directory")
  writeFileSync(join(tools, "bun"), `#!/usr/bin/env bash
set -eu
while [[ $# -gt 0 ]]; do
  if [[ $1 == --outdir ]]; then
    printf '%s' "$2" > "$OUTPUT_RECORD"
    printf 'fixture' > "$2/output.js"
    exit "$BUILD_EXIT"
  fi
  shift
done
exit 8
`, { mode: 0o755 })
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH ?? ""}`,
    RUNNER_TEMP: mode === "runner" ? runner : undefined,
    TMPDIR: mode === "default" ? undefined : temporary,
    OUTPUT_RECORD: output,
    BUILD_EXIT: mode === "failed build" ? "7" : "0",
  }
  const result = Bun.spawnSync(["bash", script, "launcher"], { env })
  expect(result.exitCode).toBe(mode === "failed build" ? 7 : 0)
  const directory = readFileSync(output, "utf8")
  expect(dirname(directory)).toBe(mode === "runner" ? runner : mode === "default" ? "/tmp" : temporary)
  expect(directory).toMatch(/meshtalk-launcher-check\.[A-Za-z0-9]+$/)
  expect(existsSync(directory)).toBe(false)
})
