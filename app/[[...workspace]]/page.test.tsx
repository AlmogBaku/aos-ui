import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { connection, headers } = vi.hoisted(() => ({
  connection: vi.fn(),
  headers: vi.fn(async () => new Headers({ "x-aos-ui-locale": "en" })),
}))

vi.mock("next/server", () => ({ connection }))
vi.mock("next/headers", () => ({ headers }))
vi.mock("@/lib/i18n/get-dictionary", () => ({
  getDictionary: vi.fn(async () => ({ productName: "AOS" })),
}))
vi.mock("@/components/aos-ui-fixture-app", () => ({
  FixtureAosUiApp: () => <div>fixture runtime</div>,
}))
vi.mock("@/components/aos-ui-opencode-app", () => ({
  OpenCodeAosUiApp: ({ baseUrl }: { baseUrl: string }) => (
    <div>opencode runtime: {baseUrl}</div>
  ),
}))
vi.mock("@/components/aos-ui-ag-ui-app", () => ({
  AgUiAosUiApp: ({ runUrl }: { runUrl: string }) => (
    <div>AG-UI runtime: {runUrl}</div>
  ),
}))

import WorkspacePage from "./page"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

async function renderPage(workspace?: string[]) {
  render(await WorkspacePage({ params: Promise.resolve({ workspace }) }))
}

describe("WorkspacePage runtime composition", () => {
  it("renders the root workspace route using the request locale", async () => {
    vi.stubEnv("AOS_UI_RUNTIME_MODE", "fixture")
    await renderPage()

    expect(screen.getByText("fixture runtime")).toBeInTheDocument()
    expect(connection).toHaveBeenCalledTimes(1)
  })

  it("renders an agent and session deep link without server-side data loading", async () => {
    await renderPage(["agent-aster", "session-1"])

    expect(screen.getByText(/opencode runtime:/)).toBeInTheDocument()
  })
})
