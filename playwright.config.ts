import { defineConfig, devices } from "@playwright/test"

import { FIXTURE_MCP_APP_STABLE_DOMAIN } from "./shared/presentation/views"

const port = 3100
/** The same build again, with MCP App stable origins on, for their spec alone. */
const stablePort = Number(process.env.AOS_UI_E2E_STABLE_ORIGINS_PORT ?? 3917)
const externalBaseURL = process.env.AOS_UI_E2E_BASE_URL?.replace(/\/$/, "")
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`
const fixtureEnvironment = {
  ...process.env,
  AOS_UI_RUNTIME_MODE: "fixture",
  AOS_UI_E2E_CACHE_KEY: `fixture-${port}`,
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/fixture",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 2,
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
    {
      name: "aos-gateway-chromium",
      testMatch: /aos\.runtime\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "stable-origins-chromium",
      testMatch: /\.stable-origins\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        baseURL: externalBaseURL ?? `http://127.0.0.1:${stablePort}`,
      },
    },
  ],
  // Playwright starts the servers in order, each once the last answers, so
  // the second serves the first's build and `dist` is written once.
  webServer: externalBaseURL
    ? undefined
    : [
        {
          command: `bun run build && bun run preview -- --host 127.0.0.1 --port ${port}`,
          env: { ...fixtureEnvironment, VITE_AOS_UI_E2E: "1" },
          url: `http://127.0.0.1:${port}/en`,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: `bun run preview -- --host 127.0.0.1 --port ${stablePort}`,
          env: {
            ...fixtureEnvironment,
            AOS_UI_MCP_APP_STABLE_ORIGINS: `http://*.${FIXTURE_MCP_APP_STABLE_DOMAIN}:${stablePort}`,
          },
          url: `http://127.0.0.1:${stablePort}/en`,
          reuseExistingServer: false,
          timeout: 30_000,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
})
