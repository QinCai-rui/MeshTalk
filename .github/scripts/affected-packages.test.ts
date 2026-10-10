import { describe, expect, test } from "bun:test"
import { affectedPackages, typescriptPackages } from "./affected-packages"
import { checkResults } from "./check-ci-results"

describe("affected packages", () => {
  test("desktop changes select UI and browser checks, but not native compilation", () => {
    expect(affectedPackages(["desktop/src/App.tsx"])).toEqual({ typescript: ["desktop"], containers: [], installers: false, backend: false, web: false, analytics: false, native: false, desktop_browser: true })
  })
  test("native and desktop build inputs also select native compilation", () => {
    for (const path of ["desktop/src-tauri/Cargo.lock", "desktop/src-tauri/src/lib.rs", "desktop/package.json", "desktop/scripts/version.py", "desktop/icon.svg"]) expect(affectedPackages([path]).native).toBe(true)
  })
  test("shared IPC changes reach its clients and launcher", () => {
    expect(affectedPackages(["common/ipc-client.ts"]).typescript).toEqual(["tui", "cli", "common", "launcher"])
  })
  test("client changes also reach the launcher", () => {
    expect(affectedPackages(["cli/src/index.ts"]).typescript).toEqual(["cli", "launcher"])
    expect(affectedPackages(["tui/src/App.tsx"]).typescript).toEqual(["tui", "launcher"])
  })
  test("root dependencies reach all workspace consumers", () => {
    for (const path of ["bun.lock", "package.json"]) {
      const result = affectedPackages([path])
      expect(result.typescript).toEqual([...typescriptPackages])
      expect(result.containers).toEqual(["client", "control"])
      expect(result.native).toBe(true)
      expect(result.web).toBe(false)
    }
  })
  test("container inputs select image builds without selecting unrelated checks", () => {
    expect(affectedPackages(["Dockerfile.client"]).containers).toEqual(["client"])
    expect(affectedPackages(["docker/entrypoint-client.sh"]).containers).toEqual(["client"])
    expect(affectedPackages(["Dockerfile.control"]).containers).toEqual(["control"])
    expect(affectedPackages([".dockerignore"]).containers).toEqual(["client", "control", "analytics"])
    expect(affectedPackages(["analytics/Dockerfile"]).containers).toEqual(["analytics"])
  })
  test("client, control, and backend source changes select their images", () => {
    expect(affectedPackages(["cli/src/index.ts"]).containers).toEqual(["client"])
    expect(affectedPackages(["control/src/index.ts"]).containers).toEqual(["control"])
    expect(affectedPackages(["backend/uv.lock"]).containers).toEqual(["client"])
  })
  test("root installer changes select installer syntax checks", () => {
    expect(affectedPackages(["scripts/install.sh"]).installers).toBe(true)
    expect(affectedPackages(["scripts/install.ps1"]).installers).toBe(true)
    expect(affectedPackages(["scripts/profile-rss.sh"]).installers).toBe(false)
  })
  test("independent packages do not select other jobs", () => {
    expect(affectedPackages(["backend/uv.lock"]).backend).toBe(true)
    expect(affectedPackages(["web/package-lock.json"]).web).toBe(true)
    expect(affectedPackages(["analytics/app.py"]).analytics).toBe(true)
    expect(affectedPackages(["control/src/worker.ts"]).typescript).toEqual(["control"])
    expect(affectedPackages(["bin/meshtalk.ts"]).typescript).toEqual(["launcher"])
  })
  test("CI changes and manual runs select everything", () => {
    for (const result of [affectedPackages([".github/workflows/pr-checks.yml"]), affectedPackages([".github/scripts/check-desktop-native.sh"]), affectedPackages([], true)]) {
      expect(result.typescript).toEqual([...typescriptPackages])
      expect(result.containers).toEqual(["client", "control", "analytics"])
      expect(result.installers).toBe(true)
      for (const key of ["backend", "web", "analytics", "native", "desktop_browser"] as const) expect(result[key]).toBe(true)
    }
  })
  test("docs-only changes skip package jobs", () => {
    expect(affectedPackages(["README.md", "docs/PROTOCOL.md", "AGENTS.md"]).typescript).toEqual([])
    expect(affectedPackages(["desktop-other/file.ts", "web-notes.md"]).desktop_browser).toBe(false)
  })
  test("renames across packages select both sides and results are deduplicated", () => {
    expect(affectedPackages(["cli/src/old.ts", "tui/src/new.ts", "common/a file.ts", "cli/src/old.ts"]).typescript).toEqual(["tui", "cli", "common", "launcher"])
  })
})

describe("aggregate CI result", () => {
  function jobs(all = false) {
    const selection = affectedPackages([], all)
    return {
      changes: { result: "success", outputs: Object.fromEntries(Object.entries(selection).map(([key, value]) => [key, JSON.stringify(value)])) },
      ...Object.fromEntries(["typescript", "containers", "installers", "backend", "web", "analytics", "native", "desktop_browser"].map(name => [name, { result: all ? "success" : "skipped" }])),
    }
  }
  test("passes when every selected job succeeds", () => { expect(() => checkResults(jobs(true))).not.toThrow() })
  test("passes skipped package jobs for docs-only changes", () => { expect(() => checkResults(jobs())).not.toThrow() })
  test("fails when a selected job is failed, cancelled, skipped, or missing", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const results = jobs(true)
      results.backend = { result }
      expect(() => checkResults(results)).toThrow()
    }
    const results = jobs(true)
    delete results.native
    expect(() => checkResults(results)).toThrow()
    const containerResults = jobs(true)
    containerResults.containers = { result: "failure" }
    expect(() => checkResults(containerResults)).toThrow()
    const installerResults = jobs(true)
    installerResults.installers = { result: "cancelled" }
    expect(() => checkResults(installerResults)).toThrow()
  })
  test("fails detection errors and malformed selections", () => {
    const results = jobs()
    results.changes.result = "failure"
    expect(() => checkResults(results)).toThrow()
    expect(() => checkResults({ changes: { result: "success", outputs: {} } })).toThrow()
  })
})
