import { defineConfig, devices } from "@playwright/test"

const port = 3111
const providerPort = 4197

export default defineConfig({
  testDir: "./e2e",
  testMatch: /keyboard-question\.runtime\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: `bun run dev -- --hostname 127.0.0.1 --port ${port}`,
    env: {
      ...process.env,
      AOS_UI_E2E_DIST_DIR: ".next-e2e-keyboard-opencode",
      AOS_UI_OPENCODE_BASE_URL: `http://127.0.0.1:${providerPort}`,
    },
    url: `http://127.0.0.1:${port}/en`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
