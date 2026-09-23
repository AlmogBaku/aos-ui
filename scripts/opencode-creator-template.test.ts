// @vitest-environment node

import { access } from "node:fs/promises"
import { resolve } from "node:path"

import { parse } from "yaml"
import { describe, expect, it } from "vitest"

import {
  CREATOR_AGENT_ID,
  creatorAgentDefinition,
} from "./opencode-creator-template"

function parseAgentDefinition(source: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  if (!match) throw new Error("Invalid Agent definition")
  return {
    metadata: parse(match[1]) as Record<string, unknown>,
    prompt: match[2].trim(),
  }
}

describe("packaged OpenCode Agent and harness configuration", () => {
  it("keeps the native creator hidden, model-neutral, and narrowly privileged", () => {
    const builder = parseAgentDefinition(creatorAgentDefinition)

    expect(CREATOR_AGENT_ID).toBe("agent-builder")
    expect(builder.metadata.model).toBeUndefined()
    expect(builder.metadata).toMatchObject({
      mode: "primary",
      hidden: true,
      aos_ui_role: "creator",
      permission: {
        "*": "deny",
        edit: {
          "*": "deny",
          ".opencode/agents/*.md": "allow",
          ".opencode/agents/agent-builder.md": "deny",
        },
        bash: "deny",
        task: "deny",
        question: "allow",
        skill: { "*": "deny", "aos-agent-creator": "allow" },
      },
    })
    expect(builder.prompt).toMatch(/load and follow.*aos-agent-creator/i)
    expect(builder.prompt).toMatch(/final confirmation/i)
    expect(builder.prompt).toMatch(/write exactly one new Agent file/i)
    expect(builder.prompt).toMatch(/never.*create a first Session/i)
  })

  it("does not load integration-owned tools or prompts from the source worktree", async () => {
    for (const obsoletePath of [
      ".opencode/agents/agent-builder.md",
      ".opencode/plugins/aos-ui-harness.ts",
      ".opencode/tools/create_agent.ts",
      ".opencode/tools/start_session.ts",
    ]) {
      await expect(
        access(resolve(process.cwd(), obsoletePath))
      ).rejects.toMatchObject({ code: "ENOENT" })
    }
  })
})
