// @vitest-environment node

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createAgent } from "./create-agent"

const definition = {
  agentId: "support-guide",
  name: "Support Guide",
  description: "Answers support questions",
  prompt: "Help with support questions.",
  permissions: {},
}

describe("native create_agent", () => {
  it("rejects callers other than the native Agent Builder before writing", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    const agents = vi.fn(async () => ({
      data: [{ name: "build", mode: "primary", options: {} }],
    }))

    await expect(
      createAgent({ app: { agents } }, worktree, "build", definition)
    ).rejects.toThrow(/only the Agent Builder/i)
    expect(agents).toHaveBeenCalledOnce()
  })

  it("returns ready only after authoritative native readback", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    const agents = vi.fn(async () => ({
      data: [
        {
          name: "workspace-creator",
          mode: "primary",
          hidden: true,
          native: false,
          options: { aos_ui_role: "creator" },
        },
        {
          name: "support-guide",
          description: "Answers support questions",
          mode: "primary",
          native: false,
          hidden: false,
          options: { aos_ui_name: "Support Guide", aos_ui_managed: true },
        },
      ],
    }))

    await expect(
      createAgent(
        { app: { agents } },
        worktree,
        "workspace-creator",
        definition
      )
    ).resolves.toMatchObject({
      version: 1,
      kind: "agent-created",
      agentId: "support-guide",
      saved: true,
      status: "ready",
    })
    expect(agents).toHaveBeenCalledWith({
      query: { directory: worktree },
      throwOnError: true,
    })
    expect(agents).toHaveBeenCalledTimes(2)
  })

  it("reports setup-needed when native activation/readback is unavailable", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    const agents = vi.fn(async () => ({
      data: [
        {
          name: "workspace-creator",
          mode: "primary",
          hidden: true,
          native: false,
          options: { aos_ui_role: "creator" },
        },
      ],
    }))

    await expect(
      createAgent(
        { app: { agents } },
        worktree,
        "workspace-creator",
        definition
      )
    ).resolves.toMatchObject({
      agentId: "support-guide",
      saved: true,
      status: "setup-needed",
    })
  })
})
