import { defineConfig, devices } from "@playwright/test"

const port = 3104
const externalBaseURL = process.env.AOS_UI_E2E_BASE_URL?.replace(/\/$/, "")
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/hermes",
  testMatch: /hermes\.runtime\.spec\.ts/,
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
        command: `AOS_UI_RUNTIME_MODE=hermes bun run build && AOS_UI_RUNTIME_MODE=hermes bun run preview -- --host 127.0.0.1 --port ${port}`,
        env: {
          ...process.env,
          AOS_UI_RUNTIME_MODE: "hermes",
          AOS_UI_E2E_CACHE_KEY: "hermes-3104",
          AOS_UI_HERMES_BASE_URL: "/hermes",
        },
        url: `http://127.0.0.1:${port}/en`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
})
