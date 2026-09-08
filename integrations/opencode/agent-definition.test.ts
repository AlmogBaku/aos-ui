// @vitest-environment node

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  installCreatorDefinition,
  writeAgentDefinition,
} from "./agent-definition"
import { agentCreatorSkill } from "./creator-skill.generated"

const valid = {
  agentId: "release-guide",
  name: "Release Guide",
  description: "Plans calm, reliable releases",
  prompt: "Help the user prepare and review releases.",
  permissions: { read: "allow", bash: "ask" } as const,
}

describe("packaged OpenCode Agent definitions", () => {
  it("keeps the bundled creator skill generated from the shared source", async () => {
    expect(agentCreatorSkill).toBe(
      await readFile(
        new URL("../../shared/agent-creator/SKILL.md", import.meta.url),
        "utf8"
      )
    )
  })

  it("writes only inside the explicitly supplied worktree", async () => {
    const integrationCheckout = await mkdtemp(join(tmpdir(), "aos-ui-source-"))
    const externalWorktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))

    const result = await writeAgentDefinition(externalWorktree, valid)

    expect(
      await readFile(join(externalWorktree, result.filePath), "utf8")
    ).toContain('aos_ui_name: "Release Guide"')
    await expect(
      access(
        join(integrationCheckout, ".opencode", "agents", "release-guide.md")
      )
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("never overwrites an existing definition", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    await writeAgentDefinition(worktree, valid)

    await expect(writeAgentDefinition(worktree, valid)).rejects.toThrow(
      "Agent already exists"
    )
  })

  it.each([".opencode", ".opencode/agents"])(
    "rejects a symbolic-link directory component at %s",
    async (linkedComponent) => {
      const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
      const outside = await mkdtemp(join(tmpdir(), "aos-ui-outside-"))
      if (linkedComponent === ".opencode/agents") {
        await mkdir(join(worktree, ".opencode"))
      }
      await symlink(outside, join(worktree, linkedComponent), "dir")

      await expect(writeAgentDefinition(worktree, valid)).rejects.toThrow(
        "symbolic link"
      )
    }
  )

  it("installs the packaged creator without changing user Agent definitions", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    await mkdir(join(worktree, ".opencode", "agents"), { recursive: true })
    const userAgent = join(worktree, ".opencode", "agents", "aster.md")
    await writeFile(userAgent, "user-owned definition\n")

    await expect(installCreatorDefinition(worktree)).resolves.toEqual({
      status: "installed",
      agentId: "agent-builder",
    })
    await expect(installCreatorDefinition(worktree)).resolves.toEqual({
      status: "current",
      agentId: "agent-builder",
    })
    expect(await readFile(userAgent, "utf8")).toBe("user-owned definition\n")
  })

  it("rejects a conflicting creator instead of overwriting it", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    await mkdir(join(worktree, ".opencode", "agents"), { recursive: true })
    const creator = join(worktree, ".opencode", "agents", "agent-builder.md")
    await writeFile(creator, "user definition\n")

    await expect(installCreatorDefinition(worktree)).rejects.toThrow(
      /conflicting Agent Builder definition/i
    )
    expect(await readFile(creator, "utf8")).toBe("user definition\n")
  })

  it("preflights the creator skill before installing either asset", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    const skillDirectory = join(
      worktree,
      ".opencode",
      "skills",
      "aos-agent-creator"
    )
    await mkdir(skillDirectory, { recursive: true })
    const skill = join(skillDirectory, "SKILL.md")
    await writeFile(skill, "user-owned skill\n")

    await expect(installCreatorDefinition(worktree)).rejects.toThrow(
      /conflicting AOS Agent creator skill/i
    )
    await expect(
      access(join(worktree, ".opencode", "agents", "agent-builder.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(skill, "utf8")).toBe("user-owned skill\n")
  })
})
