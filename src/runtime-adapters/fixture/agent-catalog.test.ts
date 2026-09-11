import { describe, expect, it, vi } from "vitest"
import { createFixtureWorkspace } from "./fixture-workspace"
import { getWorkspaceCapabilities } from "../workspace-state"
import { isRosterAgent } from "../agent-identity"

describe("Agent catalog and visibility contract", () => {
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
})
