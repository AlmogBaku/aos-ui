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

  it("seeds distinct avatars on visible Agents only", async () => {
    const workspace = createFixtureWorkspace()
    const catalog = await workspace.listAgentCatalog()
    const visible = catalog.filter((entry) => entry.visibility === "visible")
    const avatars = visible.map((entry) => entry.summary.avatar)
    expect(avatars.every((avatar) => avatar !== undefined)).toBe(true)
    expect(new Set(avatars).size).toBe(avatars.length)
    expect(
      catalog
        .filter((entry) => entry.visibility === "hidden")
        .map((entry) => entry.summary.avatar)
    ).toEqual([undefined])
    expect(workspace.agentCreator?.avatar).toBeUndefined()
    expect(catalog.every((entry) => entry.avatarEditable)).toBe(true)
  })

  it("stores an avatar change and clears one, telling catalog subscribers", async () => {
    const workspace = createFixtureWorkspace()
    const [first] = await workspace.listAgentCatalog()
    const listener = vi.fn()
    workspace.subscribeAgentCatalog(listener)

    await workspace.updateAgent(first.summary.id, { avatar: "block/red" })
    expect((await workspace.listAgentCatalog())[0].summary.avatar).toBe(
      "block/red"
    )
    await workspace.updateAgent(first.summary.id, {
      visibility: "hidden",
      avatar: null,
    })
    const [updated] = await workspace.listAgentCatalog()
    expect(updated.summary.avatar).toBeUndefined()
    expect(updated.visibility).toBe("hidden")
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("refuses an avatar change aimed at the creator", async () => {
    const workspace = createFixtureWorkspace()
    await expect(
      workspace.updateAgent(workspace.agentCreator!.id, { avatar: "ring/blue" })
    ).rejects.toThrow()
  })
})
