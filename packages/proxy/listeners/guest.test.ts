// @vitest-environment node

import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import { HermesServerAdapter } from "../adapters/hermes/adapter"
import {
  createGuestInvitationServiceForTest,
  type GuestInvitationService,
  type GuestOperation,
} from "../auth/guest-invitation"
import type {
  RuntimeInstance,
  ServerRunEngine,
  ServerRunHandle,
  ServerRuntime,
  SessionScope,
} from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"
import { createReconnectCursorCodec } from "../events/cursor"
import { createGuestListenerService } from "./guest"

const NOW = 1_700_000_000_000
const ORIGIN = "https://guest.example.test"
const runtimeId = "hermes-primary"
const agentId = "researcher"
const sessionId = "session-1"
const scope: SessionScope = { agentId, sessionId, threadId: sessionId }

class EventSource implements ServerRunHandle {
  readonly #values: AGUIEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<AGUIEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve
    })
  }

  readonly events: AsyncIterable<AGUIEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ done: false, value })
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }),
  }

  emit(event: AGUIEvent) {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.#values.push(event)
  }

  finish() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined })
    this.#resolveSettled()
  }

  recoveryPosition() {
    return { epoch: "native-secret-epoch", lastSeen: 42 }
  }
}

function invitations(now: () => number = () => NOW) {
  let sequence = 0
  return createGuestInvitationServiceForTest(
    {
      issuer: ORIGIN,
      audience: "aos-guest-listener",
      deploymentId: "deployment-a",
      keys: [{ id: "invite-key", secret: new Uint8Array(32).fill(7) }],
      now,
      ttlSeconds: 300,
      clockSkewSeconds: 0,
    },
    (size) => new Uint8Array(size).fill(++sequence)
  )
}

function cursor(now: () => number = () => NOW / 1_000) {
  return createReconnectCursorCodec({
    activeKeyId: "cursor-key",
    keys: { "cursor-key": new Uint8Array(32).fill(8) },
    now,
  })
}

async function issue(
  service: GuestInvitationService,
  operations: readonly GuestOperation[],
  overrides: { runtimeId?: string; agentId?: string; sessionId?: string } = {}
) {
  return service.issue({
    principalId: "guest_recipient",
    invitationId: "invite_public",
    runtimeId: overrides.runtimeId ?? runtimeId,
    agentId: overrides.agentId ?? agentId,
    sessionId: overrides.sessionId ?? sessionId,
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

function requestHeaders(token: string) {
  return { authorization: `Bearer ${token}`, origin: ORIGIN }
}

function runInput(runId = "run-1"): RunAgentInput {
  return {
    threadId: sessionId,
    runId,
    state: { browserState: "ignored" },
    messages: [{ id: "message-1", role: "user", content: "Hello" }],
    tools: [{ name: "private", description: "private", parameters: {} }],
    context: [{ description: "private", value: "private" }],
    forwardedProps: { providerToken: "private" },
  }
}

function harness(
  options: {
    now?: () => number
    invitationService?: GuestInvitationService
    sources?: EventSource[]
    maxSubscriberBytes?: number
    schedule?: (delayMs: number, task: () => void) => unknown
    cancel?: (timer: unknown) => void
    maxEventPeers?: number
    maxEventPeersPerInvitation?: number
  } = {}
) {
  const sources = options.sources ?? [new EventSource()]
  let sourceIndex = 0
  const engine: ServerRunEngine = {
    start: vi.fn(async () => sources[sourceIndex++] ?? new EventSource()),
    recover: vi.fn(async () => sources[sourceIndex++] ?? new EventSource()),
  }
  const sessions = new SessionCoordinator({
    engine,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 4,
    maxSubscriberEvents: 16,
    maxSubscriberBytes: options.maxSubscriberBytes ?? 64 * 1024,
    maxReplayEvents: 32,
    maxReplayBytes: 512 * 1024,
  })
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
          { type: "reasoning" as const, text: "Bearer native-secret" },
        ],
        createdAt: "2026-09-12T12:00:00.000Z",
      },
    ],
    total: 2,
    limit: 200,
    offset: 0,
    nextOffset: 2,
  }))
  const capabilityAdapter = new HermesServerAdapter({ request: vi.fn() })
  vi.spyOn(capabilityAdapter, "slashCommands").mockResolvedValue([
    { name: "help", description: "Show help" },
  ])
  const workspaceCapabilities = vi.fn(
    async (requestedAgentId: string, requestedSessionId: string) =>
      capabilityAdapter.workspaceCapabilities(
        requestedAgentId,
        requestedSessionId
      )
  )
  let invalidate: (() => void) | undefined
  const subscribeSessionInvalidation = vi.fn(
    async (
      _agentId: string,
      _publicSessionId: string,
      listener: () => void,
      resetListener?: () => void
    ) => {
      void resetListener
      invalidate = listener
      return vi.fn()
    }
  )
  const runtime = {
    runs: engine,
    resolveSessionId: vi.fn((requestedAgent: string, publicId: string) =>
      requestedAgent === agentId && publicId === sessionId
        ? sessionId
        : undefined
    ),
    publicError: vi.fn(() => undefined),
    getSession,
    history,
    workspaceCapabilities,
    artifact: vi.fn(async () => ({
      bytes: new TextEncoder().encode("public artifact"),
      mimeType: "text/plain",
      filename: "report.txt",
    })),
    subscribeSessionInvalidation,
  } as unknown as ServerRuntime
  const instance: RuntimeInstance = {
    id: runtimeId,
    runtime,
    sessions,
    close: vi.fn(async () => undefined),
  }
  const invitationService =
    options.invitationService ?? invitations(options.now)
  const service = createGuestListenerService({
    publicOrigin: ORIGIN,
    deploymentId: "deployment-a",
    bootEpoch: "boot-a",
    runtime: instance,
    invitations: invitationService,
    cursor: cursor(),
    now: options.now ?? (() => NOW),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.cancel ? { cancel: options.cancel } : {}),
    ...(options.maxEventPeers ? { maxEventPeers: options.maxEventPeers } : {}),
    ...(options.maxEventPeersPerInvitation
      ? { maxEventPeersPerInvitation: options.maxEventPeersPerInvitation }
      : {}),
  })
  return {
    service,
    sessions,
    engine,
    runtime,
    invitationService,
    invalidate: () => invalidate?.(),
  }
}

function runRoute(path = "runs") {
  return `/api/guest/v1/agents/${agentId}/sessions/${sessionId}/${path}`
}

async function postRun(
  service: ReturnType<typeof createGuestListenerService>,
  token: string,
  input: unknown
) {
  return service.app.request(runRoute(), {
    method: "POST",
    headers: {
      ...requestHeaders(token),
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  })
}

describe("shared-runtime guest listener", () => {
  it("subscribes to the shared coordinator and projects before its bounded guest queue", async () => {
    const source = new EventSource()
    const harnessed = harness({ sources: [source], maxSubscriberBytes: 512 })
    const input = runInput()
    await harnessed.sessions.start(
      scope,
      {
        threadId: input.threadId,
        runId: input.runId,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
        messages: input.messages,
      },
      {
        subscriberId: "operator-browser",
        controllerId: "operator",
        lane: "operator",
        canControl: true,
      }
    )
    const granted = await issue(harnessed.invitationService, [
      "errors:read",
      "messages:create",
      "messages:read",
    ])

    const response = await postRun(harnessed.service, granted.token, input)
    const bodyPromise = response.text()
    source.emit({
      type: EventType.RUN_STARTED,
      threadId: sessionId,
      runId: "run-1",
    })
    source.emit({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "reasoning-private",
      delta: `Bearer native-secret ${"x".repeat(2_000)}`,
    })
    source.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "live-private-message",
      role: "assistant",
    })
    source.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "live-private-message",
      delta: "Guest-visible answer",
    })
    source.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "live-private-message",
    })
    source.emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: "private-tool",
      toolCallName: "/srv/hermes/private",
    })
    source.emit({
      type: EventType.RUN_FINISHED,
      threadId: sessionId,
      runId: "run-1",
      outcome: { type: "success" },
      result: { liveId: "live-private", nativePosition: 42 },
    })
    source.finish()

    const body = await bodyPromise
    expect(response.status).toBe(200)
    expect(body).toContain("Guest-visible answer")
    expect(harnessed.engine.start).toHaveBeenCalledOnce()
    expect(body).not.toMatch(
      /native-secret|reasoning-private|private-tool|nativePosition|live-private|providerToken/
    )
  })

  it("denies cross-runtime, cross-Agent, and cross-Session access before runtime calls", async () => {
    const harnessed = harness()
    const wrongRuntime = await issue(
      harnessed.invitationService,
      ["messages:read"],
      { runtimeId: "hermes-secondary" }
    )
    const exact = await issue(harnessed.invitationService, ["messages:read"])
    const history = `/api/guest/v1/agents/${agentId}/sessions/${sessionId}/history`

    const outcomes = await Promise.all([
      harnessed.service.app.request(history, {
        headers: requestHeaders(wrongRuntime.token),
      }),
      harnessed.service.app.request(
        `/api/guest/v1/agents/other/sessions/${sessionId}/history`,
        { headers: requestHeaders(exact.token) }
      ),
      harnessed.service.app.request(
        `/api/guest/v1/agents/${agentId}/sessions/other/history`,
        { headers: requestHeaders(exact.token) }
      ),
    ])

    expect(outcomes.map(({ status }) => status)).toEqual([401, 401, 401])
    expect(harnessed.runtime.history).not.toHaveBeenCalled()
    expect(harnessed.runtime.getSession).not.toHaveBeenCalled()
  })

  it("includes commands in capabilities for the exact invited Session", async () => {
    const harnessed = harness()
    const exact = await issue(harnessed.invitationService, ["messages:read"])
    const path = runRoute("workspace/capabilities")

    const response = await harnessed.service.app.request(path, {
      headers: requestHeaders(exact.token),
    })
    const insufficient = await issue(harnessed.invitationService, [
      "messages:create",
    ])
    const denied = await harnessed.service.app.request(path, {
      headers: requestHeaders(insufficient.token),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      workspace: {
        slashCommands: {
          status: "available",
          commands: [{ name: "help", description: "Show help" }],
        },
      },
    })
    expect(denied.status).toBe(401)
    expect(harnessed.runtime.workspaceCapabilities).toHaveBeenCalledWith(
      agentId,
      sessionId
    )
    expect(harnessed.runtime.workspaceCapabilities).toHaveBeenCalledOnce()
    expect(
      (
        await harnessed.service.app.request(runRoute("commands"), {
          headers: requestHeaders(exact.token),
        })
      ).status
    ).toBe(404)
  })

  it("detaches only the guest subscriber at expiry and then denies reconnect and Stop", async () => {
    let current = NOW
    let expire: (() => void) | undefined
    const schedule = vi.fn((_delay: number, task: () => void) => {
      expire = task
      return { timer: true }
    })
    const source = new EventSource()
    const invitationService = invitations(() => current)
    const harnessed = harness({
      now: () => current,
      invitationService,
      sources: [source],
      schedule,
      cancel: vi.fn(),
    })
    const granted = await issue(invitationService, [
      "errors:read",
      "messages:create",
      "messages:read",
      "messages:stop",
    ])
    const response = await postRun(harnessed.service, granted.token, runInput())

    expect(response.status).toBe(200)
    expect(schedule).toHaveBeenCalledWith(300_000, expect.any(Function))
    current = NOW + 300_000
    expire?.()
    expect(harnessed.sessions.state(scope)).toBe("running")
    expect(source.stop).not.toHaveBeenCalled()

    const reconnect = await harnessed.service.app.request(
      runRoute("runs/reconnect"),
      {
        method: "POST",
        headers: {
          ...requestHeaders(granted.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId: sessionId, runId: "run-1" }),
      }
    )
    const stop = await harnessed.service.app.request(runRoute("runs/stop"), {
      method: "POST",
      headers: requestHeaders(granted.token),
    })

    expect(reconnect.status).toBe(401)
    expect(stop.status).toBe(401)
    expect(harnessed.engine.recover).not.toHaveBeenCalled()
    expect(source.stop).not.toHaveBeenCalled()
  })

  it("requires messages:stop independently from message creation", async () => {
    const source = new EventSource()
    const harnessed = harness({ sources: [source] })
    const controller = await issue(harnessed.invitationService, [
      "errors:read",
      "messages:create",
      "messages:read",
      "messages:stop",
    ])
    const creatorOnly = await issue(harnessed.invitationService, [
      "messages:create",
    ])
    expect(
      (await postRun(harnessed.service, controller.token, runInput())).status
    ).toBe(200)

    const denied = await harnessed.service.app.request(runRoute("runs/stop"), {
      method: "POST",
      headers: requestHeaders(creatorOnly.token),
    })
    const stopped = await harnessed.service.app.request(runRoute("runs/stop"), {
      method: "POST",
      headers: requestHeaders(controller.token),
    })

    expect(denied.status).toBe(401)
    expect(stopped.status).toBe(202)
    expect(await stopped.json()).toEqual({ status: "stopping" })
    expect(source.stop).toHaveBeenCalledOnce()
  })

  it("projects an interrupt and requires interactions:respond for its fresh segment", async () => {
    const first = new EventSource()
    const second = new EventSource()
    const harnessed = harness({ sources: [first, second] })
    const granted = await issue(harnessed.invitationService, [
      "errors:read",
      "interactions:respond",
      "messages:create",
      "messages:read",
    ])
    const started = await postRun(harnessed.service, granted.token, runInput())
    const firstBody = started.text()
    first.emit({
      type: EventType.RUN_FINISHED,
      threadId: sessionId,
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "approval-1",
            reason: "approval",
            message: "Allow deployment?",
            responseSchema: { type: "string", enum: ["deny", "once"] },
            metadata: {
              "aos.kind": "approval",
              nativeRequestId: "live-private",
              providerPath: "/srv/hermes/private",
            },
          },
        ],
      },
    })
    first.finish()
    const interrupted = await firstBody
    expect(interrupted).toContain("Allow deployment?")
    expect(interrupted).not.toMatch(/live-private|providerPath|nativeRequestId/)

    const resumed = await postRun(harnessed.service, granted.token, {
      ...runInput("run-2"),
      messages: [],
      resume: [
        { interruptId: "approval-1", status: "resolved", payload: "once" },
      ],
    })
    const resumedBody = resumed.text()
    second.emit({
      type: EventType.RUN_FINISHED,
      threadId: sessionId,
      runId: "run-2",
      outcome: { type: "success" },
    })
    second.finish()

    expect(resumed.status).toBe(200)
    await resumedBody
    expect(harnessed.engine.start).toHaveBeenCalledTimes(2)
    expect(harnessed.engine.start).toHaveBeenLastCalledWith(
      scope,
      expect.objectContaining({
        runId: "run-2",
        messages: [],
        resume: [
          { interruptId: "approval-1", status: "resolved", payload: "once" },
        ],
      })
    )
  })

  it("denies interaction response after the invitation expires", async () => {
    let current = NOW
    const first = new EventSource()
    const invitationService = invitations(() => current)
    const harnessed = harness({
      now: () => current,
      invitationService,
      sources: [first],
    })
    const granted = await issue(invitationService, [
      "errors:read",
      "interactions:respond",
      "messages:create",
      "messages:read",
    ])
    const started = await postRun(harnessed.service, granted.token, runInput())
    const body = started.text()
    first.emit({
      type: EventType.RUN_FINISHED,
      threadId: sessionId,
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "question-1",
            reason: "question",
            message: "Choose",
            responseSchema: { type: "string", enum: ["yes", "no"] },
          },
        ],
      },
    })
    first.finish()
    await body
    current = NOW + 300_000

    const response = await postRun(harnessed.service, granted.token, {
      ...runInput("run-2"),
      messages: [],
      resume: [
        { interruptId: "question-1", status: "resolved", payload: "yes" },
      ],
    })

    expect(response.status).toBe(401)
    expect(harnessed.engine.start).toHaveBeenCalledOnce()
  })

  it("returns friendly safe descriptions without native failure details", async () => {
    const harnessed = harness()
    vi.mocked(harnessed.runtime.history).mockRejectedValueOnce(
      new Error("Bearer native-secret at https://hermes.internal /srv/private")
    )
    const granted = await issue(harnessed.invitationService, [
      "errors:read",
      "messages:read",
    ])

    const response = await harnessed.service.app.request(
      `/api/guest/v1/agents/${agentId}/sessions/${sessionId}/history`,
      { headers: requestHeaders(granted.token) }
    )
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      payload: {
        type: "error",
        code: "temporarily_unavailable",
        description:
          "The service is temporarily unavailable. Please try again.",
        retryable: true,
      },
    })
    expect(JSON.stringify(body)).not.toMatch(
      /native-secret|hermes\.internal|srv\/private/
    )
  })

  it("enforces event scope, expiry, and per-invitation peer caps on the shared observer", async () => {
    let expiry: (() => void) | undefined
    const schedule = vi.fn((_delay: number, task: () => void) => {
      expiry = task
      return { timer: true }
    })
    const harnessed = harness({
      schedule,
      cancel: vi.fn(),
      maxEventPeers: 1,
      maxEventPeersPerInvitation: 1,
    })
    const granted = await issue(harnessed.invitationService, ["messages:read"])
    const query = new URLSearchParams({ agentId, sessionId })
    const upgrade = await harnessed.service.authorizeEventUpgrade(
      new Request(`${ORIGIN}/api/guest/v1/events?${query}`, {
        headers: requestHeaders(granted.token),
      })
    )
    const frames: Array<Record<string, unknown>> = []
    const firstClose = vi.fn()
    const socket = harnessed.service.openEvents(upgrade!, {
      send: (raw) => frames.push(JSON.parse(raw)),
      close: firstClose,
    })
    await socket.receive(
      JSON.stringify({
        type: "aos.subscribe",
        streamId: "stream-1",
        scope: { workspaceId: "guest", agentId, sessionId },
      })
    )
    harnessed.invalidate()

    expect(harnessed.runtime.subscribeSessionInvalidation).toHaveBeenCalledWith(
      agentId,
      sessionId,
      expect.any(Function),
      expect.any(Function)
    )
    expect(frames.map(({ type }) => type)).toEqual([
      "aos.ready",
      "aos.invalidate",
    ])

    const secondClose = vi.fn()
    harnessed.service.openEvents(upgrade!, {
      send: vi.fn(),
      close: secondClose,
    })
    expect(secondClose).toHaveBeenCalledWith(
      1013,
      "Guest event peer limit exceeded"
    )

    expiry?.()
    expect(frames).toContainEqual({
      type: "aos.error",
      version: 1,
      streamId: "stream-1",
      code: "authorization_expired",
    })
    expect(firstClose).toHaveBeenCalledWith(4401, "Authorization expired")
  })
})
