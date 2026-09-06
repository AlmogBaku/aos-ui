import { describe, expect, it, vi } from "vitest"
import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { createFixtureWorkspace } from "./fixture/fixture-workspace"
import { createOpenCodeWorkspace } from "./opencode/opencode-workspace"
import { createAgUiWorkspace } from "./ag-ui/ag-ui-workspace"
import { createAgUiHttpWorkspaceTransport } from "./ag-ui/ag-ui-http-transport"
import { getWorkspaceCapabilities } from "./workspace-state"
import { OpenCodeSessionOwnership } from "./opencode/opencode-session-ownership"

describe("Agent catalog and visibility contract", () => {
  it.each(["provider-active", "pending-reload"])(
    "preserves the typed %s visibility failure through the OpenCode adapter",
    async (code) => {
      const client = {
        app: {
          agents: async () => ({
            data: [
              {
                name: "managed",
                mode: "primary",
                options: { aos_ui_managed: true },
              },
            ],
          }),
        },
      } as unknown as OpencodeClient
      const workspace = createOpenCodeWorkspace({
        client,
        events: { subscribe: () => () => undefined },
        managementUrl: "http://manager.test",
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json(
              { code, message: "Arbitrary provider wording" },
              { status: 409 }
            )
          ),
      })
      await expect(
        workspace.updateAgentVisibility!("managed", "hidden")
      ).rejects.toMatchObject({ code })
    }
  )

  it("requires OpenCode readback after a management response and publishes failures", async () => {
    let hidden = false
    const agents = vi.fn(async () => ({
      data: [
        {
          name: "managed",
          mode: "primary",
          hidden,
          native: false,
          options: { aos_ui_managed: true },
          permission: [],
        },
      ],
    }))
    const client = { app: { agents } } as unknown as OpencodeClient
    const ownership = new OpenCodeSessionOwnership()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      expect(() => ownership.assertSendAvailable()).toThrow("reloading")
      hidden = true
      return Response.json({ agentId: "managed", visibility: "hidden" })
    })
    const workspace = createOpenCodeWorkspace({
      client,
      ownership,
      events: { subscribe: () => () => undefined },
      managementUrl: "http://manager.test",
      fetcher,
    })
    const listener = vi.fn()
    workspace.subscribeAgentCatalog(listener)
    await workspace.updateAgentVisibility!("managed", "hidden")
    expect(fetcher).toHaveBeenCalledWith(
      "http://manager.test/agents/managed/visibility",
      expect.objectContaining({
        body: JSON.stringify({
          visibility: "hidden",
          expectedVisibility: "visible",
        }),
      })
    )
    expect(listener).toHaveBeenCalledOnce()
    expect(() => ownership.assertSendAvailable()).not.toThrow()
    fetcher.mockResolvedValue(Response.json({}))
    await expect(
      workspace.updateAgentVisibility!("managed", "visible")
    ).rejects.toThrow("did not confirm")
    expect(listener).toHaveBeenCalledTimes(2)
    await expect(
      workspace.updateAgentVisibility!("missing", "hidden")
    ).rejects.toThrow("managed by its provider")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

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
    expect(await workspace.listAgents()).toEqual([])
    expect(listener).toHaveBeenCalled()
    await workspace.updateAgentVisibility(catalog[0].summary.id, "visible")
    expect(await workspace.listAgents()).toHaveLength(1)
    expect(getWorkspaceCapabilities(workspace)).toMatchObject({
      agentCatalog: true,
      agentVisibilityUpdates: true,
    })
  })

  it("excludes Builder drafts from the management catalog", async () => {
    const workspace = createFixtureWorkspace()
    const draft = await workspace.openAgentBuilder()
    expect(await workspace.listAgentCatalog()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.objectContaining({ id: draft.draftAgentId }),
        }),
      ])
    )
    await expect(
      workspace.updateAgentVisibility(draft.draftAgentId, "hidden")
    ).rejects.toThrow()
  })

  it("filters OpenCode system definitions and gates editing on managed metadata and management URL", async () => {
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
      managementUrl: "http://localhost:4097",
    })
    expect((await workspace.listAgents()).map((agent) => agent.id)).toEqual([
      "legacy",
      "provider-owned",
    ])
    expect(
      (await workspace.listAgentCatalog()).map((entry) => [
        entry.summary.id,
        entry.visibility,
        entry.editable,
      ])
    ).toEqual([
      ["legacy", "visible", true],
      ["hidden", "hidden", true],
      ["provider-owned", "visible", false],
    ])
    const readonly = createOpenCodeWorkspace({
      client,
      events: { subscribe: () => () => undefined },
    })
    expect(
      (await readonly.listAgentCatalog()).every((entry) => !entry.editable)
    ).toBe(true)
    expect(readonly.updateAgentVisibility).toBeUndefined()
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
