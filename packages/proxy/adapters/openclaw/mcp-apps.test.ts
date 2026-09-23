import { describe, expect, it, vi } from "vitest"

import type { TurnEvent } from "../../core/events"
import type { ServerTurnHandle } from "../../core/runtime"
import { OpenClawServerAdapter } from "./adapter"
import {
  OpenClawClientRequestError,
  type OpenClawGatewayClient,
} from "./client"

const sessionKey = "agent:research:main"
const otherKey = "agent:research:other"
const viewId = "mcp-app-0b6f3c1e-2f0a-4c4e-9d55-0d3c2a1b9e77"
const scope = { agentId: "research", sessionId: sessionKey, threadId: "t1" }
const toolResult = { content: [{ type: "text", text: "drawn" }] }

const appHistory = {
  messages: [
    {
      id: "assistant",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "excalidraw__create_view",
          arguments: { title: "Plan" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "excalidraw__create_view",
      content: toolResult.content,
      details: {
        mcpServer: "excalidraw",
        mcpTool: "create_view",
        mcpAppPreview: {
          kind: "canvas",
          view: { id: viewId, title: "create_view UI" },
          mcpApp: {
            viewId,
            serverName: "excalidraw",
            toolName: "create_view",
            uiResourceUri: "ui://excalidraw/view.html",
            toolCallId: "call-1",
          },
        },
      },
    },
  ],
  sessionInfo: { hasActiveRun: false, activeRunIds: [] },
}

function gateway(answers: Record<string, (params: never) => unknown> = {}) {
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method in answers) return answers[method]!(params as never)
    if (method === "agents.list")
      return {
        defaultId: "research",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "research", name: "Research", kind: "agent" }],
      }
    if (method === "sessions.list")
      return {
        sessions: [sessionKey, otherKey].map((key) => ({
          key,
          agentId: "research",
          label: key,
        })),
      }
    if (method === "chat.history")
      return (params as { sessionKey: string }).sessionKey === sessionKey
        ? appHistory
        : { messages: [], sessionInfo: { hasActiveRun: false } }
    if (method === "tools.effective")
      return { agentId: "research", profile: "default", groups: [] }
    throw new Error(`Unexpected method ${method}`)
  })
  const client = {
    start: vi.fn(),
    stopAndWait: vi.fn(async () => undefined),
    request,
  } as unknown as OpenClawGatewayClient
  const idle: ServerTurnHandle = {
    events: (async function* (): AsyncIterable<TurnEvent> {})(),
    settled: Promise.resolve(),
    stop: async () => "idle",
    recoveryPosition: () => ({ epoch: "test", lastSeen: 0 }),
  }
  const adapter = new OpenClawServerAdapter({
    client,
    turns: { start: async () => idle, recover: async () => idle },
    subscribeSession: async () => () => undefined,
  })
  return { adapter, request, mcpApps: adapter.mcpApps }
}

const isNotFound =
  (adapter: OpenClawServerAdapter) =>
  (error: unknown): boolean =>
    adapter.publicError(error)?.status === 404

describe("OpenClaw MCP Apps", () => {
  it("names the stored call canonically and describes it as an app", async () => {
    const { adapter, mcpApps } = gateway()
    const page = await adapter.history("research", sessionKey, 200, 0)
    expect(page.messages[0]!.content[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "mcp__excalidraw__create_view",
    })
    await expect(
      mcpApps.describe(scope, {
        toolCallId: "call-1",
        toolName: "mcp__excalidraw__create_view",
      })
    ).resolves.toBe(true)
    await expect(
      mcpApps.describe(scope, {
        toolCallId: "call-1",
        toolName: "mcp__excalidraw__create_view",
        result: { content: [] },
      })
    ).resolves.toBe(false)
  })

  it("opens the view and forwards its tool and resource calls natively", async () => {
    const { mcpApps, request } = gateway({
      "mcp.app.view": () => ({
        sandboxUrl: "/sandbox",
        sandboxPort: 18790,
        html: "<p>app</p>",
        csp: { connectDomains: ["https://api.example.com"] },
        toolInput: { title: "Plan" },
        toolResult,
        messageSupported: true,
        updateModelContextSupported: true,
      }),
      "mcp.app.callTool": () => ({ content: [{ type: "text", text: "ok" }] }),
      "mcp.app.readResource": () => ({
        contents: [{ uri: "ui://excalidraw/data.json", text: "{}" }],
      }),
    })
    const native = { sessionKey, agentId: "research", viewId }

    await expect(mcpApps.open(scope, "call-1")).resolves.toEqual({
      html: "<p>app</p>",
      csp: { connectDomains: ["https://api.example.com"] },
      toolInput: { title: "Plan" },
      toolResult,
    })
    await expect(
      mcpApps.callTool(scope, "call-1", "update_view", { id: 1 })
    ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] })
    await expect(
      mcpApps.readResource(scope, "call-1", "ui://excalidraw/data.json")
    ).resolves.toEqual({
      contents: [{ uri: "ui://excalidraw/data.json", text: "{}" }],
    })
    expect(request).toHaveBeenCalledWith("mcp.app.view", native, undefined)
    expect(request).toHaveBeenCalledWith(
      "mcp.app.callTool",
      { ...native, toolName: "update_view", arguments: { id: 1 } },
      undefined
    )
    expect(request).toHaveBeenCalledWith(
      "mcp.app.readResource",
      { ...native, uri: "ui://excalidraw/data.json" },
      undefined
    )
  })

  it("refuses a tool call id from another Session without asking the gateway", async () => {
    const { adapter, mcpApps, request } = gateway()
    const other = { ...scope, sessionId: otherKey }

    await expect(mcpApps.open(other, "call-1")).rejects.toSatisfy(
      isNotFound(adapter)
    )
    await expect(
      mcpApps.callTool(other, "call-1", "update_view", {})
    ).rejects.toSatisfy(isNotFound(adapter))
    await expect(
      mcpApps.describe(other, { toolCallId: "call-1", toolName: "x" })
    ).resolves.toBe(false)
    expect(
      request.mock.calls.some(([method]) => method.startsWith("mcp.app."))
    ).toBe(false)
  })

  it("reports a view the gateway no longer holds as not found", async () => {
    const expired = () => {
      throw new OpenClawClientRequestError("rejected", true, true)
    }
    const { adapter, mcpApps } = gateway({
      "mcp.app.view": expired,
      "mcp.app.readResource": expired,
    })

    await expect(mcpApps.open(scope, "call-1")).rejects.toSatisfy(
      isNotFound(adapter)
    )
    await expect(
      mcpApps.readResource(scope, "call-1", "ui://excalidraw/data.json")
    ).rejects.toSatisfy(isNotFound(adapter))
  })
})
