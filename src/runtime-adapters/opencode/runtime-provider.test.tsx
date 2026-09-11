import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenCodeThreadState } from "@assistant-ui/react-opencode"
import type { HarnessRuntime } from "../contracts"
import { aosOpenCodeExtras } from "./opencode-runtime-extras"
import { runtimeAdapter } from "./composition"

const mocks = vi.hoisted(() => ({ bundle: undefined as unknown }))
vi.mock("./use-opencode-runtime-bundle", () => ({
  useOpenCodeRuntimeBundle: () => mocks.bundle,
}))
afterEach(cleanup)

describe("OpenCode runtime provider", () => {
  it("exposes selected model, interactions and artifacts through the runtime and retains model failure UI", async () => {
    const state = createOpenCodeThreadState("one")
    const refresh = vi.fn()
    const extras = aosOpenCodeExtras.provide({
      state: {
        ...state,
        session: { id: "one", model: { providerID: "provider", id: "model" } },
      },
      session: { id: "one" },
      questions: {},
      refresh,
    } as unknown as Parameters<typeof aosOpenCodeExtras.provide>[0])
    const interactions = {
      getPending: () => undefined,
      subscribe: () => () => {},
      respond: vi.fn(),
      reject: vi.fn(),
    }
    const artifacts = { resolve: vi.fn() }
    const client = {
      provider: {
        list: vi.fn(async () => ({
          data: {
            connected: ["provider"],
            all: [
              {
                id: "provider",
                name: "Provider",
                models: {
                  model: {
                    id: "model",
                    providerID: "provider",
                    name: "Model",
                    limit: { context: 100000 },
                  },
                },
              },
            ],
          },
        })),
      },
      v2: {
        session: {
          switchModel: vi.fn(async () => {
            throw new Error("Model unavailable")
          }),
        },
      },
    }
    mocks.bundle = {
      assistantRuntime: {
        thread: { subscribe: () => () => {}, getState: () => ({ extras }) },
      },
      workspace: {},
      client,
      interactions,
      artifacts,
    }
    let runtime: HarnessRuntime | undefined
    const Provider = runtimeAdapter.Provider
    render(
      <Provider
        locale="en"
        config={{
          status: "ready",
          mode: "opencode",
          baseUrl: "/opencode",
          directory: "/external",
          composerFeatures: {
            modelSelectorEnabled: true,
            contextEnabled: true,
          },
          artifactHtmlAssetOrigins: ["https://assets.example"],
        }}
      >
        {(value) => {
          runtime = value
          return <main>Workspace</main>
        }}
      </Provider>
    )
    await waitFor(() =>
      expect(runtime?.composer?.model?.options).toEqual([
        { id: '["provider","model"]', label: "Model", group: "Provider" },
      ])
    )
    expect(runtime?.interactions).toBe(interactions)
    expect(runtime?.artifacts).toEqual({
      resolver: artifacts,
      htmlAssetOrigins: ["https://assets.example"],
    })
    expect(runtime?.activityCoverage).toBe("workspace")
    await act(async () =>
      runtime?.composer?.model?.select('["provider","model"]')
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Model change failed")
    expect(screen.getByRole("main")).toBeVisible()
  })
})
