import { describe, expect, it, vi } from "vitest"

import { createProxyApp } from "./app"
import {
  HermesAuthenticationError,
  HermesHttpError,
} from "./adapters/hermes/gateway"
import {
  HermesServerAdapter,
  HermesSessionNotFoundError,
  type HermesRpcTransport,
} from "./adapters/hermes/adapter"
import type { RuntimeInstance, ServerMcpApps } from "./core/runtime"
import { SessionCoordinator } from "./core/session-coordinator"
import { McpAppNotFoundError } from "./mcp-apps/fallback"

const origin = "http://127.0.0.1:3000"

function session(agentId = "researcher", id = "stored") {
  return {
    id,
    agentId,
    title: "Owned",
    archived: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "idle" as const,
  }
}

function nativeProfile() {
  return {
    name: "researcher",
    display_name: "Researcher",
    ui_meta: { "hermes-bots": { hidden: false } },
    ui_meta_revisions: { "hermes-bots": 1 },
  }
}

function runtimeInstance(runtime: HermesServerAdapter): RuntimeInstance {
  const sessions = new SessionCoordinator({
    engine: runtime.turns,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: 32,
    maxSubscriberBytes: 256 * 1024,
    maxReplayEvents: 64,
    maxReplayBytes: 512 * 1024,
  })
  return {
    id: "hermes-main",
    runtime,
    sessions,
    close: vi.fn(async () => {
      sessions.close()
      await runtime.close()
    }),
  }
}

function app(runtime: HermesServerAdapter) {
  return createProxyApp({
    publicOrigin: origin,
    runtimeInstance: runtimeInstance(runtime),
    logger: { info: vi.fn(), error: vi.fn() },
  })
}

const stageRequest = {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    attachments: [
      {
        type: "file",
        filename: "notes.txt",
        mimeType: "text/plain",
        dataUrl: "data:text/plain;base64,bm90ZXM=",
      },
    ],
  }),
}

describe("AOS V1 proxy", () => {
  it("serves runtime discovery without application authentication", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [nativeProfile()] } : undefined
    )

    const response = await app(new HermesServerAdapter({ request })).request(
      `${origin}/api/aos/v1/runtime`
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    await expect(response.json()).resolves.toMatchObject({
      runtime: { id: "hermes" },
      status: "ready",
    })
  })

  it("stages operator attachments for the ACP lane to consume", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    const cleanup = vi.fn(async () => undefined)
    vi.spyOn(runtime, "stageAttachments").mockResolvedValue({
      public: [{ type: "file", filename: "notes.txt", mimeType: "text/plain" }],
      appendTo: (text) => `${text}\n\n[attachment]`,
      cleanup,
    })

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
      stageRequest
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      stageId: expect.any(String),
      attachments: [
        { type: "file", filename: "notes.txt", mimeType: "text/plain" },
      ],
    })
    expect(cleanup).not.toHaveBeenCalled()
  })

  it("requires the exact configured origin for state changes", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "stageAttachments")

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
      {
        ...stageRequest,
        headers: {
          origin: "https://attacker.example.test",
          "content-type": "application/json",
        },
      }
    )

    expect(response.status).toBe(403)
    expect(runtime.stageAttachments).not.toHaveBeenCalled()
  })

  it("does not expose invitation signing when the guest surface is disabled", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    const proxy = app(runtime)

    const response = await proxy.request(
      `${origin}/api/aos/v1/guest-invitations`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ agentId: "researcher", ref: "guest-ref" }),
      }
    )

    expect(response.status).toBe(404)
  })

  it("serves no browser wire beside runtime discovery and content", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    const proxy = app(runtime)
    const session = `${origin}/api/aos/v1/agents/researcher/sessions/stored`

    // Sessions, history, models, context, visibility, runs, and the
    // invalidation socket all travel over ACP now.
    for (const path of [
      `${origin}/api/aos/v1/agents`,
      `${origin}/api/aos/v1/sessions`,
      `${origin}/api/aos/v1/events`,
      session,
      `${session}/history`,
      `${session}/runs`,
      `${session}/runs/stop`,
      `${session}/runs/steer`,
      `${session}/workspace/capabilities`,
      `${session}/workspace/models`,
      `${session}/workspace/context`,
      `${session}/workspace/todos`,
      `${session}/interactions/pending`,
      `${session}/audio`,
    ])
      expect((await proxy.request(path)).status, path).toBe(404)
  })

  it("reports rejected credentials and keeps an unreachable provider discoverable", async () => {
    const failing = (error: Error) =>
      app(
        new HermesServerAdapter({
          request: vi.fn(async () => {
            throw error
          }),
        })
      ).request(`${origin}/api/aos/v1/runtime`)

    const rejected = await failing(new HermesAuthenticationError())
    expect(rejected.status).toBe(401)
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "runtime_authentication_required",
        description: expect.any(String),
      },
    })

    // Runtime discovery is how the browser learns a runtime is unreachable, so
    // it answers with unavailable state rather than an error.
    const unreachable = await failing(new HermesHttpError(503))
    expect(unreachable.status).toBe(200)
    await expect(unreachable.json()).resolves.toMatchObject({
      status: "unavailable",
    })
  })

  it("maps a provider failure on the content lane to a friendly error", async () => {
    const transport: HermesRpcTransport = {
      request: vi.fn(async () => {
        throw new HermesHttpError(503)
      }),
    }

    const response = await app(new HermesServerAdapter(transport)).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
      stageRequest
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: {
        code: "temporarily_unavailable",
        description: expect.any(String),
      },
    })
  })

  it("maps an owned Session miss to a friendly not-found response", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockRejectedValue(
      new HermesSessionNotFoundError()
    )

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
      stageRequest
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "not_found", description: expect.any(String) },
    })
  })

  it("keeps liveness independent from provider readiness", async () => {
    const runtime = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new Error("offline")
      }),
    })
    const proxy = app(runtime)

    expect((await proxy.request(`${origin}/api/aos/v1/healthz`)).status).toBe(
      200
    )
    expect((await proxy.request(`${origin}/api/aos/v1/readyz`)).status).toBe(
      503
    )
  })

  it("logs the request path without its query on a completed and a failed request", async () => {
    const runtime = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new HermesHttpError(503)
      }),
    })
    const logger = { info: vi.fn(), error: vi.fn() }
    const proxy = createProxyApp({
      publicOrigin: origin,
      runtimeInstance: runtimeInstance(runtime),
      logger,
    })

    // An artifact read is a REST route that reaches the provider, so an outage
    // there is the failure a log line has to name its path for.
    const path = "/api/aos/v1/agents/researcher/sessions/stored/artifacts/art-1"
    expect((await proxy.request(`${origin}${path}?token=secret`)).status).toBe(
      503
    )

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "request.failed",
        code: "temporarily_unavailable",
        path,
      })
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "request.completed",
        method: "GET",
        status: 503,
        path,
      })
    )
  })

  it("opens an MCP App view only from the Session that holds its call", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockImplementation(async (agentId, id) =>
      session(agentId, id)
    )
    // A call the runtime finds only in the Session that made it.
    const owned = (sessionId: string, toolCallId: string) => {
      if (sessionId !== "stored" || toolCallId !== "call-1")
        throw new McpAppNotFoundError()
    }
    const mcpApps: ServerMcpApps = {
      describe: vi.fn(async () => true),
      open: vi.fn(async (scope, toolCallId) => {
        owned(scope.sessionId, toolCallId)
        return { html: "<p>view</p>" }
      }),
      callTool: vi.fn(async (scope, toolCallId) => {
        owned(scope.sessionId, toolCallId)
        return { content: [] }
      }),
      readResource: vi.fn(async () => ({ contents: [] })),
    }
    Object.defineProperty(runtime, "mcpApps", { value: mcpApps })
    const proxy = app(runtime)
    const view = (sessionId: string) =>
      `${origin}/api/aos/v1/agents/researcher/sessions/${sessionId}/tool-calls/call-1/app`

    expect((await proxy.request(view("stored"))).status).toBe(200)
    expect((await proxy.request(view("other"))).status).toBe(404)
    const call = await proxy.request(`${view("other")}/tools/call`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "refresh", arguments: {} }),
    })
    expect(call.status).toBe(404)
    expect(await call.json()).toMatchObject({ error: { code: "not_found" } })
  })
})
