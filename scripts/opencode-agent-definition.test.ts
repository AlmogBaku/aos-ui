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

import { installCreatorDefinition } from "./opencode-agent-definition"
import { agentCreatorOpenCodeReference } from "./opencode-creator-reference.generated"
import { agentCreatorSkill } from "./opencode-creator-skill.generated"
import { inviteLinkSkill } from "./opencode-invite-link.generated"

describe("packaged OpenCode Agent definitions", () => {
  it("has one shared invite-link skill source", async () => {
    await expect(
      readFile(
        new URL("../shared/invite-link/SKILL.md", import.meta.url),
        "utf8"
      )
    ).resolves.toContain("name: aos-invite-link")
  })

  it("keeps the bundled creator skill generated from the shared source", async () => {
    expect(agentCreatorSkill).toBe(
      await readFile(
        new URL("../shared/agent-creator/SKILL.md", import.meta.url),
        "utf8"
      )
    )
  })

  it("keeps the bundled creator reference generated from the shared source", async () => {
    expect(agentCreatorOpenCodeReference).toBe(
      await readFile(
        new URL(
          "../shared/agent-creator/reference/harness-opencode.md",
          import.meta.url
        ),
        "utf8"
      )
    )
  })

  it("keeps the bundled invite skill generated from the shared source", async () => {
    expect(inviteLinkSkill).toBe(
      await readFile(
        new URL("../shared/invite-link/SKILL.md", import.meta.url),
        "utf8"
      )
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

      await expect(installCreatorDefinition(worktree)).rejects.toThrow(
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
    expect(
      await readFile(
        join(worktree, ".opencode", "skills", "aos-invite-link", "SKILL.md"),
        "utf8"
      )
    ).toBe(inviteLinkSkill)
    expect(
      await readFile(
        join(
          worktree,
          ".opencode",
          "skills",
          "aos-agent-creator",
          "reference",
          "harness-opencode.md"
        ),
        "utf8"
      )
    ).toBe(agentCreatorOpenCodeReference)
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

  it("preflights a conflicting invite skill before installing any asset", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "aos-ui-worktree-"))
    const skillDirectory = join(
      worktree,
      ".opencode",
      "skills",
      "aos-invite-link"
    )
    await mkdir(skillDirectory, { recursive: true })
    const skill = join(skillDirectory, "SKILL.md")
    await writeFile(skill, "user-owned skill\n")

    await expect(installCreatorDefinition(worktree)).rejects.toThrow(
      /conflicting AOS invite-link skill/i
    )
    await expect(
      access(join(worktree, ".opencode", "agents", "agent-builder.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      access(
        join(worktree, ".opencode", "skills", "aos-agent-creator", "SKILL.md")
      )
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(skill, "utf8")).toBe("user-owned skill\n")
  })
})
