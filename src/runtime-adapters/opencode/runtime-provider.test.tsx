import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenCodeThreadState } from "@assistant-ui/react-opencode"
import type { HarnessRuntime } from "../contracts"
import { aosOpenCodeExtras } from "./opencode-runtime-extras"
import { runtimeAdapter } from "./composition"

const mocks = vi.hoisted(() => ({
  bundle: undefined as unknown,
  onInteractionError: undefined as
    ((error: Error | undefined, threadId: string) => void) | undefined,
}))
vi.mock("./use-opencode-runtime-bundle", () => ({
  useOpenCodeRuntimeBundle: (options: {
    onInteractionError?: typeof mocks.onInteractionError
  }) => {
    mocks.onInteractionError = options.onInteractionError
    return mocks.bundle
  },
}))
afterEach(cleanup)

async function showProvider() {
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
    retry: vi.fn(),
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
  return {
    runtime: () => runtime,
    interactions,
    artifacts,
    failModel: async () =>
      act(async () => runtime?.composer?.model?.select('["provider","model"]')),
    failQuestions: () =>
      act(() =>
        mocks.onInteractionError?.(new Error("Questions unavailable"), "one")
      ),
    recoverQuestions: () =>
      act(() => mocks.onInteractionError?.(undefined, "one")),
  }
}

describe("OpenCode runtime provider", () => {
  it.each(["model-first", "questions-first"])(
    "keeps model and question failures independently actionable (%s)",
    async (order) => {
      const provider = await showProvider()
      if (order === "model-first") {
        await provider.failModel()
        provider.failQuestions()
      } else {
        provider.failQuestions()
        await provider.failModel()
      }
      const modelAlert = () =>
        screen
          .getAllByRole("alert")
          .find((alert) => alert.textContent?.includes("Model change failed"))!
      const questionAlert = () =>
        screen
          .getAllByRole("alert")
          .find((alert) =>
            alert.textContent?.includes(
              "Pending OpenCode questions could not be loaded."
            )
          )!
      expect(screen.getAllByRole("alert")).toHaveLength(2)
      expect(
        within(questionAlert()).getByRole("button", { name: "Try again" })
      ).toBeVisible()

      fireEvent.click(
        within(modelAlert()).getByRole("button", {
          name: "Dismiss notification",
        })
      )
      expect(screen.getAllByRole("alert")).toHaveLength(1)
      expect(questionAlert()).toBeVisible()

      await provider.failModel()
      fireEvent.click(
        within(questionAlert()).getByRole("button", { name: "Try again" })
      )
      expect(provider.interactions.retry).toHaveBeenCalledWith("one")
      expect(screen.getAllByRole("alert")).toHaveLength(1)
      expect(modelAlert()).toBeVisible()

      provider.failQuestions()
      fireEvent.click(
        within(questionAlert()).getByRole("button", {
          name: "Dismiss notification",
        })
      )
      expect(screen.getAllByRole("alert")).toHaveLength(1)
      expect(modelAlert()).toBeVisible()

      provider.failQuestions()
      provider.recoverQuestions()
      expect(screen.getAllByRole("alert")).toHaveLength(1)
      expect(modelAlert()).toBeVisible()
    }
  )

  it("exposes selected model, interactions and artifacts through the runtime and retains model failure UI", async () => {
    const provider = await showProvider()
    const runtime = provider.runtime()
    const { interactions, artifacts } = provider
    expect(runtime?.interactions).toBe(interactions)
    expect(runtime?.artifacts).toEqual({
      resolver: artifacts,
      htmlAssetOrigins: ["https://assets.example"],
    })
    expect(runtime?.activityCoverage).toBe("workspace")
    await provider.failModel()
    expect(screen.getByRole("alert")).toHaveTextContent("Model change failed")
    expect(screen.getByRole("main")).toBeVisible()
  })
})
