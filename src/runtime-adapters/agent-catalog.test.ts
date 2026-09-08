import { describe, expect, it, vi } from "vitest"
import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { createFixtureWorkspace } from "./fixture/fixture-workspace"
import { createOpenCodeWorkspace } from "./opencode/opencode-workspace"
import { createAgUiWorkspace } from "./ag-ui/ag-ui-workspace"
import { createAgUiHttpWorkspaceTransport } from "./ag-ui/ag-ui-http-transport"
import { getWorkspaceCapabilities } from "./workspace-state"
import { isRosterAgent } from "./agent-identity"

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
  it("keeps hidden fixture Agents out of the roster and can hide every ready Agent", async () => {
    const workspace = createFixtureWorkspace()
    const catalog = await workspace.listAgentCatalog()
    expect(
      catalog.some(
        (entry) => entry.visibility === "hidden" && !entry.selectable
      )
    ).toBe(true)
    const listener = vi.fn()
    workspace.subscribeAgentCatalog(listener)
    for (const entry of catalog)
      await workspace.updateAgentVisibility(entry.summary.id, "hidden")
    expect((await workspace.listAgents()).filter(isRosterAgent)).toEqual([])
    expect(listener).toHaveBeenCalled()
    await workspace.updateAgentVisibility(catalog[0].summary.id, "visible")
    expect((await workspace.listAgents()).filter(isRosterAgent)).toHaveLength(1)
    expect(getWorkspaceCapabilities(workspace)).toMatchObject({
      agentCatalog: true,
      agentVisibilityUpdates: true,
    })
  })

  it("excludes the dedicated creator from the management catalog", async () => {
    const workspace = createFixtureWorkspace()
    const creator = workspace.agentCreator!
    expect(await workspace.listAgentCatalog()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.objectContaining({ id: creator.id }),
        }),
      ])
    )
    await expect(
      workspace.updateAgentVisibility(creator.id, "hidden")
    ).rejects.toThrow()
  })

  it("filters OpenCode system definitions and keeps native management read-only", async () => {
    const base = { mode: "primary", native: false, permission: [], options: {} }
    const agents = [
      { ...base, name: "legacy", options: { aos_ui_name: "Legacy" } },
      {
        ...base,
        name: "hidden",
        hidden: true,
        options: { aos_ui_managed: true },
      },
      { ...base, name: "provider-owned" },
      { ...base, name: "native", native: true },
      { ...base, name: "agent-builder" },
      { ...base, name: "child", mode: "subagent" },
    ]
    const client = {
      app: { agents: vi.fn(async () => ({ data: agents })) },
      experimental: { session: { list: vi.fn(async () => ({ data: [] })) } },
    } as unknown as OpencodeClient
    const workspace = createOpenCodeWorkspace({
      client,
      events: { subscribe: () => () => undefined },
    })
    expect((await workspace.listAgents()).map((agent) => agent.id)).toEqual([
      "legacy",
      "hidden",
      "provider-owned",
      "agent-builder",
    ])
    expect(
      (await workspace.listAgentCatalog()).map((entry) => [
        entry.summary.id,
        entry.visibility,
        entry.editable,
      ])
    ).toEqual([
      ["legacy", "visible", false],
      ["hidden", "hidden", false],
      ["provider-owned", "visible", false],
      ["agent-builder", "visible", false],
    ])
    const readonly = createOpenCodeWorkspace({
      client,
      events: { subscribe: () => () => undefined },
    })
    expect(
      (await readonly.listAgentCatalog()).every((entry) => !entry.editable)
    ).toBe(true)
    expect(readonly).not.toHaveProperty("updateAgentVisibility")
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
