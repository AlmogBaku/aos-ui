import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App, RuntimeErrorBoundary } from "./app"

vi.mock("@/runtime-adapters/fixture/composition", () => ({
  FixtureAosUiApp: ({ locale }: { locale: string }) => (
    <div data-testid="fixture-app">{locale}</div>
  ),
}))
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

beforeEach(() => {
  document.cookie = "aos-ui-locale=en; Max-Age=31536000; Path=/"
  window.history.replaceState({}, "", "/agent-aster/thread-market")
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mode: "fixture" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("App", () => {
  it.each([
    undefined,
    { mode: "unknown" },
    { mode: "hermes", baseUrl: "/hermes", token: "not-public" },
  ])(
    "does not fall back to demo for invalid configuration %j",
    async (configuration) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify(configuration) ?? "", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      render(<App />)
      expect(await screen.findByRole("alert")).toBeVisible()
      expect(screen.queryByTestId("fixture-app")).not.toBeInTheDocument()
    }
  )

  it("loads public runtime configuration without changing a direct workspace URL", async () => {
    render(<App />)

    expect(await screen.findByTestId("fixture-app")).toHaveTextContent("en")
    expect(fetch).toHaveBeenCalledWith("/runtime-config.json", {
      cache: "no-store",
    })
    expect(window.location.pathname).toBe("/agent-aster/thread-market")
  })

  it("migrates a locale-prefixed deep link to the compact URL and preference", async () => {
    window.history.replaceState({}, "", "/he/agent-aster/thread-market")

    render(<App />)

    expect(await screen.findByTestId("fixture-app")).toHaveTextContent("he")
    expect(window.location.pathname).toBe("/agent-aster/thread-market")
    expect(document.cookie).toContain("aos-ui-locale=he")
  })
})

describe("RuntimeErrorBoundary", () => {
  it("shows a localized recovery action when a lazy runtime fails", () => {
    function BrokenRuntime(): never {
      throw new Error("chunk unavailable")
    }

    render(
      <RuntimeErrorBoundary locale="en">
        <BrokenRuntime />
      </RuntimeErrorBoundary>
    )

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The runtime could not be loaded"
    )
    expect(screen.getByRole("button", { name: "Reload" })).toBeVisible()
  })
})
