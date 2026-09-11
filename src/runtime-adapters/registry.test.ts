import { createElement, Suspense } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, expectTypeOf, it, vi } from "vitest"
import type { ComponentProps } from "react"
import type { HarnessRuntime } from "./contracts"
import { getRuntimeAdapter, HarnessRuntimeProvider } from "./registry"
import { runtimeAdapter as agUiAdapter } from "./ag-ui"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("does not load a default provider for an unknown mode", () => {
  expect(getRuntimeAdapter("unconfigured")).toBeUndefined()
  expect(getRuntimeAdapter("toString")).toBeUndefined()
  expect(getRuntimeAdapter(undefined)).toBeUndefined()
})

it("resolves every configured provider to its own adapter", () => {
  for (const mode of ["fixture", "opencode", "hermes", "ag-ui", "openclaw"]) {
    expect(getRuntimeAdapter(mode)?.mode).toBe(mode)
  }
})

it.each([
  ["fixture", () => import("./fixture")],
  ["opencode", () => import("./opencode")],
  ["hermes", () => import("./hermes")],
  ["ag-ui", () => import("./ag-ui")],
  ["openclaw", () => import("./openclaw")],
] as const)(
  "exposes only the unified runtime adapter from the %s package",
  async (mode, load) => {
    const entrypoint = await load()
    expect(Object.keys(entrypoint)).toEqual(["runtimeAdapter"])
    expect(entrypoint.runtimeAdapter.mode).toBe(mode)
    expect(entrypoint.runtimeAdapter.Provider).toBeTypeOf("function")
  }
)

it("preserves the selected mode in the public Provider configuration type", () => {
  const adapter = getRuntimeAdapter("fixture")!
  expect(adapter.mode).toBe("fixture")
  type Config = ComponentProps<typeof adapter.Provider>["config"]
  expectTypeOf<Config["mode"]>().toEqualTypeOf<"fixture">()
})

it("loads the fixture provider through the public render-prop seam with independently disabled composer features", async () => {
  let runtime: HarnessRuntime | undefined
  render(
    createElement(
      Suspense,
      { fallback: "Loading" },
      createElement(HarnessRuntimeProvider, {
        locale: "en",
        config: {
          status: "ready",
          mode: "fixture",
          composerFeatures: {
            modelSelectorEnabled: false,
            contextEnabled: true,
          },
        },
        children: (value) => {
          runtime = value
          return createElement("p", null, value.environmentLabel)
        },
      })
    )
  )
  expect(await screen.findByText("Demo workspace")).toBeVisible()
  expect(runtime!.composer?.model).toBeUndefined()
  expect(runtime!.composer?.context?.usage.total).toBeGreaterThan(0)
  const agents = await runtime!.workspace.listAgents()
  expect(agents.length).toBeGreaterThan(0)
  expect(agents.some((agent) => agent.role === "creator")).toBe(false)
  expect(runtime!.activityCoverage).toBe("workspace")
})

it("loads AG-UI through the same provider seam while preserving its native catalog and unsupported capabilities", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === "https://gateway.example/workspace/agents") {
      return Response.json([{ id: "native-agent", name: "Native Agent" }])
    }
    if (url === "https://gateway.example/workspace/sessions")
      return Response.json([])
    throw new Error(`Unexpected provider request: ${url}`)
  })
  const adapter = agUiAdapter
  let runtime: HarnessRuntime | undefined
  render(
    createElement(
      Suspense,
      { fallback: "Loading" },
      createElement(adapter.Provider, {
        locale: "he",
        config: {
          status: "ready",
          mode: "ag-ui",
          runUrl: "https://gateway.example/run",
          workspaceUrl: "https://gateway.example/workspace",
          composerFeatures: {
            modelSelectorEnabled: true,
            contextEnabled: true,
          },
        },
        children: (value) => {
          runtime = value
          return createElement("p", null, "Connected")
        },
      })
    )
  )
  expect(await screen.findByText("Connected")).toBeVisible()
  expect(await runtime!.workspace.listAgents()).toMatchObject([
    { id: "native-agent", name: "Native Agent" },
  ])
  expect(runtime!.composer).toBeUndefined()
  expect(runtime!.interactions).toBeUndefined()
  expect(runtime!.media).toBeUndefined()
  expect(runtime!.activityCoverage).toBe("active-session")
})
