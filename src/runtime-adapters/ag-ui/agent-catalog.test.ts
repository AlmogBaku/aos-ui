import { describe, expect, it, vi } from "vitest"
import { createAgUiWorkspace } from "./ag-ui-workspace"
import { createAgUiHttpWorkspaceTransport } from "./ag-ui-http-transport"

describe("Agent catalog and visibility contract", () => {
  it("gates AG-UI updates on explicit transport support and provider editability", async () => {
    let hidden = true
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        if (init?.method === "PATCH") {
          hidden = false
          return new Response(null, { status: 204 })
        }
        return Response.json([
          {
            id: "managed",
            name: "Managed",
            visibility: hidden ? "hidden" : "visible",
            editable: true,
          },
          { id: "owned", name: "Provider" },
        ])
      })
    const workspace = createAgUiWorkspace({
      transport: createAgUiHttpWorkspaceTransport({
        baseUrl: "http://ag.test",
        fetcher,
        supportsVisibilityUpdates: true,
      }),
    })
    await workspace.updateAgentVisibility!("managed", "visible")
    expect((await workspace.listAgents()).map((agent) => agent.id)).toEqual([
      "managed",
      "owned",
    ])
    await expect(
      workspace.updateAgentVisibility!("owned", "hidden")
    ).rejects.toThrow("managed by its provider")
  })

  it("keeps legacy AG-UI hosts read-only and accepts optional visibility metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json([
        { id: "visible", name: "Visible" },
        { id: "hidden", name: "Hidden", visibility: "hidden", editable: true },
      ])
    )
    const transport = createAgUiHttpWorkspaceTransport({
      baseUrl: "https://provider.test",
      fetcher,
    })
    const workspace = createAgUiWorkspace({ transport })
    expect((await workspace.listAgents()).map((agent) => agent.id)).toEqual([
      "visible",
      "hidden",
    ])
    expect(
      (await workspace.listAgentCatalog()).map((entry) => [
        entry.visibility,
        entry.editable,
      ])
    ).toEqual([
      ["visible", false],
      ["hidden", false],
    ])
    expect(workspace.updateAgentVisibility).toBeUndefined()
  })
})
