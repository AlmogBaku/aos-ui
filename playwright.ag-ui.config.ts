import { defineConfig, devices } from "@playwright/test"

const port = 3103
const providerPort = 4103

export default defineConfig({
  testDir: "./e2e",
  testMatch: /ag-ui\.runtime\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `bun run dev -- --hostname 127.0.0.1 --port ${port}`,
    env: {
      ...process.env,
      AOS_UI_E2E_DIST_DIR: ".next-e2e-ag-ui",
      AOS_UI_RUNTIME_MODE: "ag-ui",
      AOS_UI_AG_UI_URL: `http://127.0.0.1:${providerPort}/runs`,
      AOS_UI_AG_UI_WORKSPACE_URL: `http://127.0.0.1:${providerPort}`,
    },
    url: `http://127.0.0.1:${port}/en`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
