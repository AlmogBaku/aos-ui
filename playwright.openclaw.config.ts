import { defineConfig, devices } from "@playwright/test"

const port = 3105
const externalBaseURL = process.env.AOS_UI_E2E_BASE_URL?.replace(/\/$/, "")
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/openclaw",
  testMatch: /openclaw\.runtime\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: `AOS_UI_RUNTIME_MODE=openclaw bun run build && AOS_UI_RUNTIME_MODE=openclaw bun run preview -- --host 127.0.0.1 --port ${port}`,
        env: {
          ...process.env,
          AOS_UI_RUNTIME_MODE: "openclaw",
          AOS_UI_OPENCLAW_BASE_URL: "/openclaw",
          AOS_UI_E2E_CACHE_KEY: "openclaw-3105",
        },
        url: `http://127.0.0.1:${port}/en`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
})
