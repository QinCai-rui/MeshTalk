type Job = { result: string; outputs?: Record<string, string> }

export function checkResults(jobs: Record<string, Job>) {
  if (jobs.changes?.result !== "success") throw new Error("Affected-package detection did not succeed")
  const outputs = jobs.changes.outputs ?? {}
  const targets = JSON.parse(outputs.typescript ?? "null")
  if (!Array.isArray(targets)) throw new Error("Missing TypeScript selection")
  const containers = JSON.parse(outputs.containers ?? "null")
  if (!Array.isArray(containers)) throw new Error("Missing container selection")
  const expected: Record<string, boolean> = { typescript: targets.length > 0, containers: containers.length > 0 }
  for (const [job, key] of Object.entries({ installers: "installers", backend: "backend", web: "web", analytics: "analytics", desktop_browser: "desktop_browser", native: "native" })) {
    if (outputs[key] !== "true" && outputs[key] !== "false") throw new Error(`Invalid selection for ${job}`)
    expected[job] = outputs[key] === "true"
  }
  for (const [name, required] of Object.entries(expected)) {
    const result = jobs[name]?.result
    if (result !== "success" && !(result === "skipped" && !required)) throw new Error(`${name}: ${result ?? "missing"}`)
  }
}

if (import.meta.main) {
  checkResults(JSON.parse(process.env.CI_JOB_RESULTS ?? "{}"))
  console.log("All selected PR checks passed")
}
