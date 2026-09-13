// @vitest-environment node

import { EventType, type AGUIEvent } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import {
  createGuestInvitationServiceForTest,
  type GuestInvitationService,
} from "../auth/guest-invitation"
import { createReconnectCursorCodec } from "../events/cursor"
import {
  createGuestListenerService,
  type GuestListenerServiceOptions,
} from "./service"

const NOW = 1_700_000_000_000
const ORIGIN = "https://guest.example.test"
const agentId = "researcher"
const storedSessionId = "stored-session"
const sessionId = "hermes:researcher:stored-session"

function invitations(now = () => NOW, clockSkewSeconds = 0) {
  let sequence = 0
  return createGuestInvitationServiceForTest(
    {
      issuer: ORIGIN,
      audience: "aos-guest-listener",
      deploymentId: "deployment-a",
      keys: [{ id: "invite-key", secret: new Uint8Array(32).fill(7) }],
      now,
      ttlSeconds: 300,
      clockSkewSeconds,
    },
    (size) => new Uint8Array(size).fill(++sequence)
  )
}

function cursor(now = () => NOW / 1_000) {
  return createReconnectCursorCodec({
    activeKeyId: "cursor-key",
    keys: { "cursor-key": new Uint8Array(32).fill(8) },
    now,
  })
}

async function invitation(
  operations: readonly (
    | "artifacts:read"
    | "attachments:read"
    | "errors:read"
    | "messages:create"
    | "messages:read"
  )[] = ["messages:read"],
  overrides: {
    agentId?: string
    sessionId?: string | undefined
    invitationId?: string
    service?: GuestInvitationService
  } = {}
) {
  return (overrides.service ?? invitations()).issue({
    principalId: "guest_recipient",
    invitationId: overrides.invitationId ?? "invite_public",
    agentId: overrides.agentId ?? agentId,
    ...(overrides.sessionId === undefined && "sessionId" in overrides
      ? {}
      : { sessionId: overrides.sessionId ?? sessionId }),
    operations,
    capabilities: [
      "artifact-metadata",
      "attachment-metadata",
      "custom-ui",
      "message-text",
      "safe-errors",
    ],
  })
}

function requestHeaders(token: string, includeOrigin = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(includeOrigin ? { origin: ORIGIN } : {}),
  }
}

function eventStream(...values: AGUIEvent[]): AsyncIterable<AGUIEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value
    },
  }
}

function pendingEventStream(): AsyncIterable<AGUIEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<AGUIEvent>>(() => undefined),
      }
    },
  }
}

function runHandle(events: AsyncIterable<AGUIEvent>) {
  return {
    events,
    stop: vi.fn(async () => "idle" as const),
    disconnect: vi.fn(),
    recoveryPosition: vi.fn(() => ({
      epoch: "native-epoch-secret",
      lastSeen: 42,
    })),
  }
}

function harness(
  overrides: {
    runs?: NonNullable<GuestListenerServiceOptions["runs"]>
    content?: NonNullable<GuestListenerServiceOptions["content"]>
    schedule?: (delayMs: number, task: () => void) => unknown
    cancel?: (timer: unknown) => void
    invitationService?: GuestInvitationService
    now?: () => number
  } = {}
) {
  const getSession = vi.fn(async () => ({
    id: sessionId,
    agentId,
    title: "Research",
    archived: false,
    updatedAt: "2026-09-12T12:00:00.000Z",
    status: "idle" as const,
  }))
  const history = vi.fn(async () => ({
    sessionId,
    messages: [
      {
        id: "message-user",
        role: "user" as const,
        content: [{ type: "text" as const, text: "Question" }],
        createdAt: "2026-09-12T11:59:00.000Z",
      },
      {
        id: "message-assistant",
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Safe answer" },
          { type: "reasoning" as const, text: "Bearer operator-secret" },
          {
            type: "tool-call" as const,
            toolCallId: "tool-secret",
            toolName: "read",
            args: { path: "/srv/operator/private" },
            argsText: '{"path":"/srv/operator/private"}',
            result: { token: "operator-secret" },
          },
        ],
        createdAt: "2026-09-12T12:00:00.000Z",
      },
      {
        id: "message-system",
        role: "system" as const,
        content: [{ type: "text" as const, text: "system prompt secret" }],
        createdAt: "2026-09-12T11:58:00.000Z",
      },
    ],
    total: 3,
    limit: 200,
    offset: 0,
    nextOffset: 3,
  }))
  const slashCommands = vi.fn(async () => ({
    commands: [{ name: "help", description: "Show help" }],
  }))
  const hermes = {
    getSession,
    history,
    slashCommands,
    resume: vi.fn(async () => ({ liveSessionId: "live-secret" })),
    observe: vi.fn(async () => () => undefined),
    recover: vi.fn(async () => ({
      epoch: "native-epoch-secret",
      lastSeen: 0,
      events: [],
    })),
    submit: vi.fn(async () => ({ acknowledgement: "accepted" as const })),
    interrupt: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
  }
  const service = createGuestListenerService({
    publicOrigin: ORIGIN,
    deploymentId: "deployment-a",
    bootEpoch: "boot-a",
    invitations: overrides.invitationService ?? invitations(),
    cursor: cursor(),
    hermes,
    ...(overrides.runs === undefined ? {} : { runs: overrides.runs }),
    ...(overrides.content === undefined ? {} : { content: overrides.content }),
    ...(overrides.schedule === undefined
      ? {}
      : { schedule: overrides.schedule }),
    ...(overrides.cancel === undefined ? {} : { cancel: overrides.cancel }),
    now: overrides.now ?? (() => NOW),
  })
  return { service, hermes }
}

describe("Hermes guest listener", () => {
  it("cancels a chunked run body as soon as it exceeds the request limit", async () => {
    const runs = {
      start: vi.fn(),
      reconnect: vi.fn(),
    }
    const { service } = harness({ runs })
    const issued = await invitation([
      "errors:read",
      "messages:create",
      "messages:read",
    ])
    const route = `${ORIGIN}/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/runs`
    let pulls = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(1_100_000))
            return
          }
          if (pulls === 2) {
            controller.enqueue(Uint8Array.of(1))
            return
          }
          controller.close()
        },
        cancel,
      },
      { highWaterMark: 0 }
    )

    const outcome = await service.app.fetch(
      new Request(route, {
        method: "POST",
        headers: {
          ...requestHeaders(issued.token, true),
          "content-type": "application/json",
          "content-length": "1",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    )

    expect(outcome).toBeInstanceOf(Response)
    expect((outcome as Response).status).toBe(400)
    expect(cancel).toHaveBeenCalledOnce()
    expect(pulls).toBe(2)
    expect(runs.start).not.toHaveBeenCalled()
  })

  it("uses the invitation service's configured clock-skew expiry", async () => {
    const issuer = invitations(() => NOW, 10)
    const verifier = invitations(() => NOW + 305_000, 10)
    const issued = await invitation(
      ["errors:read", "messages:create", "messages:read"],
      { service: issuer }
    )
    const runs = {
      start: vi.fn(async () => runHandle(pendingEventStream())),
      reconnect: vi.fn(),
    }
    const { service, hermes } = harness({
      runs,
      invitationService: verifier,
      now: () => NOW + 305_000,
    })
    const base = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}`

    const history = await service.app.request(`${base}/history`, {
      headers: requestHeaders(issued.token),
    })
    const run = await service.app.request(`${base}/runs`, {
      method: "POST",
      headers: {
        ...requestHeaders(issued.token, true),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        threadId: sessionId,
        runId: "run-expired",
        state: {},
        messages: [{ id: "guest-message", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    })

    expect(history.status).toBe(200)
    expect(run.status).toBe(200)
    expect(hermes.history).toHaveBeenCalledOnce()
    expect(hermes.getSession).toHaveBeenCalledOnce()
    expect(runs.start).toHaveBeenCalledOnce()
  })

  it("serves only projected history for the invitation's exact Agent and Session", async () => {
    const { service, hermes } = harness()
    const issued = await invitation()
    const url = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/history`

    const response = await service.app.request(url, {
      headers: requestHeaders(issued.token),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessionId,
      messages: [
        {
          id: "message-user",
          role: "user",
          content: [{ type: "text", text: "Question" }],
          createdAt: "2026-09-12T11:59:00.000Z",
        },
        {
          id: "message-assistant",
          role: "assistant",
          content: [{ type: "text", text: "Safe answer" }],
          createdAt: "2026-09-12T12:00:00.000Z",
        },
      ],
      total: 3,
      limit: 200,
      offset: 0,
      nextOffset: 3,
    })
    expect(hermes.history).toHaveBeenCalledWith(
      agentId,
      storedSessionId,
      200,
      0
    )
    const operatorCredentialAttempt = await service.app.request(url, {
      headers: {
        cookie: "__Host-aos-session=operator-secret",
        "x-hermes-token": "operator-secret",
      },
    })
    expect(await operatorCredentialAttempt.text()).not.toContain(
      "operator-secret"
    )

    const wrongSession = await service.app.request(
      `/api/guest/v1/agents/${agentId}/sessions/hermes%3Aresearcher%3Aother/history`,
      { headers: requestHeaders(issued.token) }
    )
    const wrongAgent = await service.app.request(
      `/api/guest/v1/agents/other/sessions/${encodeURIComponent(sessionId)}/history`,
      { headers: requestHeaders(issued.token) }
    )
    const agentOnly = await invitation(["messages:read"], {
      sessionId: undefined,
    })
    const unboundSession = await service.app.request(url, {
      headers: requestHeaders(agentOnly.token),
    })
    const operatorRoute = await service.app.request("/api/aos/v1/agents", {
      headers: requestHeaders(issued.token),
    })
    const nativeRoute = await service.app.request("/hermes/api/sessions", {
      headers: requestHeaders(issued.token),
    })

    expect(wrongSession.status).toBe(401)
    expect(wrongAgent.status).toBe(401)
    expect(unboundSession.status).toBe(401)
    expect(operatorRoute.status).toBe(404)
    expect(nativeRoute.status).toBe(404)
    expect(hermes.history).toHaveBeenCalledTimes(1)
  })

  it("serves slash commands only for an invitation's exact Agent and Session", async () => {
    const { service, hermes } = harness()
    const issued = await invitation()
    const route = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/commands`

    const response = await service.app.request(route, {
      headers: requestHeaders(issued.token),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      commands: [{ name: "help", description: "Show help" }],
    })
    expect(hermes.slashCommands).toHaveBeenCalledWith(agentId, sessionId)

    const wrongSession = await service.app.request(
      `/api/guest/v1/agents/${agentId}/sessions/hermes%3Aresearcher%3Aother/commands`,
      { headers: requestHeaders(issued.token) }
    )
    const wrongAgent = await service.app.request(
      `/api/guest/v1/agents/other/sessions/${encodeURIComponent(sessionId)}/commands`,
      { headers: requestHeaders(issued.token) }
    )
    const agentOnly = await invitation(["messages:read"], {
      sessionId: undefined,
    })
    const unboundSession = await service.app.request(route, {
      headers: requestHeaders(agentOnly.token),
    })

    expect(wrongSession.status).toBe(401)
    expect(wrongAgent.status).toBe(401)
    expect(unboundSession.status).toBe(401)
    expect(hermes.slashCommands).toHaveBeenCalledTimes(1)
  })

  it("projects AG-UI runs and reconnects without exposing native positions", async () => {
    const first = runHandle(
      eventStream(
        { type: EventType.RUN_STARTED, threadId: sessionId, runId: "run-1" },
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "reasoning-private",
          role: "reasoning",
        },
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "reasoning-private",
          delta: "Bearer operator-secret /srv/operator/private",
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "message-assistant",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "message-assistant",
          delta: "Guest-visible answer",
        },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool-private",
          toolCallName: "read_private_file",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "message-assistant",
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: sessionId,
          runId: "run-1",
          result: {
            token: "operator-secret",
            nativePosition: 42,
          },
        }
      )
    )
    const reconnected = runHandle(
      eventStream(
        { type: EventType.RUN_STARTED, threadId: sessionId, runId: "run-1" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "message-reconnected",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "message-reconnected",
          delta: "After reconnect",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "message-reconnected",
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: sessionId,
          runId: "run-1",
        }
      )
    )
    const runs = {
      start: vi.fn(async () => first),
      reconnect: vi.fn(async () => reconnected),
    }
    const { service } = harness({ runs })
    const issued = await invitation([
      "errors:read",
      "messages:create",
      "messages:read",
    ])
    const route = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/runs`
    const input = {
      threadId: sessionId,
      runId: "run-1",
      state: {},
      messages: [{ id: "guest-message", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }

    const response = await service.app.request(route, {
      method: "POST",
      headers: {
        ...requestHeaders(issued.token, true),
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    })
    const stream = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(stream).toContain("Guest-visible answer")
    expect(stream).not.toContain("operator-secret")
    expect(stream).not.toContain("/srv/operator/private")
    expect(stream).not.toContain("reasoning-private")
    expect(stream).not.toContain("tool-private")
    expect(stream).not.toContain("nativePosition")
    expect(stream).not.toContain("native-epoch-secret")
    expect(runs.start).toHaveBeenCalledWith(
      { agentId, sessionId: storedSessionId, threadId: sessionId },
      input
    )

    const active = runHandle(pendingEventStream())
    runs.start.mockResolvedValueOnce(active)
    const activeResponse = await service.app.request(route, {
      method: "POST",
      headers: {
        ...requestHeaders(issued.token, true),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...input, runId: "run-active" }),
    })
    expect(activeResponse.status).toBe(200)

    const reconnect = await service.app.request(`${route}/reconnect`, {
      method: "POST",
      headers: {
        ...requestHeaders(issued.token, true),
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId: sessionId, runId: "run-active" }),
    })
    const reconnectStream = await reconnect.text()

    expect(reconnect.status).toBe(200)
    expect(active.disconnect).toHaveBeenCalledOnce()
    expect(active.recoveryPosition).toHaveBeenCalledOnce()
    expect(runs.reconnect).toHaveBeenCalledWith(
      { agentId, sessionId: storedSessionId, threadId: sessionId },
      {
        threadId: sessionId,
        runId: "run-active",
        position: { epoch: "native-epoch-secret", lastSeen: 42 },
      }
    )
    expect(reconnectStream).toContain("After reconnect")
    expect(reconnectStream).not.toContain("native-epoch-secret")
  })

  it("preserves an interrupted guest run so the normalized client can reconnect", async () => {
    const interrupted = runHandle(
      eventStream(
        { type: EventType.RUN_STARTED, threadId: sessionId, runId: "run-1" },
        {
          type: EventType.RUN_ERROR,
          code: "AOS_CONNECTION_INTERRUPTED",
          message: "Bearer operator-secret at /srv/hermes/private",
        }
      )
    )
    const recovered = runHandle(
      eventStream(
        { type: EventType.RUN_STARTED, threadId: sessionId, runId: "run-1" },
        {
          type: EventType.RUN_FINISHED,
          threadId: sessionId,
          runId: "run-1",
        }
      )
    )
    const runs = {
      start: vi.fn(async () => interrupted),
      reconnect: vi.fn(async () => recovered),
    }
    const { service } = harness({ runs })
    const issued = await invitation([
      "errors:read",
      "messages:create",
      "messages:read",
    ])
    const route = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/runs`
    const headers = {
      ...requestHeaders(issued.token, true),
      "content-type": "application/json",
    }
    const input = {
      threadId: sessionId,
      runId: "run-1",
      state: {},
      messages: [{ id: "guest-message", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }

    const response = await service.app.request(route, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    })
    const stream = await response.text()

    expect(stream).toContain('"code":"AOS_CONNECTION_INTERRUPTED"')
    expect(stream).not.toContain("operator-secret")
    expect(stream).not.toContain("/srv/hermes/private")

    const reconnect = await service.app.request(`${route}/reconnect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: sessionId, runId: "run-1" }),
    })

    expect(reconnect.status).toBe(200)
    expect(runs.reconnect).toHaveBeenCalledOnce()
  })

  it("keeps an uncertain guest send fenced for authoritative reconciliation", async () => {
    const uncertain = runHandle(
      eventStream(
        { type: EventType.RUN_STARTED, threadId: sessionId, runId: "run-1" },
        {
          type: EventType.RUN_ERROR,
          code: "AOS_SEND_UNCERTAIN",
          message: "Native request leaked operator-secret",
        }
      )
    )
    const runs = {
      start: vi.fn(async () => uncertain),
      reconnect: vi.fn(),
    }
    const { service } = harness({ runs })
    const issued = await invitation([
      "errors:read",
      "messages:create",
      "messages:read",
    ])
    const route = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/runs`
    const headers = {
      ...requestHeaders(issued.token, true),
      "content-type": "application/json",
    }
    const input = {
      threadId: sessionId,
      runId: "run-1",
      state: {},
      messages: [{ id: "guest-message", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }

    const response = await service.app.request(route, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    })
    const stream = await response.text()

    expect(stream).toContain('"code":"AOS_SEND_UNCERTAIN"')
    expect(stream).not.toContain("operator-secret")

    const duplicate = await service.app.request(route, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input, runId: "run-2" }),
    })

    expect(duplicate.status).toBe(409)
    expect(runs.start).toHaveBeenCalledOnce()
  })

  it("requires exact operations and same-origin authorization for send and Stop", async () => {
    const active = runHandle(pendingEventStream())
    const runs = {
      start: vi.fn(async () => active),
      reconnect: vi.fn(),
    }
    const { service } = harness({ runs })
    const full = await invitation([
      "errors:read",
      "messages:create",
      "messages:read",
    ])
    const readOnly = await invitation(["messages:read"])
    const route = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/runs`
    const body = JSON.stringify({
      threadId: sessionId,
      runId: "run-stop",
      state: {},
      messages: [{ id: "guest-message", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    const readOnlyResponse = await service.app.request(route, {
      method: "POST",
      headers: {
        ...requestHeaders(readOnly.token, true),
        "content-type": "application/json",
      },
      body,
    })
    const crossOrigin = await service.app.request(route, {
      method: "POST",
      headers: {
        ...requestHeaders(full.token),
        origin: "https://attacker.example.test",
        "content-type": "application/json",
      },
      body,
    })

    expect(readOnlyResponse.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(runs.start).not.toHaveBeenCalled()

    const started = await service.app.request(route, {
      method: "POST",
      headers: {
        ...requestHeaders(full.token, true),
        "content-type": "application/json",
      },
      body,
    })
    expect(started.status).toBe(200)

    const stopped = await service.app.request(`${route}/stop`, {
      method: "POST",
      headers: requestHeaders(full.token, true),
    })

    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ status: "idle" })
    expect(active.stop).toHaveBeenCalledOnce()
  })

  it("disconnects an active AG-UI run when its invitation expires", async () => {
    let expire: (() => void) | undefined
    const schedule = vi.fn((_delayMs: number, task: () => void) => {
      expire = task
      return { timer: true }
    })
    const active = runHandle(pendingEventStream())
    const { service } = harness({
      runs: {
        start: vi.fn(async () => active),
        reconnect: vi.fn(),
      },
      schedule,
      cancel: vi.fn(),
    })
    const issued = await invitation([
      "errors:read",
      "messages:create",
      "messages:read",
    ])
    const route = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/runs`
    const response = await service.app.request(route, {
      method: "POST",
      headers: {
        ...requestHeaders(issued.token, true),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        threadId: sessionId,
        runId: "run-expiring",
        state: {},
        messages: [{ id: "guest-message", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    })

    expect(response.status).toBe(200)
    expect(schedule).toHaveBeenCalledWith(300_000, expect.any(Function))
    expire?.()
    expect(active.disconnect).toHaveBeenCalledOnce()

    const stopped = await service.app.request(`${route}/stop`, {
      method: "POST",
      headers: requestHeaders(issued.token, true),
    })
    expect(stopped.status).toBe(404)
    expect(active.stop).not.toHaveBeenCalled()
  })

  it("does not let a second same-Session invitation reconnect or Stop an active run", async () => {
    const invitationService = invitations()
    const first = await invitation(
      ["errors:read", "messages:create", "messages:read"],
      { service: invitationService }
    )
    const second = await invitation(
      ["errors:read", "messages:create", "messages:read"],
      { service: invitationService }
    )
    const active = runHandle(pendingEventStream())
    const runs = {
      start: vi.fn(async () => active),
      reconnect: vi.fn(async () => runHandle(eventStream())),
    }
    const { service } = harness({ runs, invitationService })
    const route = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}/runs`
    const start = await service.app.request(route, {
      method: "POST",
      headers: {
        ...requestHeaders(first.token, true),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        threadId: sessionId,
        runId: "run-bound",
        state: {},
        messages: [{ id: "guest-message", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    })
    expect(start.status).toBe(200)

    const foreignReconnect = await service.app.request(`${route}/reconnect`, {
      method: "POST",
      headers: {
        ...requestHeaders(second.token, true),
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId: sessionId, runId: "run-bound" }),
    })
    const foreignStop = await service.app.request(`${route}/stop`, {
      method: "POST",
      headers: requestHeaders(second.token, true),
    })

    expect(foreignReconnect.status).toBe(404)
    expect(foreignStop.status).toBe(404)
    expect(active.disconnect).not.toHaveBeenCalled()
    expect(active.recoveryPosition).not.toHaveBeenCalled()
    expect(active.stop).not.toHaveBeenCalled()
    expect(runs.reconnect).not.toHaveBeenCalled()

    const ownerStop = await service.app.request(`${route}/stop`, {
      method: "POST",
      headers: requestHeaders(first.token, true),
    })
    expect(ownerStop.status).toBe(200)
    expect(active.stop).toHaveBeenCalledOnce()
  })

  it("serves authorized artifacts and projects provider failures to code-only errors", async () => {
    const artifact = vi.fn(async () => ({
      bytes: new TextEncoder().encode("public artifact"),
      mimeType: "text/markdown",
      filename: "report.md",
      nativePath: "/srv/hermes/operator-secret",
    }))
    const { service, hermes } = harness({ content: { artifact } })
    const artifactGrant = await invitation(["artifacts:read"])
    const errorGrant = await invitation(["errors:read", "messages:read"])
    const base = `/api/guest/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionId)}`

    const response = await service.app.request(`${base}/artifacts/artifact-1`, {
      headers: requestHeaders(artifactGrant.token),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/markdown")
    expect(response.headers.get("content-length")).toBe("15")
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''report.md"
    )
    expect(await response.text()).toBe("public artifact")
    expect(artifact).toHaveBeenCalledWith(agentId, sessionId, "artifact-1")
    expect(
      [
        response.headers.get("content-type"),
        response.headers.get("content-length"),
        response.headers.get("content-disposition"),
      ].join(" ")
    ).not.toContain("/srv/hermes")

    hermes.history.mockRejectedValueOnce(
      new Error(
        "Bearer operator-secret at https://hermes.internal /srv/hermes/private"
      )
    )
    const failure = await service.app.request(`${base}/history`, {
      headers: requestHeaders(errorGrant.token),
    })

    expect(failure.status).toBe(503)
    const failureBody = await failure.json()
    expect(failureBody).toEqual({
      transport: "error",
      agentId,
      sessionId,
      payload: {
        type: "error",
        code: "temporarily_unavailable",
        retryable: true,
      },
    })
    expect(JSON.stringify(failureBody)).not.toContain("operator-secret")

    const missingOperation = await service.app.request(
      `${base}/artifacts/artifact-1`,
      { headers: requestHeaders(errorGrant.token) }
    )
    expect(missingOperation.status).toBe(401)
    expect(artifact).toHaveBeenCalledTimes(1)
  })

  it("binds WebSocket observation and reconnect cursors to the expiring invitation", async () => {
    let expiry: (() => void) | undefined
    const schedule = vi.fn((_delayMs: number, task: () => void) => {
      expiry = task
      return { timer: true }
    })
    const cancel = vi.fn()
    const { service, hermes } = harness({ schedule, cancel })
    const issued = await invitation(["messages:read"])
    const query = new URLSearchParams({ agentId, sessionId })
    const upgradeRequest = new Request(
      `${ORIGIN}/api/guest/v1/events?${query}`,
      { headers: requestHeaders(issued.token, true) }
    )

    const upgrade = await service.authorizeEventUpgrade(upgradeRequest)

    expect(upgrade).toMatchObject({
      invitationId: "invite_public",
      agentId,
      sessionId,
      expiresAt: NOW + 300_000,
    })
    expect(JSON.stringify(upgrade)).not.toContain(issued.token)
    const frames: unknown[] = []
    const close = vi.fn()
    const socket = service.openEvents(upgrade!, {
      send: (raw) => frames.push(JSON.parse(raw)),
      close,
    })
    await socket.receive(
      JSON.stringify({
        type: "aos.subscribe",
        streamId: "stream-guest",
        scope: { workspaceId: "guest", agentId, sessionId },
      })
    )

    expect(hermes.getSession).toHaveBeenCalledWith(agentId, storedSessionId)
    expect(hermes.resume).toHaveBeenCalledWith({
      agentId,
      sessionId: storedSessionId,
      threadId: sessionId,
    })
    expect(hermes.observe).toHaveBeenCalledWith(
      "live-secret",
      expect.any(Function),
      expect.any(Function)
    )
    expect(frames).toMatchObject([
      {
        type: "aos.ready",
        streamId: "stream-guest",
        scope: { workspaceId: "guest", agentId, sessionId },
        read: "authoritative",
        cursor: expect.any(String),
      },
    ])
    expect(JSON.stringify(frames)).not.toContain("live-secret")
    expect(JSON.stringify(frames)).not.toContain(issued.token)
    expect(schedule).toHaveBeenCalledWith(300_000, expect.any(Function))

    expiry?.()
    expect(frames).toContainEqual({
      type: "aos.error",
      version: 1,
      streamId: "stream-guest",
      code: "authorization_expired",
    })
    expect(close).toHaveBeenCalledWith(4401, "Authorization expired")

    await expect(
      service.authorizeEventUpgrade(
        new Request(`${ORIGIN}/api/guest/v1/events?${query}`, {
          headers: {
            ...requestHeaders(issued.token),
            origin: "https://attacker.example.test",
          },
        })
      )
    ).resolves.toBeUndefined()
    await expect(
      service.authorizeEventUpgrade(
        new Request(
          `${ORIGIN}/api/guest/v1/events?agentId=${agentId}&sessionId=hermes%3Aresearcher%3Aother`,
          { headers: requestHeaders(issued.token, true) }
        )
      )
    ).resolves.toBeUndefined()
  })

  it("exchanges bearer authorization for a browser-safe guest WebSocket cookie", async () => {
    const { service } = harness()
    const issued = await invitation(["messages:read"])
    const query = new URLSearchParams({ agentId, sessionId })

    const exchange = await service.app.request(
      `/api/guest/v1/events/authorize?${query}`,
      {
        method: "POST",
        headers: requestHeaders(issued.token, true),
      }
    )

    expect(exchange.status).toBe(204)
    const setCookie = exchange.headers.get("set-cookie")
    expect(setCookie).toMatch(
      /^__Host-aos-guest-events=[^;]+; Path=\/; Max-Age=60; Secure; HttpOnly; SameSite=Strict$/u
    )
    expect(setCookie).toContain(issued.token)
    const cookie = setCookie!.split(";", 1)[0]
    const upgrade = await service.authorizeEventUpgrade(
      new Request(`${ORIGIN}/api/guest/v1/events?${query}`, {
        headers: { origin: ORIGIN, cookie },
      })
    )

    expect(upgrade).toMatchObject({
      invitationId: "invite_public",
      agentId,
      sessionId,
      expiresAt: NOW + 300_000,
    })
    expect(JSON.stringify(upgrade)).not.toContain(issued.token)
  })

  it("forces authoritative reconciliation for a cursor from another invitation", async () => {
    const { service } = harness({
      schedule: () => ({ timer: true }),
      cancel: () => undefined,
    })
    const first = await invitation(["messages:read"])
    const second = await invitation(["messages:read"], {
      invitationId: "invite_other",
    })
    const query = new URLSearchParams({ agentId, sessionId })
    const upgradeFor = (token: string) =>
      service.authorizeEventUpgrade(
        new Request(`${ORIGIN}/api/guest/v1/events?${query}`, {
          headers: requestHeaders(token, true),
        })
      )
    const firstUpgrade = await upgradeFor(first.token)
    const firstFrames: Array<{ cursor?: string }> = []
    const firstSocket = service.openEvents(firstUpgrade!, {
      send: (raw) => firstFrames.push(JSON.parse(raw)),
      close: vi.fn(),
    })
    const subscription = {
      type: "aos.subscribe",
      streamId: "stream-shared",
      scope: { workspaceId: "guest", agentId, sessionId },
    }
    await firstSocket.receive(JSON.stringify(subscription))
    const invitationBoundCursor = firstFrames[0]?.cursor
    expect(invitationBoundCursor).toEqual(expect.any(String))

    const secondUpgrade = await upgradeFor(second.token)
    const secondFrames: Array<{ type: string; reason?: string }> = []
    const secondSocket = service.openEvents(secondUpgrade!, {
      send: (raw) => secondFrames.push(JSON.parse(raw)),
      close: vi.fn(),
    })
    await secondSocket.receive(
      JSON.stringify({ ...subscription, cursor: invitationBoundCursor })
    )

    expect(secondFrames.map(({ type }) => type)).toEqual([
      "aos.ready",
      "aos.reset",
    ])
    expect(secondFrames[1]).toMatchObject({ reason: "reconcile_required" })
  })
})
