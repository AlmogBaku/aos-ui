import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import { createProxyApp } from "./app"
import type { GuestInvitationService } from "./auth/guest-invitation"
import {
  HermesAuthenticationError,
  HermesHttpError,
} from "./adapters/hermes/transport"
import {
  HermesServerAdapter,
  HermesSessionNotFoundError,
  type HermesRpcTransport,
} from "./adapters/hermes/adapter"
import type {
  RuntimeInstance,
  ServerRunEngine,
  ServerRunHandle,
} from "./core/runtime"
import { SessionCoordinator } from "./core/session-coordinator"

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

function terminalHandle(events: AGUIEvent[]): ServerRunHandle {
  return {
    events: (async function* () {
      yield* events
    })(),
    settled: Promise.resolve(),
    stop: vi.fn(async () => "idle" as const),
    recoveryPosition: () => ({ epoch: "epoch-1", lastSeen: events.length }),
  }
}

function runtimeInstance(
  runtime: HermesServerAdapter,
  engine: ServerRunEngine = runtime.runs
): RuntimeInstance {
  const sessions = new SessionCoordinator({
    engine,
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

function app(
  runtime: HermesServerAdapter,
  options: {
    engine?: ServerRunEngine
    guestInvitations?: GuestInvitationService
  } = {}
) {
  return createProxyApp({
    publicOrigin: origin,
    runtimeInstance: runtimeInstance(runtime, options.engine),
    ...(options.guestInvitations
      ? { guestInvitations: options.guestInvitations }
      : {}),
    logger: { info: vi.fn(), error: vi.fn() },
  })
}

describe("AOS V1 proxy", () => {
  it("allows trusted operator reads without application authentication", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [nativeProfile()] } : undefined
    )
    const response = await app(new HermesServerAdapter({ request })).request(
      `${origin}/api/aos/v1/agents`
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.json()).toMatchObject({
      agents: [{ summary: { id: "researcher" } }],
    })
  })

  it("preserves authoritative native running status after coordinator restart", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "listSessions").mockResolvedValue({
      sessions: [{ ...session(), status: "running" }],
      total: 1,
      limit: 50,
      offset: 0,
    })

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions?limit=50&offset=0`
    )

    await expect(response.json()).resolves.toMatchObject({
      sessions: [{ id: "stored", status: "running" }],
    })
  })

  it("reattaches native work while opening history after coordinator restart", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue({
      ...session(),
      status: "running",
    })
    vi.spyOn(runtime, "history").mockResolvedValue({
      sessionId: "stored",
      messages: [],
      total: 0,
      limit: 200,
      offset: 0,
      nextOffset: 0,
    })
    const source: ServerRunHandle = {
      events: (async function* () {
        yield {
          type: EventType.RUN_STARTED,
          threadId: "stored",
          runId: "provider-run",
        } as AGUIEvent
        await new Promise(() => undefined)
      })(),
      settled: new Promise(() => undefined),
      stop: vi.fn(async () => "stopping" as const),
      recoveryPosition: () => ({ epoch: "epoch-1", lastSeen: 0 }),
    }
    const engine: ServerRunEngine = {
      start: vi.fn(),
      recover: vi.fn(),
      discover: vi.fn(async () => ({ handle: source, state: "running" })),
    }

    const response = await app(runtime, { engine }).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/history?limit=200&offset=0`
    )

    expect(engine.discover).toHaveBeenCalledOnce()
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        status: "running",
        runId: expect.stringMatching(/^aos-recovered-/u),
      },
    })
  })

  it("requires the exact configured origin for state changes", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "updateAgentVisibility")

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/visibility`,
      {
        method: "PATCH",
        headers: {
          origin: "https://attacker.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          visibility: "hidden",
          observedRevision: "hermes-bots:1",
        }),
      }
    )

    expect(response.status).toBe(403)
    expect(runtime.updateAgentVisibility).not.toHaveBeenCalled()
  })

  it("validates runtime, Agent, and Session before signing an invitation", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "listAgents").mockResolvedValue({
      revision: "catalog-1",
      agents: [
        {
          summary: {
            id: "researcher",
            name: "Researcher",
            role: "agent",
          },
          visibility: "visible",
          editable: true,
          revision: "hermes-bots:1",
        },
      ],
    })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    const issue = vi.fn(async (grant) => ({ token: "guest.jwt", grant }))
    const invitations = {
      issue,
      verify: vi.fn(),
    } as unknown as GuestInvitationService
    const proxy = app(runtime, { guestInvitations: invitations })
    const grant = {
      principalId: "guest_recipient",
      invitationId: "invite_public",
      runtimeId: "hermes-main",
      agentId: "researcher",
      sessionId: "stored",
      operations: ["messages:read"],
      capabilities: ["message-text"],
    }

    const response = await proxy.request(
      `${origin}/api/aos/v1/guest-invitations`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(grant),
      }
    )

    expect(response.status).toBe(201)
    expect(issue).toHaveBeenCalledWith(grant)
    expect(runtime.getSession).toHaveBeenCalledWith("researcher", "stored")
  })

  it("streams the terminal assistant response over normalized AG-UI SSE", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    const engine: ServerRunEngine = {
      start: vi.fn(async (_scope, input) =>
        terminalHandle([
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "assistant-1",
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "assistant-1",
            delta: "Final response",
          },
          {
            type: EventType.TEXT_MESSAGE_END,
            messageId: "assistant-1",
          },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            outcome: { type: "success" },
          },
        ])
      ),
      recover: vi.fn(),
    }
    const input: RunAgentInput = {
      threadId: "stored",
      runId: "run-1",
      state: {},
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }

    const response = await app(runtime, { engine }).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/runs`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(input),
      }
    )
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain("TEXT_MESSAGE_CONTENT")
    expect(body).toContain("Final response")
    expect(body).toContain("RUN_FINISHED")
    expect(engine.start).toHaveBeenCalledOnce()
  })

  it("marks staged attachment runs so command-looking text remains a normal prompt", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    vi.spyOn(runtime, "stageAttachments").mockResolvedValue({
      public: [{ type: "file", filename: "notes.txt", mimeType: "text/plain" }],
      appendTo: (text) => `${text}\n\n[attachment]`,
      cleanup: vi.fn(async () => undefined),
    })
    const engine: ServerRunEngine = {
      start: vi.fn(async (_scope, input) =>
        terminalHandle([
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            outcome: { type: "success" },
          },
        ])
      ),
      recover: vi.fn(),
    }
    const proxy = app(runtime, { engine })
    const stage = await proxy.request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
      {
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
    )
    const { stageId } = (await stage.json()) as { stageId: string }

    const response = await proxy.request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/runs`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "stored",
          runId: "run-attachment",
          state: {},
          messages: [{ id: "user-1", role: "user", content: "/help" }],
          tools: [],
          context: [],
          forwardedProps: { aosAttachmentStageId: stageId },
        }),
      }
    )
    await response.text()

    expect(stage.status).toBe(201)
    expect(response.status).toBe(200)
    expect(engine.start).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttachments: true }),
      expect.anything()
    )
  })

  it.each([
    {
      name: "a recognized command rejected before delivery",
      terminal: {
        type: EventType.RUN_ERROR,
        message: "Slash commands cannot be sent with attachments.",
        code: "AOS_COMMAND_WITH_ATTACHMENTS",
      } as AGUIEvent,
      cleanupCount: 1,
    },
    {
      name: "an accepted prompt",
      terminal: {
        type: EventType.RUN_FINISHED,
        threadId: "stored",
        runId: "run-attachment-cleanup",
        outcome: { type: "success" },
      } as AGUIEvent,
      cleanupCount: 0,
    },
    {
      name: "an uncertain prompt",
      terminal: {
        type: EventType.RUN_ERROR,
        message: "Hermes delivery could not be confirmed.",
        code: "AOS_SEND_UNCERTAIN",
      } as AGUIEvent,
      cleanupCount: 0,
    },
  ])(
    "cleans a staged attachment only for $name",
    async ({ terminal, cleanupCount }) => {
      const runtime = new HermesServerAdapter({ request: vi.fn() })
      vi.spyOn(runtime, "getSession").mockResolvedValue(session())
      const cleanup = vi.fn(async () => undefined)
      vi.spyOn(runtime, "stageAttachments").mockResolvedValue({
        public: [
          { type: "file", filename: "notes.txt", mimeType: "text/plain" },
        ],
        appendTo: (text) => `${text}\n\n[attachment]`,
        cleanup,
      })
      const engine: ServerRunEngine = {
        start: vi.fn(async (_scope, input) =>
          terminalHandle([
            {
              type: EventType.RUN_STARTED,
              threadId: input.threadId,
              runId: input.runId,
            },
            terminal,
          ])
        ),
        recover: vi.fn(),
      }
      const proxy = app(runtime, { engine })
      const staged = await proxy.request(
        `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
        {
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
      )
      const { stageId } = (await staged.json()) as { stageId: string }

      const response = await proxy.request(
        `${origin}/api/aos/v1/agents/researcher/sessions/stored/runs`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "stored",
            runId: "run-attachment-cleanup",
            state: {},
            messages: [{ id: "user-1", role: "user", content: "/help" }],
            tools: [],
            context: [],
            forwardedProps: { aosAttachmentStageId: stageId },
          }),
        }
      )
      await response.text()

      expect(response.status).toBe(200)
      expect(cleanup).toHaveBeenCalledTimes(cleanupCount)
    }
  )

  it("loads only the requested Session history page", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    const history = vi.spyOn(runtime, "history").mockResolvedValue({
      sessionId: "stored",
      messages: [],
      total: 200,
      limit: 200,
      offset: 200,
      nextOffset: 200,
    })

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/history?limit=200&offset=200`
    )

    expect(response.status).toBe(200)
    expect(history).toHaveBeenCalledWith("researcher", "stored", 200, 200)
  })

  it("returns the runtime slash-command catalog for the requested Session", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    const slashCommands = vi.spyOn(runtime, "slashCommands").mockResolvedValue({
      commands: [{ name: "help", description: "Show help" }],
    })

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/commands`
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      commands: [{ name: "help", description: "Show help" }],
    })
    expect(slashCommands).toHaveBeenCalledWith("researcher", "stored")
  })

  it("restores a pending AG-UI interrupt in normalized assistant history metadata", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    vi.spyOn(runtime, "history").mockResolvedValue({
      sessionId: "stored",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
      nextOffset: 1,
    })
    const interrupt = {
      id: "question-1",
      reason: "question",
      message: "Which option?",
      responseSchema: { type: "string", enum: ["one", "two"] },
    }
    const engine: ServerRunEngine = {
      start: vi.fn(async (_scope, input) =>
        terminalHandle([
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            outcome: { type: "interrupt", interrupts: [interrupt] },
          },
        ])
      ),
      recover: vi.fn(),
    }
    const proxy = app(runtime, { engine })
    const run = await proxy.request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/runs`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "stored",
          runId: "run-1",
          state: {},
          messages: [{ id: "user-1", role: "user", content: "Ask" }],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      }
    )
    await run.text()

    const response = await proxy.request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/history?limit=200&offset=0`
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      execution: { status: "waiting-for-input", runId: "run-1" },
      messages: [
        {
          id: "assistant-1",
          status: { type: "requires-action", reason: "interrupt" },
          metadata: { custom: { agui: { interrupts: [interrupt] } } },
        },
      ],
    })
  })

  it("does not expose the replaced polling endpoints", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    const proxy = app(runtime)
    const base = `${origin}/api/aos/v1/agents/researcher/sessions/stored`

    for (const path of [
      "/workspace/todos",
      "/workspace/activity",
      "/interactions/pending",
      "/audio",
    ])
      expect((await proxy.request(`${base}${path}`)).status).toBe(404)
  })

  it.each([
    [new HermesAuthenticationError(), 401, "runtime_authentication_required"],
    [new HermesHttpError(503), 503, "temporarily_unavailable"],
  ])(
    "maps provider failures to friendly normalized errors",
    async (error, status, code) => {
      const transport: HermesRpcTransport = {
        request: vi.fn(async () => {
          throw error
        }),
      }
      const response = await app(new HermesServerAdapter(transport)).request(
        `${origin}/api/aos/v1/agents`
      )

      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({
        error: { code, description: expect.any(String) },
      })
    }
  )

  it("maps an owned Session miss to a friendly not-found response", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockRejectedValue(
      new HermesSessionNotFoundError()
    )

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored`
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
})
