import { defineConfig, devices } from "@playwright/test"

const port = 3111
const providerPort = 4197
const externalBaseURL = process.env.AOS_UI_E2E_BASE_URL?.replace(/\/$/, "")
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/keyboard-opencode",
  testMatch: /keyboard-question\.runtime\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: `bun run dev -- --host 127.0.0.1 --port ${port}`,
        env: {
          ...process.env,
          AOS_UI_OPENCODE_BASE_URL: `http://127.0.0.1:${providerPort}`,
          AOS_UI_OPENCODE_WORKTREE: "/workspace",
          AOS_UI_E2E_CACHE_KEY: "keyboard-opencode-3111",
        },
        url: `http://127.0.0.1:${port}/en`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
})
