import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parse } from "yaml"

import { describe, expect, it, vi } from "vitest"

import createAgent from "../../.opencode/tools/create_agent"

type OpenCodeConfig = {
  model?: string
  small_model?: string
  instructions?: string[]
  permission?: Record<string, unknown>
  mcp?: Record<string, unknown>
  agent?: Record<
    string,
    {
      mode?: string
      hidden?: boolean
      model?: string
      prompt?: string
      permission?: Record<string, unknown>
      options?: Record<string, unknown>
    }
  >
}

async function readConfig() {
  return JSON.parse(
    await readFile(resolve(process.cwd(), "opencode.json"), "utf8")
  ) as OpenCodeConfig
}

async function readAgentDefinition(agentId: string) {
  const source = await readFile(
    resolve(process.cwd(), ".opencode/agents", `${agentId}.md`),
    "utf8"
  )
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  if (!match) throw new Error(`Invalid Agent definition: ${agentId}`)
  return {
    metadata: parse(match[1]) as Record<string, unknown>,
    prompt: match[2].trim(),
  }
}

describe("OpenCode Agent and harness configuration", () => {
  it("leaves model selection to the providers available at runtime", async () => {
    const config = await readConfig()
    const builder = await readAgentDefinition("agent-builder")

    expect(config.model).toBeUndefined()
    expect(config.small_model).toBeUndefined()
    expect(builder.metadata.model).toBeUndefined()
  })

  it("provides Aster as the ready Agent in a fresh OpenCode workspace", async () => {
    const config = await readConfig()
    const aster = await readAgentDefinition("aster")

    expect(config.agent).toBeUndefined()
    expect(aster.metadata).toMatchObject({
      mode: "primary",
      hidden: false,
      aos_ui_name: "Aster",
    })
    expect(aster.prompt).toContain("general analysis and synthesis Agent")
  })

  it("keeps the infrastructure Builder hidden and narrowly privileged", async () => {
    const config = await readConfig()
    const builder = await readAgentDefinition("agent-builder")
    const prompt = builder.prompt

    expect(builder.metadata.hidden).toBe(true)
    expect(prompt).toMatch(/grilling skill/i)
    expect(prompt).toContain("create_agent")
    expect(prompt).toMatch(/one native question tool call per round/i)
    expect(prompt).toMatch(/batch all independent frontier questions/i)
    expect(prompt).toMatch(/all answerable prompts.*question tool payload/i)
    expect(prompt).toMatch(/every question entry.*header.*question.*options/i)
    expect(prompt).toMatch(/every option.*label.*description/i)
    expect(prompt).toContain("custom: true")
    expect(prompt).toMatch(/question component.*round/i)
    expect(prompt).toMatch(/do not announce.*Round N/i)
    expect(prompt).toMatch(/final confirmation.*native question tool/i)
    expect(builder.metadata.permission).toMatchObject({
      "*": "deny",
      edit: "deny",
      bash: "deny",
      task: "deny",
      question: "allow",
      create_agent: "allow",
      skill: { "*": "deny", grilling: "allow" },
    })
    expect(config.permission?.create_agent).toBe("deny")
  })

  it("loads the project prompt plugin and local Monty MCP without a legacy instructions file", async () => {
    const config = await readConfig()
    const plugin = await readFile(
      resolve(process.cwd(), ".opencode/plugins/aos-ui-harness.ts"),
      "utf8"
    )

    expect(config.instructions).toBeUndefined()
    expect(plugin).toContain("experimental.chat.system.transform")
    expect(config.mcp?.monty).toMatchObject({
      type: "local",
      enabled: true,
      timeout: 120000,
      command: [
        "uv",
        "run",
        "--project",
        "integrations/monty",
        "--frozen",
        "python",
        "-m",
        "monty",
      ],
    })
    expect(config.permission).toMatchObject({
      monty_execute: "allow",
      monty_search: "allow",
      render_chart: "allow",
      render_map: "allow",
      render_stats: "allow",
      present_plan: "allow",
    })
  })

  it("rejects create_agent outside the hidden Builder before touching disk", async () => {
    await expect(
      createAgent.execute(
        {
          agentId: "support-guide",
          name: "Support Guide",
          description: "Answers support questions",
          prompt: "Help with support questions.",
          permissions: {},
        },
        {
          sessionID: "session-1",
          messageID: "message-1",
          agent: "build",
          directory: process.cwd(),
          worktree: process.cwd(),
          abort: new AbortController().signal,
          metadata: vi.fn(),
          ask: vi.fn(),
        }
      )
    ).rejects.toThrow(/only the Agent Builder/i)
  })
})
