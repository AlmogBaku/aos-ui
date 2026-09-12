import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { HarnessRuntime } from "../contracts"
import { runtimeAdapter } from "./composition"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("provider-neutral AOS runtime composition", () => {
  it("mounts the existing workspace runtime with normalized Agents and no provider URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) !== "/api/aos/v1/agents")
          throw new Error(`Unexpected request: ${String(input)}`)
        return Response.json({
          revision: "profiles:researcher@hermes-bots:7",
          agents: [
            {
              summary: {
                kind: "ready",
                id: "researcher",
                name: "Researcher",
                activity: "unknown",
                visibility: "visible",
              },
              visibility: "visible",
              selectable: true,
              editable: true,
              revision: "hermes-bots:7",
            },
          ],
        })
      })
    )
    let supplied: HarnessRuntime | undefined
    const Provider = runtimeAdapter.Provider
    render(
      <Provider
        config={{
          status: "ready",
          mode: "aos",
          composerFeatures: {
            modelSelectorEnabled: true,
            contextEnabled: true,
          },
        }}
        locale="en"
      >
        {(runtime) => {
          supplied = runtime
          return <main>Workspace mounted</main>
        }}
      </Provider>
    )

    expect(screen.getByRole("main")).toHaveTextContent("Workspace mounted")
    expect(await supplied!.workspace.listAgents()).toMatchObject([
      { id: "researcher", name: "Researcher" },
    ])
    expect(supplied!.assistantRuntime.threads.getState().threadIds).toEqual([])
    expect(supplied!.activityCoverage).toBe("workspace")
  })
})
