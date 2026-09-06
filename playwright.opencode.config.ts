import { defineConfig, devices } from "@playwright/test"

const port = 3101

/**
 * Isolated browser contract for the production-default OpenCode composition.
 * The spec intercepts only the browser's OpenCode HTTP/SSE traffic, so this
 * server never reaches a provider or requires developer credentials.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /opencode\.runtime\.spec\.ts/,
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
      // Deliberately omit AOS_UI_RUNTIME_MODE: OpenCode is the application
      // default and this test protects that composition path.
      AOS_UI_E2E_DIST_DIR: ".next-e2e-opencode",
      AOS_UI_OPENCODE_BASE_URL: "http://127.0.0.1:4097",
    },
    url: `http://127.0.0.1:${port}/en`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
