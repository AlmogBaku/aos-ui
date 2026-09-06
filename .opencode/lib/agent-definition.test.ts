// @vitest-environment node

import { access, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  normalizeAgentDefinition,
  writeAgentDefinition,
} from "./agent-definition"

const valid = {
  agentId: "release-guide",
  name: "Release Guide",
  description: "Plans calm, reliable releases",
  prompt: "Help the user prepare and review releases.",
  permissions: { read: "allow", bash: "ask" } as const,
}

describe("native Agent definitions", () => {
  it("writes bounded fixed frontmatter without accepting raw YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-ui-agent-"))
    const result = await writeAgentDefinition(root, valid)
    const source = await readFile(join(root, result.filePath), "utf8")

    expect(source).toContain('aos_ui_name: "Release Guide"')
    expect(source).toContain("aos_ui_managed: true")
    expect(source).toContain("permission:\n  bash: ask\n  read: allow")
    expect(source).toContain("Help the user prepare and review releases.")
  })

  it.each([
    "agent-builder",
    "en",
    "he",
    "Build",
    "two words",
    "../escape",
    "a/b",
    "-bad",
  ])("rejects an invalid or reserved ID: %s", (agentId) => {
    expect(() => normalizeAgentDefinition({ ...valid, agentId })).toThrow()
  })

  it("rejects unsupported permissions and frontmatter line injection", () => {
    expect(() =>
      normalizeAgentDefinition({
        ...valid,
        permissions: { filesystem: "allow" } as never,
      })
    ).toThrow("Unsupported Agent permission")
    expect(() =>
      normalizeAgentDefinition({ ...valid, name: "Oops\n---\nmode: all" })
    ).toThrow("single line")
  })

  it("never overwrites an existing definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-ui-agent-"))
    await writeAgentDefinition(root, valid)
    await expect(writeAgentDefinition(root, valid)).rejects.toThrow(
      "Agent already exists"
    )
  })

  it.each([".opencode", ".opencode/agents"])(
    "rejects a symbolic-link directory component at %s without writing outside the worktree",
    async (linkedComponent) => {
      const root = await mkdtemp(join(tmpdir(), "aos-ui-agent-root-"))
      const outside = await mkdtemp(join(tmpdir(), "aos-ui-agent-outside-"))
      if (linkedComponent === ".opencode/agents") {
        await mkdir(join(root, ".opencode"))
      }
      await symlink(outside, join(root, linkedComponent), "dir")
      const escapedFile =
        linkedComponent === ".opencode"
          ? join(outside, "agents", `${valid.agentId}.md`)
          : join(outside, `${valid.agentId}.md`)

      await expect(writeAgentDefinition(root, valid)).rejects.toThrow(
        "symbolic link"
      )
      await expect(access(escapedFile)).rejects.toMatchObject({
        code: "ENOENT",
      })
    }
  )
})
