import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string): MediaQueryList => ({
    media,
    matches: false,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }))
})

afterEach(() => {
  cleanup()
  vi.doUnmock("@/components/aos-ui-workspace")
  vi.doUnmock("@/runtime-adapters/fixture")
  vi.doUnmock("@/runtime-adapters/aos")
  vi.resetModules()
  vi.unstubAllGlobals()
})

it("starts the operator workspace import while the selected runtime import is pending", async () => {
  let releaseRuntime!: () => void
  const runtimeReady = new Promise<void>((resolve) => {
    releaseRuntime = resolve
  })
  const runtimeImporter = vi.fn(async () => {
    await runtimeReady
    return {
      runtimeAdapter: { mode: "fixture", Provider: () => null },
    }
  })
  const workspaceImporter = vi.fn(() => ({ AosUiWorkspace: () => null }))
  vi.doMock("@/runtime-adapters/fixture", runtimeImporter)
  vi.doMock("@/components/aos-ui-workspace", workspaceImporter)
  document.cookie = "aos-ui-locale=en; Path=/"
  window.history.replaceState({}, "", "/")
  vi.stubGlobal(
    "fetch",
    async () => new Response(JSON.stringify({ mode: "fixture" }))
  )

  try {
    const { App } = await import("./app")
    render(<App />)

    await waitFor(() => expect(runtimeImporter).toHaveBeenCalledOnce())
    await waitFor(() => expect(workspaceImporter).toHaveBeenCalledOnce())
    expect(screen.getByRole("status")).toHaveTextContent("Loading workspace…")
  } finally {
    cleanup()
    releaseRuntime()
    await act(() => vi.dynamicImportSettled())
  }
})

it.each([
  {
    name: "guest",
    configuration: {
      surface: "guest",
      basePath: "/api/guest/v1",
      lane: "guest",
    },
  },
  { name: "unavailable", configuration: { mode: "unsupported" } },
])(
  "does not import the operator workspace for $name configuration",
  async ({ name, configuration }) => {
    const workspaceImporter = vi.fn(() => ({ AosUiWorkspace: () => null }))
    const guestImporter = vi.fn(() => ({ GuestAosSurface: () => null }))
    vi.doMock("@/components/aos-ui-workspace", workspaceImporter)
    vi.doMock("@/runtime-adapters/aos", guestImporter)
    document.cookie = "aos-ui-locale=en; Path=/"
    window.history.replaceState({}, "", "/")
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify(configuration))
    )

    const { App } = await import("./app")
    render(<App />)

    if (name === "guest") {
      await waitFor(() => expect(guestImporter).toHaveBeenCalledOnce())
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The configured runtime is not supported"
      )
    }
    await act(() => vi.dynamicImportSettled())
    expect(workspaceImporter).not.toHaveBeenCalled()
  }
)

it.each([
  ["en", "The configured runtime is not supported"],
  ["he", "סביבת ההרצה שהוגדרה אינה נתמכת"],
])(
  "shows configuration errors in %s when workspace assets are unavailable",
  async (locale, title) => {
    vi.doMock("@/components/aos-ui-workspace", () => {
      throw new Error("Workspace chunk unavailable")
    })
    document.cookie = `aos-ui-locale=${locale}; Path=/`
    window.history.replaceState({}, "", "/")
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ mode: "unsupported" }))
    )

    const { App } = await import("./app")
    render(<App />)

    expect(await screen.findByRole("alert")).toHaveTextContent(title)
  }
)

it("shows workspace recovery when the selected workspace chunk fails", async () => {
  vi.doMock("@/components/aos-ui-workspace", () => {
    throw new Error("Workspace chunk unavailable")
  })
  document.cookie = "aos-ui-locale=en; Path=/"
  window.history.replaceState({}, "", "/")
  vi.stubGlobal(
    "fetch",
    async () => new Response(JSON.stringify({ mode: "fixture" }))
  )

  const { App } = await import("./app")
  render(<App />)

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The runtime could not be loaded"
  )
  expect(screen.getByRole("button", { name: "Reload" })).toBeVisible()
})
