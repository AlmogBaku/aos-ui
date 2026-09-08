import { defineConfig, devices } from "@playwright/test"

const port = 3100
const externalBaseURL = process.env.AOS_UI_E2E_BASE_URL?.replace(/\/$/, "")
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/fixture",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    timeout: 7_000,
  },
  use: {
    baseURL,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      testMatch: /desktop\.workspace\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "keyboard-first-chromium",
      testMatch: /keyboard-first\.workspace\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      testMatch: /mobile\.workspace\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
      },
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: `bun run build && bun run preview -- --host 127.0.0.1 --port ${port}`,
        env: {
          ...process.env,
          AOS_UI_RUNTIME_MODE: "fixture",
          AOS_UI_E2E_CACHE_KEY: "fixture-3100",
          VITE_AOS_UI_E2E: "1",
        },
        url: `http://127.0.0.1:${port}/en`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
})
