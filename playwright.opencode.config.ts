import { defineConfig, devices } from "@playwright/test"

const port = 3101
const externalBaseURL = process.env.AOS_UI_E2E_BASE_URL?.replace(/\/$/, "")
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`

/**
 * Isolated browser contract for the production-default OpenCode composition.
 * The spec intercepts only the browser's OpenCode HTTP/SSE traffic, so this
 * server never reaches a provider or requires developer credentials.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/opencode",
  testMatch: /opencode\.runtime\.spec\.ts/,
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
        command: `AOS_UI_RUNTIME_MODE=opencode bun run build && AOS_UI_RUNTIME_MODE=opencode bun run preview -- --host 127.0.0.1 --port ${port}`,
        env: {
          ...process.env,
          // Deliberately omit AOS_UI_RUNTIME_MODE: OpenCode is the application
          // default and this test protects that composition path.
          AOS_UI_OPENCODE_BASE_URL: "http://127.0.0.1:4097",
          AOS_UI_OPENCODE_WORKTREE: "/workspace",
          AOS_UI_E2E_CACHE_KEY: "opencode-3101",
        },
        url: `http://127.0.0.1:${port}/en`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
})
