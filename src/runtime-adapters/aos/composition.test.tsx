import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StrictMode } from "react"

import type { HarnessRuntime } from "../contracts"
import { AosReconciler } from "./aos-reconciliation"
import { runtimeAdapter } from "./composition"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("provider-neutral AOS runtime composition", () => {
  it("mounts the existing workspace runtime with normalized Agents and no provider URL", async () => {
    const close = vi.spyOn(AosReconciler.prototype, "close")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input)
        if (path === "/api/aos/v1/auth/operator")
          return Response.json({
            status: "authenticated",
            operator: { id: "principal" },
          })
        if (path === "/api/aos/v1/auth/runtime")
          return Response.json({ status: "authenticated" })
        if (path === "/api/aos/v1/runtime")
          return Response.json({
            runtime: { id: "hermes", name: "Hermes" },
            status: "ready",
            capabilities: {
              agentCatalog: { status: "available" },
              agentVisibility: {
                status: "available",
                concurrency: "revision",
              },
              sessionCatalog: {
                status: "available",
                scope: "workspace",
                order: "recent",
                defaultPageSize: 50,
                maxPageSize: 100,
                maxWindow: 1_000,
              },
              sessionHistory: {
                status: "available",
                order: "chronological",
                compacted: true,
                loading: "on-open",
                defaultPageSize: 200,
                maxPageSize: 500,
              },
              sessionDetail: { status: "available" },
              sessionCreation: { status: "available" },
              sessionTitle: { status: "available" },
              sessionArchival: { status: "available" },
              sessionDeletion: { status: "available" },
              sessionRun: { status: "available" },
              sessionStop: { status: "available" },
            },
          })
        if (path === "/api/aos/v1/sessions?limit=50&offset=0")
          return Response.json({
            sessions: [],
            total: 0,
            limit: 50,
            offset: 0,
          })
        if (path !== "/api/aos/v1/agents")
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
    const view = render(
      <StrictMode>
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
      </StrictMode>
    )

    expect(await screen.findByRole("main")).toHaveTextContent(
      "Workspace mounted"
    )
    expect(await supplied!.workspace.listAgents()).toMatchObject([
      { id: "researcher", name: "Researcher" },
    ])
    expect(supplied!.assistantRuntime.threads.getState().threadIds).toEqual([])
    expect(supplied!.activityCoverage).toBe("workspace")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(close).not.toHaveBeenCalled()

    view.unmount()
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  })
})
