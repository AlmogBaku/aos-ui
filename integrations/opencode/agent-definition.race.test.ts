// @vitest-environment node

import { access, mkdtemp, rename, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

const openRace = vi.hoisted(() => ({
  beforeDefinitionOpen: undefined as undefined | (() => Promise<void>),
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const interceptedOpen: typeof actual.open = async (path, flags, mode) => {
    if (
      String(path).endsWith("/release-guide.md") &&
      openRace.beforeDefinitionOpen
    ) {
      const swap = openRace.beforeDefinitionOpen
      openRace.beforeDefinitionOpen = undefined
      await swap()
    }
    return actual.open(path, flags, mode)
  }
  return { ...actual, open: interceptedOpen }
})

import { writeAgentDefinition } from "./agent-definition"

describe("OpenCode Agent definition race safety", () => {
  it("does not follow a swapped Agent directory during exclusive creation", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    const outside = await mkdtemp(join(tmpdir(), "aos-ui-outside-"))
    const agents = join(worktree, ".opencode", "agents")
    const anchoredAgents = join(worktree, ".opencode", "agents-before-swap")
    openRace.beforeDefinitionOpen = async () => {
      await rename(agents, anchoredAgents)
      await symlink(outside, agents, "dir")
    }

    await writeAgentDefinition(worktree, {
      agentId: "release-guide",
      name: "Release Guide",
      description: "Plans calm, reliable releases",
      prompt: "Help the user prepare and review releases.",
    })

    await expect(
      access(join(outside, "release-guide.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      access(join(anchoredAgents, "release-guide.md"))
    ).resolves.toBeUndefined()
  })
})
