import type { TurnEvent } from "../../core/events"
import { describe, expect, it, vi } from "vitest"

import type { ServerTurnEngine, ServerTurnHandle } from "../../core/runtime"
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
import { OpenClawWorkspaceUnavailableError } from "./workspace"

const sessionKey = "agent:research:main"

function idleHandle(): ServerTurnHandle {
  return {
    events: (async function* (): AsyncIterable<TurnEvent> {})(),
    settled: Promise.resolve(),
    stop: async () => "idle",
    recoveryPosition: () => ({ epoch: "test", lastSeen: 0 }),
  }
}

function engine(): ServerTurnEngine {
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
    if (method === "sessions.patch") return { ok: true, key: sessionKey }
    if (method === "sessions.delete")
      return { ok: true, key: sessionKey, deleted: true, archived: [] }
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
      turns: engine(),
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
      turns: engine(),
      subscribeSession: async () => () => undefined,
    })

    await expect(
      adapter.createSession("research", "New Session")
    ).resolves.toEqual({
      session: { id: sessionKey, agentId: "research" },
    })
    expect(gateway.request).toHaveBeenCalledWith("sessions.create", {
      agentId: "research",
      toolOverrides: { mcpServers: { "aos-ui": true } },
    })
    await expect(adapter.runtimeInfo()).resolves.toMatchObject({
      capabilities: { sessionCreation: { status: "available" } },
    })
  })

  it("renames, archives, pins, and deletes through the exact native Session RPCs", async () => {
    const gateway = client()
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      turns: engine(),
      subscribeSession: async () => () => undefined,
    })

    await adapter.updateSession("research", sessionKey, {
      title: "Renamed",
    })
    expect(gateway.request).toHaveBeenCalledWith("sessions.patch", {
      agentId: "research",
      key: sessionKey,
      label: "Renamed",
    })
    for (const archived of [true, false]) {
      await adapter.updateSession("research", sessionKey, { archived })
      expect(gateway.request).toHaveBeenCalledWith("sessions.patch", {
        agentId: "research",
        key: sessionKey,
        archived,
      })
    }
    for (const pinned of [true, false]) {
      await adapter.updateSession("research", sessionKey, { pinned })
      expect(gateway.request).toHaveBeenCalledWith("sessions.patch", {
        agentId: "research",
        key: sessionKey,
        pinned,
      })
    }
    await adapter.deleteSession("research", sessionKey)
    expect(gateway.request).toHaveBeenCalledWith("sessions.delete", {
      agentId: "research",
      key: sessionKey,
    })
    await expect(adapter.runtimeInfo()).resolves.toMatchObject({
      capabilities: {
        sessionTitle: { status: "available" },
        sessionArchival: { status: "available" },
        sessionPin: { status: "available" },
        sessionDeletion: { status: "available" },
      },
    })
  })

  it("fails closed for unproven mutations and maps only bounded provider outcomes", async () => {
    const gateway = client()
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      turns: engine(),
      subscribeSession: async () => () => undefined,
    })

    // The provider has no native read state to write.
    await expect(
      adapter.updateSession("research", sessionKey, { unread: false })
    ).rejects.toBeInstanceOf(OpenClawWorkspaceUnavailableError)
    expect(gateway.request).not.toHaveBeenCalledWith(
      "sessions.patch",
      expect.anything()
    )
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
      turns: engine(),
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
      turns: engine(),
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
      turns: engine(),
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

describe("OpenClaw artifact reads", () => {
  const receipt = {
    ok: true,
    type: "aos.artifact",
    artifact: {
      path: "/workspace/report.txt",
      filename: "report.txt",
      mimeType: "text/plain",
    },
  }
  const receiptHistory = {
    messages: [
      {
        id: "assistant",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "publish",
            name: "aos-ui__present_artifact",
            arguments: {},
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "publish",
        toolName: "aos-ui__present_artifact",
        content: [{ type: "text", text: JSON.stringify(receipt) }],
      },
    ],
    sessionInfo: { hasActiveRun: false, activeRunIds: [] },
  }

  function sessionFile(file: Record<string, unknown>) {
    return {
      sessionKey,
      file: {
        path: "/workspace/report.txt",
        name: "report.txt",
        kind: "modified",
        ...file,
      },
    }
  }

  function nativeDownload(extra: Record<string, unknown>) {
    return {
      artifact: {
        id: "artifact_managed_image_abc",
        type: "image",
        title: "chart.png",
        mimeType: "image/png",
        download: { mode: "bytes" },
      },
      ...extra,
    }
  }

  function artifactAdapter(
    answers: Record<string, () => unknown>,
    fetch?: typeof globalThis.fetch
  ) {
    const base = client()
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method in answers) return answers[method]!()
      return base.request(method, params as never)
    })
    const gateway = client({ request } as Partial<OpenClawGatewayClient>)
    const adapter = new OpenClawServerAdapter({
      client: gateway,
      turns: engine(),
      subscribeSession: async () => () => undefined,
      gatewayOrigin: "http://127.0.0.1:18789",
      ...(fetch ? { fetch } : {}),
    })
    return { adapter, request }
  }

  async function receiptId(adapter: OpenClawServerAdapter) {
    const page = await adapter.history("research", sessionKey, 200, 0)
    const part = page.messages[0]!.content.find(
      (item) => item.type === "data"
    ) as { data: { id: string } }
    return part.data.id
  }

  it("reads a published receipt through the Session workspace in utf8 and base64", async () => {
    let file = sessionFile({
      missing: false,
      content: "hello",
      contentEncoding: "utf8",
    })
    const { adapter, request } = artifactAdapter({
      "chat.history": () => receiptHistory,
      "sessions.files.get": () => file,
    })
    const id = await receiptId(adapter)

    const text = await adapter.artifact("research", sessionKey, id)
    expect(new TextDecoder().decode(text.bytes)).toBe("hello")
    expect(text).toMatchObject({
      filename: "report.txt",
      mimeType: "text/plain",
    })
    expect(request).toHaveBeenCalledWith("sessions.files.get", {
      agentId: "research",
      sessionKey,
      path: "/workspace/report.txt",
    })

    file = sessionFile({
      missing: false,
      content: Buffer.from([1, 2, 3]).toString("base64"),
      contentEncoding: "base64",
    })
    const binary = await adapter.artifact("research", sessionKey, id)
    expect([...binary.bytes]).toEqual([1, 2, 3])
  })

  it("reports a missing or refused receipt file as not found", async () => {
    let answer: () => unknown = () => sessionFile({ missing: true })
    const { adapter } = artifactAdapter({
      "chat.history": () => receiptHistory,
      "sessions.files.get": () => answer(),
    })
    const id = await receiptId(adapter)

    await expect(
      adapter.artifact("research", sessionKey, id)
    ).rejects.toSatisfy((error) => adapter.publicError(error)?.status === 404)
    answer = () => {
      throw new OpenClawClientRequestError("rejected", true, false)
    }
    await expect(
      adapter.artifact("research", sessionKey, id)
    ).rejects.toSatisfy((error) => adapter.publicError(error)?.status === 404)
  })

  it("does not find an artifact id this Session never published", async () => {
    const { adapter, request } = artifactAdapter({
      "chat.history": () => ({ messages: [] }),
      "artifacts.download": () => {
        throw new OpenClawClientRequestError("rejected", true, false)
      },
    })

    for (const id of [
      "openclaw-artifact-0123456789abcdef0123456789abcdef",
      "artifact_managed_image_other",
      "../etc/passwd",
    ])
      await expect(
        adapter.artifact("research", sessionKey, id)
      ).rejects.toSatisfy((error) => adapter.publicError(error)?.status === 404)
    expect(
      request.mock.calls.some(([method]) => method === "sessions.files.get")
    ).toBe(false)
  })

  it("downloads a native artifact inline or from the gateway's ticketed media route", async () => {
    let download: unknown = nativeDownload({
      encoding: "base64",
      data: Buffer.from("png").toString("base64"),
    })
    const fetch = vi.fn(async () => new Response("fetched"))
    const { adapter, request } = artifactAdapter(
      { "artifacts.download": () => download },
      fetch as unknown as typeof globalThis.fetch
    )

    const inline = await adapter.artifact(
      "research",
      sessionKey,
      "artifact_managed_image_abc"
    )
    expect(new TextDecoder().decode(inline.bytes)).toBe("png")
    expect(inline).toMatchObject({
      filename: "chart.png",
      mimeType: "image/png",
    })
    expect(request).toHaveBeenCalledWith("artifacts.download", {
      agentId: "research",
      sessionKey,
      artifactId: "artifact_managed_image_abc",
    })

    download = nativeDownload({
      url: "/api/chat/media/outgoing/research/abc?mediaTicket=t",
    })
    const fetched = await adapter.artifact(
      "research",
      sessionKey,
      "artifact_managed_image_abc"
    )
    expect(new TextDecoder().decode(fetched.bytes)).toBe("fetched")
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "http://127.0.0.1:18789/api/chat/media/outgoing/research/abc?mediaTicket=t"
      ),
      { redirect: "error" }
    )

    download = nativeDownload({ url: "https://elsewhere.example/file.png" })
    await expect(
      adapter.artifact("research", sessionKey, "artifact_managed_image_abc")
    ).rejects.toSatisfy((error) => adapter.publicError(error)?.status === 404)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
