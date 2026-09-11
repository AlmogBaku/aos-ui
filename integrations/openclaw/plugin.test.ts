import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import plugin from "./index.js"

describe("OpenClaw plugin contract", () => {
  it("registers every declared tool and approval-gates Agent creation", async () => {
    const tools: Array<{ tool: unknown; opts?: { name?: string } }> = []
    let approvalHook:
      ((event: unknown, context: unknown) => unknown) | undefined
    const api = {
      pluginConfig: { creatorAgentId: "builder" },
      registerTool: vi.fn((tool, opts) => tools.push({ tool, opts })),
      on: vi.fn((name, hook) => {
        if (name === "before_tool_call") approvalHook = hook
      }),
      runtime: { gateway: { request: vi.fn() } },
    }

    plugin.register(api as never)

    const manifest = JSON.parse(
      await readFile(new URL("./openclaw.plugin.json", import.meta.url), "utf8")
    )
    expect(tools.map(({ opts }) => opts?.name)).toEqual(
      expect.arrayContaining(manifest.contracts.tools)
    )
    expect(approvalHook).toBeTypeOf("function")
    expect(
      await approvalHook?.(
        { toolName: "create_agent", params: { agentId: "analyst" } },
        { agentId: "builder", sessionKey: "agent:builder:main" }
      )
    ).toMatchObject({
      requireApproval: {
        severity: "critical",
        allowedDecisions: ["allow-once", "deny"],
      },
    })
  })

  it("does not request approval for presentation tools", async () => {
    let approvalHook:
      ((event: unknown, context: unknown) => unknown) | undefined
    plugin.register({
      pluginConfig: {},
      registerTool: vi.fn(),
      on: vi.fn((name, hook) => {
        if (name === "before_tool_call") approvalHook = hook
      }),
      runtime: { gateway: { request: vi.fn() } },
    } as never)

    expect(
      approvalHook?.(
        { toolName: "render_chart", params: {} },
        { agentId: "agent-builder" }
      )
    ).toBeUndefined()
  })

  it("blocks Agent creation outside the configured creator", async () => {
    let approvalHook:
      ((event: unknown, context: unknown) => unknown) | undefined
    plugin.register({
      pluginConfig: { creatorAgentId: "builder" },
      registerTool: vi.fn(),
      on: vi.fn((name, hook) => {
        if (name === "before_tool_call") approvalHook = hook
      }),
      runtime: { gateway: { request: vi.fn() } },
    } as never)

    expect(
      approvalHook?.(
        { toolName: "create_agent", params: { agentId: "analyst" } },
        { agentId: "researcher" }
      )
    ).toEqual({
      block: true,
      blockReason: "Only the configured Agent Builder may create Agents",
    })
  })
})
