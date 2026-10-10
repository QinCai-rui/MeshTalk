import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

export const typescriptPackages = ["tui", "cli", "control", "desktop", "common", "launcher"] as const

export function affectedPackages(paths: string[], all = false) {
  const selected = new Set<string>()
  let backend = all
  let web = all
  let analytics = all
  let native = all
  const selectAll = () => {
    typescriptPackages.forEach(name => selected.add(name))
    backend = web = analytics = native = true
  }
  if (all) selectAll()
  for (const path of paths) {
    if (path === ".github/workflows/pr-checks.yml" || path.startsWith(".github/scripts/")) {
      selectAll()
    } else if (path === "package.json" || path === "bun.lock") {
      typescriptPackages.forEach(name => selected.add(name))
      native = true
    } else if (path.startsWith("common/")) {
      for (const name of ["common", "tui", "cli", "launcher"]) selected.add(name)
    } else if (path.startsWith("tui/") || path.startsWith("cli/")) {
      selected.add(path.split("/")[0])
      selected.add("launcher")
    } else if (path.startsWith("control/")) {
      selected.add("control")
    } else if (path.startsWith("desktop/")) {
      selected.add("desktop")
      if (path.startsWith("desktop/src-tauri/") || path.startsWith("desktop/scripts/") || path === "desktop/icon.svg" || path === "desktop/package.json") native = true
    } else if (path.startsWith("bin/")) {
      selected.add("launcher")
    } else if (path.startsWith("backend/")) {
      backend = true
    } else if (path.startsWith("web/")) {
      web = true
    } else if (path.startsWith("analytics/")) {
      analytics = true
    }
  }
  return { typescript: typescriptPackages.filter(name => selected.has(name)), backend, web, analytics, native, desktop_browser: selected.has("desktop") }
}

if (import.meta.main) {
  const all = process.env.CI_ALL === "true"
  const base = process.env.CI_BASE_SHA
  const head = process.env.CI_HEAD_SHA
  if (!all && (!base || !head)) throw new Error("PR base and head refs are required")
  const paths = all ? [] : execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], { encoding: "utf8" }).split("\0").filter(Boolean)
  const affected = affectedPackages(paths, all)
  const output = Object.entries(affected).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n"
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required")
  appendFileSync(process.env.GITHUB_OUTPUT, output)
  console.log(output.trim())
}
