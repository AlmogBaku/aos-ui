import type { AGUIEvent } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import type { ServerRunEngine, ServerRunHandle } from "../../core/runtime"
import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import {
  OpenClawAdapterUnavailableError,
  OpenClawServerAdapter,
} from "./adapter"
import {
  OpenClawClientConnectionError,
  OpenClawClientRequestError,
  type OpenClawGatewayClient,
} from "./client"

const sessionKey = "agent:research:main"

function idleHandle(): ServerRunHandle {
  return {
    events: (async function* (): AsyncIterable<AGUIEvent> {})(),
    settled: Promise.resolve(),
    stop: async () => "idle",
    recoveryPosition: () => ({ epoch: "test", lastSeen: 0 }),
  }
}

function engine(): ServerRunEngine {
  return {
    start: async () => idleHandle(),
    recover: async () => idleHandle(),
  }
}

function client(overrides: Partial<OpenClawGatewayClient> = {}) {
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list")
      return {
        defaultId: "research",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "research", name: "Research", kind: "agent" }],
      }
    if (method === "sessions.list")
      return {
        sessions: [
          {
            key: sessionKey,
            agentId: "research",
            label: "Main",
            model: "sonnet",
            modelProvider: "anthropic",
            totalTokens: 10,
            contextTokens: 100,
          },
        ],
      }
    if (method === "sessions.create")
      return { ok: true, key: sessionKey, sessionId: "main" }
    if (method === "chat.history")
      return {
        messages: [
          {
            id: "answer-1",
            role: "assistant",
            content: "Saved answer",
            timestamp: 1_789_430_400_000,
          },
        ],
        sessionInfo: { hasActiveRun: false, activeRunIds: [] },
      }
    if (method === "models.list")
      return {
        models: [{ id: "sonnet", name: "Sonnet", provider: "anthropic" }],
      }
    throw new Error(`Unexpected method ${method}`)
  })
  return {
    start: vi.fn(async () => undefined),
    stopAndWait: vi.fn(async () => undefined),
    request,
    ...overrides,
  } as OpenClawGatewayClient & { request: typeof request }
}

describe("OpenClaw ServerRuntime assembly", () => {
  it("starts one provider client and composes exact owned workspace and history reads", async () => {
    const gateway = client()
    const subscribe = vi.fn(async () => () => undefined)
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      runs: engine(),
      subscribeSession: subscribe,
    })

    await expect(adapter.authState()).resolves.toEqual({
      status: "authenticated",
    })
    await expect(adapter.listAgents()).resolves.toMatchObject({
      agents: [
        { summary: { id: "research", name: "Research" }, editable: false },
      ],
    })
    await expect(
      adapter.getSession("research", sessionKey)
    ).resolves.toMatchObject({
      id: sessionKey,
      agentId: "research",
      title: "Main",
    })
    await expect(
      adapter.history("research", sessionKey, 200, 0)
    ).resolves.toMatchObject({
      sessionId: sessionKey,
      messages: [{ id: "answer-1", role: "assistant" }],
    })
    await expect(adapter.models("research", sessionKey)).resolves.toEqual({
      selectedId: '["anthropic","sonnet"]',
      options: [
        { id: '["anthropic","sonnet"]', label: "Sonnet", group: "anthropic" },
      ],
    })
    await expect(adapter.context("research", sessionKey)).resolves.toEqual({
      usedTokens: 10,
      maxTokens: 100,
      source: "provider-usage",
    })
    expect(gateway.start).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith(
      "research",
      sessionKey,
      expect.any(Function)
    )
  })

  it("creates native Sessions without imposing a title", async () => {
    const gateway = client()
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      runs: engine(),
      subscribeSession: async () => () => undefined,
    })

    await expect(
      adapter.createSession("research", "New Session")
    ).resolves.toEqual({
      session: { id: sessionKey, agentId: "research" },
    })
    expect(gateway.request).toHaveBeenCalledWith("sessions.create", {
      agentId: "research",
    })
    await expect(adapter.runtimeInfo()).resolves.toMatchObject({
      capabilities: { sessionCreation: { status: "available" } },
    })
  })

  it("fails closed for unproven mutations and maps only bounded provider outcomes", async () => {
    const gateway = client()
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      runs: engine(),
      subscribeSession: async () => () => undefined,
    })

    await expect(
      adapter.mutateSession("research", sessionKey, "DELETE")
    ).rejects.toBeInstanceOf(OpenClawAdapterUnavailableError)
    await expect(
      adapter.mutateSession("research", sessionKey, "PATCH", { unread: false })
    ).rejects.toBeInstanceOf(OpenClawAdapterUnavailableError)
    await expect(adapter.runtimeInfo()).resolves.toMatchObject({
      capabilities: {
        sessionReadState: {
          status: "unavailable",
          reason: "native-session-read-state-unavailable",
        },
      },
    })
    expect(
      adapter.publicError(
        new OpenClawClientConnectionError("credential-rejected")
      )
    ).toEqual({
      code: "runtime_authentication_required",
      status: 401,
    })
    expect(
      adapter.publicError(new OpenClawClientRequestError("timeout", true))
    ).toEqual({ code: "uncertain_mutation", status: 503 })
    expect(
      adapter.publicError(new Error("token=private-value"))
    ).toBeUndefined()
  })

  it("closes the single official client once", async () => {
    const gateway = client()
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      runs: engine(),
      subscribeSession: async () => () => undefined,
    })

    await Promise.all([adapter.close(), adapter.close()])

    expect(gateway.stopAndWait).toHaveBeenCalledTimes(1)
  })

  it("advertises and stages attachments only from negotiated HelloOk policy", async () => {
    const policy = {
      maxPayload: 30 * 1024 * 1024,
      attachments: {
        maxBytes: 25 * 1024 * 1024,
        maxImageBytes: 10 * 1024 * 1024,
      },
    }
    const gateway = client({ negotiatedPolicy: () => policy })
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      runs: engine(),
      subscribeSession: async () => () => undefined,
    })

    await expect(
      adapter.workspaceCapabilities("research", sessionKey)
    ).resolves.toEqual(
      expect.objectContaining({
        content: expect.objectContaining({
          attachments: expect.objectContaining({
            maxEncodedRequestBytes: policy.maxPayload,
            maxImageBytes: policy.attachments.maxImageBytes,
            maxFileBytes: policy.attachments.maxBytes,
          }),
        }),
      })
    )
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.parse(
        await adapter.workspaceCapabilities("research", sessionKey)
      )
    ).toBeDefined()
    await expect(
      adapter.stageAttachments("research", sessionKey, [
        { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
      ])
    ).resolves.toMatchObject({
      public: [{ type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" }],
    })

    const withoutAttachments = new OpenClawServerAdapter({
      client: client({
        negotiatedPolicy: () => ({ maxPayload: policy.maxPayload }),
      }),
      runs: engine(),
      subscribeSession: async () => () => undefined,
    })
    await expect(
      withoutAttachments.workspaceCapabilities("research", sessionKey)
    ).resolves.toMatchObject({
      content: {
        attachments: {
          status: "unavailable",
          reason: "negotiated-attachment-policy-unavailable",
        },
      },
    })
    await expect(
      withoutAttachments.stageAttachments("research", sessionKey, [])
    ).rejects.toBeInstanceOf(OpenClawAdapterUnavailableError)
  })
})
