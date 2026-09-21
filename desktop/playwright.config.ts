import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:5187", viewport: { width: 1100, height: 760 } },
  webServer: { command: "bun run web --port 5187 --strictPort", url: "http://127.0.0.1:5187", reuseExistingServer: false },
})
