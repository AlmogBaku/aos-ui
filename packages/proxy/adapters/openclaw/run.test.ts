import {
  PendingRequestKind,
  StopReason,
  ToolKind,
  TurnEventKind,
  type RepliesTurnInput,
  type RequestReply,
  type TurnInput,
} from "../../core/events"
import { describe, expect, it, vi } from "vitest"

import { ServerTurnStopNotDispatchedError } from "../../core/runtime"
import { SessionCoordinator } from "../../core/session-coordinator"
import { OpenClawClientRequestError } from "./client"
import { stageOpenClawChatAttachments } from "./content"
import { OpenClawInteractions } from "./interactions"
import { OpenClawTurnEngine, type OpenClawRunRequestClient } from "./run"
import { OpenClawSessionSubscriptions } from "./subscriptions"

class ControlledNative implements OpenClawRunRequestClient {
  readonly calls: Array<{
    method: string
    params: Record<string, unknown>
    options?: Parameters<OpenClawRunRequestClient["request"]>[2]
  }> = []
  history: unknown = {
    sessionKey: "agent:research:main",
    sessionId: "transcript-a",
    messages: [],
    sessionInfo: { hasActiveRun: false, activeRunIds: [] },
  }
  historyRequest?: () => Promise<unknown>
  subscriptionRequest?: (params: Record<string, unknown>) => Promise<unknown>
  abortRequest?: () => Promise<unknown>
  subscriptionKey?: string
  approvalReplay?: unknown
  abortResult: unknown = {
    ok: true,
    status: "aborted",
    abortedRunId: "run-a",
  }
  abortError?: unknown
  sendError?: unknown

  async request<T>(
    method: string,
    params: Record<string, unknown>,
    options?: Parameters<OpenClawRunRequestClient["request"]>[2]
  ): Promise<T> {
    this.calls.push({ method, params, options })
    if (method === "sessions.messages.subscribe")
      return (
        this.subscriptionRequest
          ? await this.subscriptionRequest(params)
          : {
              key: this.subscriptionKey ?? params.key,
              ...(this.approvalReplay === undefined
                ? {}
                : { approvalReplay: structuredClone(this.approvalReplay) }),
            }
      ) as T
    if (method === "sessions.messages.unsubscribe") return {} as T
    if (method === "chat.history")
      return (
        this.historyRequest
          ? await this.historyRequest()
          : structuredClone(this.history)
      ) as T
    if (method === "sessions.abort") {
      if (
        this.abortError instanceof OpenClawClientRequestError &&
        !this.abortError.requestSent
      )
        throw this.abortError
      options?.onSent?.()
      if (this.abortError) throw this.abortError
      return (
        this.abortRequest
          ? await this.abortRequest()
          : structuredClone(this.abortResult)
      ) as T
    }
    if (method === "chat.send") {
      options?.onSent?.()
      if (this.sendError) throw this.sendError
      options?.onAccepted?.({
        status: "accepted",
        runId: params.idempotencyKey,
      })
      return new Promise<T>(() => {})
    }
    throw new Error(`Unexpected method ${method}`)
  }
}

const scope = {
  agentId: "research",
  sessionId: "agent:research:main",
  threadId: "thread-public",
}

const pendingQuestion = {
  id: "question-restored",
  agentId: scope.agentId,
  sessionKey: scope.sessionId,
  runId: "native-original",
  createdAtMs: 1,
  expiresAtMs: 1_900_000_000_000,
  status: "pending",
  questions: [
    {
      questionId: "choice",
      header: "Choice",
      question: "Continue?",
      options: [{ label: "yes" }],
      isOther: false,
    },
  ],
}

const pendingApproval = {
  id: "approval-restored",
  urlPath: "/approvals/approval-restored",
  createdAtMs: 1,
  expiresAtMs: 1_900_000_000_000,
  status: "pending",
  sourceSessionKey: scope.sessionId,
  presentation: {
    kind: "plugin",
    title: "External action",
    description: "Allow the plugin action",
    severity: "warning",
    agentId: scope.agentId,
    allowedDecisions: ["allow-once", "deny"],
  },
}

function approvalReplay(approvals: unknown[] = [], truncated = false) {
  return {
    sessionKey: scope.sessionId,
    updatedAtMs: 1,
    approvals,
    truncated,
  }
}

function input(turnId = "run-a"): TurnInput {
  return { turnId, messageId: "user-a", prompt: "Investigate this" }
}

function repliesInput(
  replies: RequestReply[],
  turnId = "turn-replies"
): RepliesTurnInput {
  return { turnId, replies }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function coordinator(engine: OpenClawTurnEngine) {
  return new SessionCoordinator({
    engine,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: 8,
    maxSubscriberBytes: 64 * 1024,
    maxReplayEvents: 32,
    maxReplayBytes: 256 * 1024,
  })
}

const operatorAccess = {
  subscriberId: "operator",
  controllerId: "operator",
  lane: "operator" as const,
  canControl: true,
}

describe("OpenClaw run engine", () => {
  it("submits one exact Agent-bound native-idempotent text turn after authoritative idle", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })

    const handle = await engine.start(scope, input())
    const iterator = handle.events[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        kind: TurnEventKind.TurnStarted,
      },
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toMatchObject([
      {
        method: "chat.send",
        params: {
          sessionKey: "agent:research:main",
          agentId: "research",
          message: "Investigate this",
          idempotencyKey: "run-a",
        },
        options: { expectFinal: true },
      },
    ])
  })

  it("sends one provider-validated staged attachment with the exact native turn", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const stage = stageOpenClawChatAttachments(
      [
        {
          type: "file",
          dataUrl: "data:text/plain;base64,aGk=",
          filename: "note.txt",
        },
      ],
      {
        maxPayload: 1_000_000,
        attachments: { maxBytes: 10_000, maxImageBytes: 10_000 },
      }
    )

    await expect(engine.start(scope, input(), stage)).resolves.toBeDefined()
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toMatchObject([
      {
        params: {
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          message: "Investigate this",
          idempotencyKey: "run-a",
          attachments: [
            {
              type: "file",
              content: "data:text/plain;base64,aGk=",
              mimeType: "text/plain",
              sizeBytes: 2,
              fileName: "note.txt",
            },
          ],
        },
      },
    ])
  })

  it("rejects reply attachments and foreign stages before native dispatch", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const validate = vi.fn(async () => ({ runId: "native-original" }))
    const dispatch = vi.fn(async () => ({ status: "resolved" as const }))
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: { validate, dispatch },
    })
    const stage = stageOpenClawChatAttachments(
      [{ type: "image", dataUrl: "data:image/png;base64,aGk=" }],
      {
        maxPayload: 1_000_000,
        attachments: { maxBytes: 10_000, maxImageBytes: 10_000 },
      }
    )

    await expect(
      engine.start(
        scope,
        repliesInput([
          {
            requestId: "question-a",
            status: "resolved",
            payload: { answers: [["yes"]] },
          },
        ]),
        stage
      )
    ).rejects.toThrow("cannot include staged attachments")
    expect(validate).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(native.calls).toEqual([])

    await expect(
      engine.start(scope, input(), {
        public: [],
        appendTo: (message) => message,
        cleanup: async () => undefined,
      })
    ).rejects.toThrow("does not belong to OpenClaw")
    expect(native.calls).toEqual([])
  })

  it("does not retry a staged turn after an uncertain native send", async () => {
    const native = new ControlledNative()
    native.sendError = new OpenClawClientRequestError("connection closed", true)
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const stage = stageOpenClawChatAttachments(
      [{ type: "file", dataUrl: "data:text/plain;base64,aGk=" }],
      {
        maxPayload: 1_000_000,
        attachments: { maxBytes: 10_000, maxImageBytes: 10_000 },
      }
    )

    const handle = await engine.start(scope, input(), stage)
    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)

    expect(events.at(-1)).toMatchObject({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_SEND_UNCERTAIN",
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
  })

  it("rejects a staged request that exceeds the negotiated frame before reserving the run", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const stage = stageOpenClawChatAttachments(
      [{ type: "file", dataUrl: "data:text/plain;base64,aGk=" }],
      {
        maxPayload: 10,
        attachments: { maxBytes: 10_000, maxImageBytes: 10_000 },
      }
    )

    await expect(engine.start(scope, input(), stage)).rejects.toMatchObject({
      name: "OpenClawContentPublicError",
    })
    await expect(
      engine.start(scope, input("run-after-rejection"))
    ).resolves.toBeDefined()
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
  })

  it("repeats admission history when a subscribed Session changes during the read", async () => {
    const native = new ControlledNative()
    const first = deferred<unknown>()
    let reads = 0
    native.historyRequest = async () => {
      reads += 1
      if (reads === 1) return first.promise
      return {
        sessionKey: scope.sessionId,
        sessionId: "transcript-a",
        messages: [],
        sessionInfo: { hasActiveRun: true, activeRunIds: ["foreign-run"] },
        inFlightRun: { runId: "foreign-run", text: "busy" },
      }
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })

    const starting = engine.start(scope, input())
    await vi.waitFor(() => expect(reads).toBe(1))
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 1,
        payload: {
          runId: "foreign-run",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "status",
          phase: "starting_model",
        },
      },
      subscriptions.generation
    )
    first.resolve({
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    })

    await expect(starting).rejects.toMatchObject({
      name: "ServerTurnConflictError",
    })
    expect(reads).toBe(2)
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(0)
  })

  it("rejects history echoed for a different canonical Session", async () => {
    const native = new ControlledNative()
    native.history = {
      sessionKey: "agent:research:foreign",
      sessionId: "transcript-foreign",
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })

    await expect(engine.start(scope, input())).rejects.toMatchObject({
      name: "OpenClawRunPublicError",
      code: "AOS_PROVIDER_UNAVAILABLE",
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(0)
  })

  it("accepts the official subscription's canonical Session alias in history", async () => {
    const native = new ControlledNative()
    native.subscriptionKey = "agent:research:canonical"
    native.history = {
      sessionKey: "agent:research:canonical",
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })

    await expect(engine.start(scope, input())).resolves.toBeDefined()
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
  })

  it.each([
    [
      "question",
      {
        requestId: "question-a",
        status: "resolved" as const,
        payload: { answers: [["yes"]] },
      },
    ],
    [
      "approval",
      {
        requestId: "approval-a",
        status: "resolved" as const,
        payload: "once",
      },
    ],
  ])(
    "validates an exact bound %s reply before observing and dispatches it once after attachment",
    async (_kind, response) => {
      const native = new ControlledNative()
      native.history = {
        sessionKey: scope.sessionId,
        sessionId: "transcript-a",
        messages: [],
        sessionInfo: {
          hasActiveRun: true,
          activeRunIds: ["native-waiting"],
        },
        inFlightRun: { runId: "native-waiting", text: "" },
      }
      const subscriptions = new OpenClawSessionSubscriptions(native)
      const validate = vi.fn(async () => ({ runId: "native-waiting" }))
      const dispatch = vi.fn(async () => {
        expect(
          native.calls.some(
            ({ method }) => method === "sessions.messages.subscribe"
          )
        ).toBe(true)
        return { status: "resolved" as const }
      })
      const engine = new OpenClawTurnEngine({
        client: native,
        subscriptions,
        replies: { validate, dispatch },
      })
      const candidate = repliesInput([response])

      await expect(engine.start(scope, candidate)).resolves.toBeDefined()
      expect(validate).toHaveBeenCalledExactlyOnceWith(scope, candidate.replies)
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(scope, candidate.replies)
      expect(
        native.calls.filter(({ method }) => method === "chat.send")
      ).toHaveLength(0)
    }
  )

  it("rejects an unbound reply before attaching or dispatching it", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const dispatch = vi.fn()
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: {
        validate: vi.fn(async () => {
          throw new Error("interaction does not belong to this Session")
        }),
        dispatch,
      },
    })

    await expect(
      engine.start(
        scope,
        repliesInput([
          {
            requestId: "foreign-question",
            status: "cancelled",
          },
        ])
      )
    ).rejects.toThrow("interaction does not belong to this Session")
    expect(dispatch).not.toHaveBeenCalled()
    expect(
      native.calls.filter(
        ({ method }) => method === "sessions.messages.subscribe"
      )
    ).toHaveLength(0)
  })

  it("preserves an uncertain interaction response without dispatching it again on recovery", async () => {
    const native = new ControlledNative()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-waiting"],
      },
      inFlightRun: { runId: "native-waiting", text: "Waiting" },
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const dispatch = vi.fn(async () => ({ status: "uncertain" as const }))
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: {
        validate: vi.fn(async () => ({ runId: "native-waiting" })),
        dispatch,
      },
    })

    const handle = await engine.start(
      scope,
      repliesInput([
        {
          requestId: "question-a",
          status: "resolved",
          payload: { answers: [["yes"]] },
        },
      ])
    )
    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events.at(-1)).toMatchObject({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_INTERACTION_UNCERTAIN",
    })

    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "turn-replies",
    })
    await expect(
      recovered.events[Symbol.asyncIterator]().next()
    ).resolves.toMatchObject({
      value: { kind: TurnEventKind.TurnStarted },
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("rediscovers and answers one exact pending question through a fresh engine", async () => {
    const native = new ControlledNative()
    native.approvalReplay = approvalReplay()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-original"],
      },
      inFlightRun: { runId: "native-original", text: "before" },
    }
    const request = vi.fn(async (method: string) => {
      if (method === "question.list") return { questions: [pendingQuestion] }
      if (method === "question.get") return { question: pendingQuestion }
      if (method === "question.resolve")
        return { status: "answered", answers: { answers: { choice: ["yes"] } } }
      throw new Error(`Unexpected interaction method ${method}`)
    })
    const interactions = new OpenClawInteractions({ request })
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: interactions,
    })

    const discovered = await engine.discover(scope, "restored-question")
    expect(discovered?.state).toBe("waiting-for-input")
    const restoredEvents: unknown[] = []
    for await (const event of discovered!.handle.events)
      restoredEvents.push(event)
    expect(restoredEvents).toEqual([
      {
        kind: TurnEventKind.TurnStarted,
      },
      {
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          expect.objectContaining({
            requestId: "question-restored",
            kind: PendingRequestKind.Elicitation,
          }),
        ],
      },
    ])

    const answered = await engine.start(
      scope,
      repliesInput(
        [
          {
            requestId: "question-restored",
            status: "resolved",
            payload: { answers: [["yes"]] },
          },
        ],
        "question-continuation"
      )
    )
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 71,
        payload: {
          runId: "native-original",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
          message: { content: [{ type: "text", text: "before after" }] },
        },
      },
      subscriptions.generation
    )
    const answeredEvents: unknown[] = []
    for await (const event of answered.events) answeredEvents.push(event)

    expect(answeredEvents).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "question-continuation:assistant",
      text: " after",
    })
    expect(answeredEvents.at(-1)).toEqual({ kind: TurnEventKind.TurnEnded })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "question.list",
      "question.get",
      "question.get",
      "question.resolve",
    ])
    expect(native.calls.filter(({ method }) => method === "chat.send")).toEqual(
      []
    )
  })

  it("rediscovers and answers one approval against the unique history-proven native run", async () => {
    const native = new ControlledNative()
    native.approvalReplay = approvalReplay([pendingApproval])
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-original"],
      },
      inFlightRun: { runId: "native-original", text: "before" },
    }
    const request = vi.fn(async (method: string) => {
      if (method === "question.list") return { questions: [] }
      if (method === "approval.get") return { approval: pendingApproval }
      if (method === "approval.resolve")
        return {
          applied: true,
          approval: {
            ...pendingApproval,
            status: "allowed",
            decision: "allow-once",
            resolvedAtMs: 2,
            reason: "user",
            resolver: { kind: "device", id: "reviewer-a" },
          },
        }
      throw new Error(`Unexpected interaction method ${method}`)
    })
    const interactions = new OpenClawInteractions({ request })
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: interactions,
    })

    const discovered = await engine.discover(scope, "restored-approval")
    expect(discovered).toMatchObject({
      state: "waiting-for-input",
      requests: [
        { requestId: "approval-restored", kind: PendingRequestKind.Permission },
      ],
    })
    await expect(
      engine.start(
        scope,
        repliesInput(
          [
            {
              requestId: "approval-restored",
              status: "resolved",
              payload: "once",
            },
          ],
          "approval-continuation"
        )
      )
    ).resolves.toBeDefined()

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "question.list",
      "approval.get",
      "approval.get",
      "approval.resolve",
    ])
    expect(native.calls.filter(({ method }) => method === "chat.send")).toEqual(
      []
    )
  })

  it("uses an acknowledged approval replay key to recover and reply on a canonical Session alias", async () => {
    const publicScope = { ...scope, sessionId: "global" }
    const replayKey = "agent:research:global"
    const approval = {
      ...pendingApproval,
      sourceSessionKey: replayKey,
    }
    const native = new ControlledNative()
    native.history = {
      sessionKey: publicScope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-original"],
      },
      inFlightRun: { runId: "native-original", text: "before" },
    }
    const firstAcknowledgement = deferred<unknown>()
    let subscriptionReads = 0
    native.subscriptionRequest = async () => {
      subscriptionReads += 1
      if (subscriptionReads === 1) return firstAcknowledgement.promise
      return {
        key: publicScope.sessionId,
        approvalReplay: {
          ...approvalReplay([approval]),
          sessionKey: replayKey,
        },
      }
    }
    const request = vi.fn(async (method: string) => {
      if (method === "question.list") return { questions: [] }
      if (method === "approval.get") return { approval }
      if (method === "approval.resolve")
        return {
          applied: true,
          approval: {
            ...approval,
            status: "allowed",
            decision: "allow-once",
            resolvedAtMs: 2,
            reason: "user",
            resolver: { kind: "device", id: "reviewer-a" },
          },
        }
      throw new Error(`Unexpected interaction method ${method}`)
    })
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: new OpenClawInteractions({ request }),
    })

    const discovering = engine.discover(publicScope, "restored-alias")
    await vi.waitFor(() => expect(subscriptionReads).toBe(1))
    subscriptions.accept(
      {
        type: "event",
        event: "session.approval",
        seq: 72,
        payload: {
          sessionKey: replayKey,
          sourceSessionKey: replayKey,
          updatedAtMs: 2,
          phase: "pending",
          approval,
        },
      },
      subscriptions.generation
    )
    firstAcknowledgement.resolve({
      key: publicScope.sessionId,
      approvalReplay: {
        ...approvalReplay(),
        sessionKey: replayKey,
      },
    })

    await expect(discovering).resolves.toMatchObject({
      state: "waiting-for-input",
      requests: [
        { requestId: approval.id, kind: PendingRequestKind.Permission },
      ],
    })
    await expect(
      engine.start(
        publicScope,
        repliesInput(
          [
            {
              requestId: approval.id,
              status: "resolved",
              payload: "once",
            },
          ],
          "alias-continuation"
        )
      )
    ).resolves.toBeDefined()

    expect(subscriptionReads).toBe(3)
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "question.list",
      "approval.get",
      "approval.get",
      "approval.resolve",
    ])
    expect(native.calls.filter(({ method }) => method === "chat.send")).toEqual(
      []
    )
  })

  it("refreshes a coordinator-retained wait from native authority and admits a new turn after external resolution", async () => {
    const native = new ControlledNative()
    native.approvalReplay = approvalReplay([pendingApproval])
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-original"],
      },
      inFlightRun: { runId: "native-original", text: "before" },
    }
    const request = vi.fn(async (method: string) => {
      if (method === "question.list") return { questions: [] }
      throw new Error(`Unexpected interaction method ${method}`)
    })
    const sessions = coordinator(
      new OpenClawTurnEngine({
        client: native,
        subscriptions: new OpenClawSessionSubscriptions(native),
        replies: new OpenClawInteractions({ request }),
      })
    )

    await expect(sessions.discover(scope)).resolves.toMatchObject({
      state: "waiting-for-input",
    })
    const recoveredRunId = sessions.snapshot(scope).turnId

    native.approvalReplay = approvalReplay()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    await expect(sessions.discover(scope)).resolves.toBeUndefined()
    expect(sessions.snapshot(scope)).toEqual({ state: "idle", requests: [] })

    await expect(
      sessions.start(scope, input("after-external-resolution"), operatorAccess)
    ).resolves.toBeDefined()
    expect(recoveredRunId).toMatch(/^aos-recovered-/)
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
  })

  it.each([
    [
      "a truncated approval replay",
      approvalReplay([pendingApproval], true),
      ["native-original"],
      [] as unknown[],
    ],
    [
      "ambiguous active native runs",
      approvalReplay(),
      ["native-original", "native-other"],
      [pendingQuestion],
    ],
    [
      "no active native run",
      approvalReplay(),
      [] as string[],
      [pendingQuestion],
    ],
  ])(
    "fails closed during discovery with %s",
    async (_label, replay, activeRunIds, questions) => {
      const native = new ControlledNative()
      native.approvalReplay = replay
      native.history = {
        sessionKey: scope.sessionId,
        sessionId: "transcript-a",
        messages: [],
        sessionInfo: {
          hasActiveRun: activeRunIds.length > 0,
          activeRunIds,
        },
        inFlightRun:
          activeRunIds.length === 1
            ? { runId: activeRunIds[0], text: "before" }
            : undefined,
      }
      const request = vi.fn(async () => ({ questions }))
      const interactions = new OpenClawInteractions({ request })
      const engine = new OpenClawTurnEngine({
        client: native,
        subscriptions: new OpenClawSessionSubscriptions(native),
        replies: interactions,
      })

      await expect(
        engine.discover(scope, "restored-unsafe")
      ).resolves.toBeUndefined()
      expect(
        native.calls.filter(({ method }) => method === "chat.send")
      ).toEqual([])
    }
  )

  it("restarts discovery after a subscription generation changes without mixing replay state", async () => {
    const native = new ControlledNative()
    const firstHistory = deferred<unknown>()
    let historyReads = 0
    native.historyRequest = async () => {
      historyReads += 1
      if (historyReads === 1) return firstHistory.promise
      return {
        sessionKey: scope.sessionId,
        sessionId: "transcript-b",
        messages: [],
        sessionInfo: {
          hasActiveRun: true,
          activeRunIds: ["native-original"],
        },
        inFlightRun: { runId: "native-original", text: "current" },
      }
    }
    let subscriptionReads = 0
    native.subscriptionRequest = async (params) => {
      subscriptionReads += 1
      return {
        key: params.key,
        approvalReplay: {
          ...approvalReplay(),
          updatedAtMs: subscriptionReads,
        },
      }
    }
    const discover = vi.fn(async () => undefined)
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: {
        validate: vi.fn(),
        dispatch: vi.fn(),
        discover,
      },
    })

    const discovering = engine.discover(scope, "restored-generation")
    await vi.waitFor(() => expect(historyReads).toBe(1))
    await subscriptions.replaceGeneration("reconnect")
    firstHistory.resolve({
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-original"],
      },
      inFlightRun: { runId: "native-original", text: "retired" },
    })

    await expect(discovering).resolves.toBeUndefined()
    expect(historyReads).toBe(2)
    expect(discover).toHaveBeenCalledExactlyOnceWith(
      { ...scope, nativeRunId: "native-original" },
      { ...approvalReplay(), updatedAtMs: 3 }
    )
  })

  it.each([
    ["discovers", approvalReplay([pendingApproval]), true],
    ["refuses", approvalReplay([pendingApproval], true), false],
  ])(
    "%s an approval from a refreshed replay when it arrives during the authoritative history read",
    async (_label, refreshedReplay, expectedDiscovery) => {
      const native = new ControlledNative()
      const firstHistory = deferred<unknown>()
      let historyReads = 0
      native.historyRequest = async () => {
        historyReads += 1
        if (historyReads === 1) return firstHistory.promise
        return {
          sessionKey: scope.sessionId,
          sessionId: "transcript-a",
          messages: [],
          sessionInfo: {
            hasActiveRun: true,
            activeRunIds: ["native-original"],
          },
          inFlightRun: { runId: "native-original", text: "before" },
        }
      }
      let subscriptionReads = 0
      native.subscriptionRequest = async (params) => {
        subscriptionReads += 1
        return {
          key: params.key,
          approvalReplay:
            subscriptionReads === 1 ? approvalReplay() : refreshedReplay,
        }
      }
      const request = vi.fn(async (method: string) => {
        if (method === "question.list") return { questions: [] }
        throw new Error(`Unexpected interaction method ${method}`)
      })
      const subscriptions = new OpenClawSessionSubscriptions(native)
      const engine = new OpenClawTurnEngine({
        client: native,
        subscriptions,
        replies: new OpenClawInteractions({ request }),
      })

      const discovering = engine.discover(scope, "approval-during-history")
      await vi.waitFor(() => expect(historyReads).toBe(1))
      subscriptions.accept(
        {
          type: "event",
          event: "session.approval",
          seq: 91,
          payload: {
            sessionKey: scope.sessionId,
            sourceSessionKey: scope.sessionId,
            updatedAtMs: 2,
            phase: "pending",
            approval: pendingApproval,
          },
        },
        subscriptions.generation
      )
      firstHistory.resolve({
        sessionKey: scope.sessionId,
        sessionId: "transcript-a",
        messages: [],
        sessionInfo: {
          hasActiveRun: true,
          activeRunIds: ["native-original"],
        },
        inFlightRun: { runId: "native-original", text: "before" },
      })

      const discovered = await discovering
      expect(discovered?.state === "waiting-for-input").toBe(expectedDiscovery)
      expect(subscriptionReads).toBe(2)
      expect(historyReads).toBe(2)
      expect(request).toHaveBeenCalledTimes(expectedDiscovery ? 1 : 0)
      expect(
        native.calls.filter(({ method }) => method === "chat.send")
      ).toEqual([])
    }
  )

  it("authoritatively binds a cold recovered reply segment to the unique active native run", async () => {
    const native = new ControlledNative()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-original"],
      },
      inFlightRun: { runId: "native-original", text: "before interrupt" },
    }
    native.abortResult = {
      ok: true,
      status: "aborted",
      abortedRunId: "native-original",
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })

    const handle = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "segment-continued",
    })
    await expect(handle.stop()).resolves.toBe("stopping")
    expect(
      native.calls.filter(({ method }) => method === "sessions.abort")
    ).toMatchObject([
      {
        params: {
          key: scope.sessionId,
          agentId: scope.agentId,
          runId: "native-original",
        },
      },
    ])
  })

  it("uses pre-dispatch native state as a private reply baseline and emits only the suffix", async () => {
    const oldEvents = [
      {
        runId: "native-original",
        seq: 0,
        stream: "tool",
        ts: 1_000,
        data: {
          phase: "start",
          name: "old-tool",
          toolCallId: "old-tool",
          args: { private: "old-args" },
        },
      },
      {
        runId: "native-original",
        seq: 1,
        stream: "tool",
        ts: 1_001,
        data: {
          phase: "result",
          name: "old-tool",
          toolCallId: "old-tool",
          result: { private: "old-result" },
          isError: false,
        },
      },
    ]
    const native = new ControlledNative()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: ["native-original"],
      },
      inFlightRun: {
        runId: "native-original",
        text: "before interrupt",
        plan: { steps: [{ step: "Old plan", status: "completed" }] },
        events: oldEvents,
      },
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const dispatch = vi.fn(async () => {
      native.history = {
        sessionKey: scope.sessionId,
        sessionId: "transcript-a",
        messages: [],
        sessionInfo: {
          hasActiveRun: true,
          activeRunIds: ["native-original"],
        },
        inFlightRun: {
          runId: "native-original",
          text: "before interrupt after answer",
          plan: { steps: [{ step: "New plan", status: "in_progress" }] },
          events: [
            ...oldEvents,
            {
              runId: "native-original",
              seq: 2,
              stream: "tool",
              ts: 1_002,
              data: {
                phase: "start",
                name: "new-tool",
                toolCallId: "new-tool",
                args: { private: "new-args" },
              },
            },
            {
              runId: "native-original",
              seq: 3,
              stream: "tool",
              ts: 1_003,
              data: {
                phase: "result",
                name: "new-tool",
                toolCallId: "new-tool",
                result: { private: "new-result" },
                isError: false,
              },
            },
          ],
        },
      }
      return { status: "resolved" as const }
    })
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      replies: {
        validate: vi.fn(async () => ({ runId: "native-original" })),
        dispatch,
      },
    })

    const handle = await engine.start(
      scope,
      repliesInput([
        {
          requestId: "question-a",
          status: "resolved",
          payload: { answers: [["yes"]] },
        },
      ])
    )
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 70,
        payload: {
          runId: "native-original",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
          message: {
            content: [{ type: "text", text: "before interrupt after answer" }],
          },
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("before interrupt")
    expect(serialized).not.toContain("Old plan")
    expect(serialized).not.toContain("old-tool")
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "turn-replies:assistant",
      text: " after answer",
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "new-tool",
      })
    )
    // Only the plan the answer changed is new; the baseline plan stays unsaid.
    expect(
      events.filter(
        (event) =>
          (event as { kind: string }).kind === TurnEventKind.PlanUpdated
      )
    ).toEqual([
      {
        kind: TurnEventKind.PlanUpdated,
        todos: [{ id: "0", label: "New plan", status: "active" }],
      },
    ])
  })

  it("maps validated native reasoning, text, plans, usage, timed tools, and partial output in order", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({
      client: native,
      subscriptions,
      toolEvents: true,
    })
    const handle = await engine.start(scope, input())
    let outerSeq = 10
    let nativeSeq = 0
    const emit = (stream: string, data: Record<string, unknown>) => {
      subscriptions.accept(
        {
          type: "event",
          event: "agent",
          seq: outerSeq++,
          payload: {
            runId: "run-a",
            sessionKey: scope.sessionId,
            agentId: scope.agentId,
            seq: nativeSeq++,
            stream,
            ts: 1_000 + nativeSeq,
            data,
          },
        },
        subscriptions.generation
      )
    }

    emit("thinking", { text: "checking", delta: "checking" })
    emit("run_status", { phase: "preparing_context" })
    emit("plan", {
      phase: "update",
      steps: [
        { step: "Search", status: "in_progress" },
        { step: "Report", status: "pending" },
      ],
    })
    emit("plan", {
      phase: "update",
      steps: [
        { step: "Search", status: "in_progress" },
        { step: "Report", status: "pending" },
      ],
    })
    emit("assistant", { text: "Answer", delta: "Answer" })
    emit("tool", {
      phase: "start",
      name: "search",
      toolCallId: "tool-1",
      args: { query: "public" },
    })
    emit("tool", {
      phase: "update",
      name: "search",
      toolCallId: "tool-1",
      partialResult: { content: [{ type: "text", text: "match 1" }] },
    })
    emit("tool", {
      phase: "update",
      name: "search",
      toolCallId: "tool-1",
      partialResult: {
        content: [{ type: "text", text: "match 1\nmatch 2" }],
      },
    })
    emit("tool", {
      phase: "result",
      name: "search",
      toolCallId: "tool-1",
      result: { matches: 2 },
      isError: false,
    })
    emit("usage", { outputTokens: 17 })
    emit("lifecycle", { phase: "end" })
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: outerSeq++,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "delta",
          deltaText: " tail",
        },
      },
      subscriptions.generation
    )
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: outerSeq++,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 1,
          state: "final",
          message: {
            content: [{ type: "text", text: "Answer tail" }],
          },
          stopReason: "length",
          usage: {
            input: 5,
            output: 17,
            cacheRead: 3,
            cacheWrite: 2,
            totalTokens: 27,
            cost: { total: 0.0123 },
          },
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toEqual([
      {
        kind: TurnEventKind.TurnStarted,
      },
      {
        kind: TurnEventKind.ThoughtChunk,
        messageId: "run-a:assistant",
        text: "checking",
      },
      {
        kind: TurnEventKind.PlanUpdated,
        todos: [
          { id: "0", label: "Search", status: "active" },
          { id: "1", label: "Report", status: "pending" },
        ],
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-a:assistant",
        text: "Answer",
      },
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "tool-1",
        title: "search",
        name: "search",
        toolKind: ToolKind.Other,
        startedAt: "1970-01-01T00:00:01.006Z",
        parentMessageId: "run-a:assistant",
      },
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "tool-1",
        delta: '{"query":"public"}',
      },
      {
        kind: TurnEventKind.ToolCallOutputChunk,
        toolCallId: "tool-1",
        text: "match 1",
      },
      {
        kind: TurnEventKind.ToolCallOutputChunk,
        toolCallId: "tool-1",
        text: "\nmatch 2",
      },
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "tool-1" },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "tool-1",
        output: '{"matches":2}',
        failed: false,
        completedAt: "1970-01-01T00:00:01.009Z",
        durationMs: 3,
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-a:assistant",
        text: " tail",
      },
      {
        kind: TurnEventKind.TurnEnded,
        stopReason: StopReason.MaxTokens,
        usage: [
          {
            inputTokens: 5,
            outputTokens: 17,
            totalTokens: 27,
            cachedInputTokens: 3,
            cachedWriteTokens: 2,
          },
        ],
        cost: { amount: 0.0123, currency: "USD" },
      },
    ])
  })

  it("aborts only the exact run and remains stopping until native terminal evidence", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())
    const iterator = handle.events[Symbol.asyncIterator]()
    await iterator.next()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-a"] },
      inFlightRun: { runId: "run-a", text: "" },
    }

    await expect(handle.stop()).resolves.toBe("stopping")
    expect(
      native.calls.filter(({ method }) => method === "sessions.abort")
    ).toMatchObject([
      {
        method: "sessions.abort",
        params: {
          key: scope.sessionId,
          agentId: scope.agentId,
          runId: "run-a",
        },
      },
    ])

    await expect(handle.stop()).resolves.toBe("stopping")
    expect(
      native.calls.filter(({ method }) => method === "sessions.abort")
    ).toHaveLength(1)
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    await expect(handle.stop()).resolves.toBe("idle")
    expect(
      native.calls.filter(({ method }) => method === "sessions.abort")
    ).toHaveLength(1)

    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 12,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "aborted",
        },
      },
      subscriptions.generation
    )
    await expect(handle.settled).resolves.toBeUndefined()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: TurnEventKind.TurnEnded },
    })
    await expect(handle.stop()).resolves.toBe("idle")
  })

  it("does not retry an abort whose dispatch outcome is uncertain", async () => {
    const native = new ControlledNative()
    native.abortError = new OpenClawClientRequestError(
      "unavailable",
      true,
      false
    )
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).rejects.toMatchObject({
      name: "OpenClawRunPublicError",
      code: "AOS_STOP_UNCERTAIN",
    })
    expect(
      native.calls.filter(({ method }) => method === "sessions.abort")
    ).toHaveLength(1)
  })

  it("returns idle when exact native terminal wins the abort acknowledgement race", async () => {
    const native = new ControlledNative()
    const acknowledgement = deferred<unknown>()
    native.abortRequest = () => acknowledgement.promise
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    const stopping = handle.stop()
    await vi.waitFor(() =>
      expect(
        native.calls.filter(({ method }) => method === "sessions.abort")
      ).toHaveLength(1)
    )
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 20,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "aborted",
        },
      },
      subscriptions.generation
    )
    acknowledgement.resolve({
      ok: true,
      status: "aborted",
      abortedRunId: "run-a",
    })

    await expect(stopping).resolves.toBe("idle")
  })

  it("returns idle when authoritative history is already idle after the abort acknowledgement", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("idle")
    await expect(handle.settled).resolves.toBeUndefined()
  })

  it("signals a proven pre-dispatch Stop failure without making it uncertain", async () => {
    const native = new ControlledNative()
    native.abortError = new OpenClawClientRequestError(
      "unavailable",
      false,
      false
    )
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    const error = await handle.stop().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ServerTurnStopNotDispatchedError)
    expect(error).toMatchObject({
      failure: {
        name: "OpenClawRunPublicError",
        code: "AOS_PROVIDER_UNAVAILABLE",
      },
    })
  })

  it("does not retry a turn whose native dispatch may have been accepted", async () => {
    const native = new ControlledNative()
    native.sendError = new OpenClawClientRequestError(
      "unavailable",
      true,
      false
    )
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })

    const handle = await engine.start(scope, input())
    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toMatchObject([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnFailed, code: "AOS_SEND_UNCERTAIN" },
    ])
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)

    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-a"] },
      inFlightRun: { runId: "run-a", text: "Accepted remotely" },
    }
    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-a",
    })
    await expect(
      recovered.events[Symbol.asyncIterator]().next()
    ).resolves.toMatchObject({
      value: { kind: TurnEventKind.TurnStarted },
    })
    expect(
      native.calls.filter(
        ({ method }) => method === "sessions.messages.subscribe"
      )
    ).toHaveLength(1)
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
  })

  it("rejects foreign runs and reduces tool detail when tool events were not negotiated", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())
    const emit = (runId: string, seq: number, data: Record<string, unknown>) =>
      subscriptions.accept(
        {
          type: "event",
          event: "agent",
          seq,
          payload: {
            runId,
            sessionKey: scope.sessionId,
            agentId: scope.agentId,
            seq,
            stream: "tool",
            ts: 1_000 + seq,
            data,
          },
        },
        subscriptions.generation
      )
    emit("foreign-run", 0, {
      phase: "start",
      name: "secret-tool",
      toolCallId: "foreign-tool",
      args: { secret: "must-not-cross" },
    })
    emit("run-a", 0, {
      phase: "start",
      name: "search",
      toolCallId: "tool-1",
      args: { secret: "must-not-cross" },
    })
    emit("run-a", 1, {
      phase: "result",
      name: "search",
      toolCallId: "tool-1",
      result: { secret: "must-not-cross" },
      isError: false,
    })
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 20,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(JSON.stringify(events)).not.toContain("must-not-cross")
    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallInputChunk,
      toolCallId: "tool-1",
      delta: "{}",
    })
    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "tool-1",
      output: '{"status":"completed","isError":false}',
      failed: false,
      completedAt: "1970-01-01T00:00:01.001Z",
      durationMs: 1,
    })
    expect(JSON.stringify(events)).not.toContain("foreign-tool")
  })

  it("flushes validated final-only chat text before terminal lifecycle", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 30,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
          message: { content: [{ type: "text", text: "Final only" }] },
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "run-a:assistant",
      text: "Final only",
    })
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it.each([
    [
      "a clean final",
      { state: "final", stopReason: "stop" },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ],
    [
      "a final with an unmapped stop reason",
      { state: "final", stopReason: "toolUse" },
      { kind: TurnEventKind.TurnEnded },
    ],
    [
      "an abort",
      { state: "aborted" },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.Cancelled },
    ],
    [
      "a refusal",
      { state: "error", errorKind: "refusal" },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.Refusal },
    ],
    [
      "a context overflow",
      {
        state: "error",
        errorKind: "context_length",
        errorMessage: "provider-private detail",
        errorDetail: { provider: "anthropic", model: "claude-sonnet" },
      },
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_RUN_FAILED",
        message: "This conversation no longer fits the model's context window.",
        provider: "anthropic",
        model: "claude-sonnet",
      },
    ],
    [
      "a rate limit named only by the failed message",
      {
        state: "error",
        errorKind: "rate_limit",
        message: { role: "assistant", provider: "openai", model: "gpt-5" },
      },
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_RETRYABLE_FAILURE",
        message: "OpenClaw's model provider is rate limiting this turn.",
        provider: "openai",
        model: "gpt-5",
      },
    ],
    [
      "an unclassified error",
      { state: "error" },
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_RUN_FAILED",
        message: "OpenClaw could not complete this turn.",
      },
    ],
  ])("ends the turn as the native chat reports %s", async (_, chat, ended) => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 30,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          ...chat,
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events.at(-1)).toEqual(ended)
  })

  it("streams no partial tool output when tool events were not negotiated", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())
    const phases = [
      { phase: "start", name: "exec", toolCallId: "tool-1", args: {} },
      {
        phase: "update",
        name: "exec",
        toolCallId: "tool-1",
        partialResult: "partial-secret",
      },
    ]
    for (const [seq, data] of phases.entries())
      subscriptions.accept(
        {
          type: "event",
          event: "agent",
          seq,
          payload: {
            runId: "run-a",
            sessionKey: scope.sessionId,
            agentId: scope.agentId,
            seq,
            stream: "tool",
            ts: 1_000 + seq,
            data,
          },
        },
        subscriptions.generation
      )
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 30,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(JSON.stringify(events)).not.toContain("partial-secret")
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: TurnEventKind.ToolCallStarted,
        name: "exec",
        toolKind: ToolKind.Execute,
      })
    )
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: TurnEventKind.ToolCallOutputChunk })
    )
  })

  it("resubscribes and reconciles active-run identity without resending the prompt", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const original = await engine.start(scope, input())
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-a"] },
      inFlightRun: { runId: "run-a", text: "Recovered" },
    }

    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-a",
      position: original.recoveryPosition(),
    })
    const iterator = recovered.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        kind: TurnEventKind.TurnStarted,
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-a:assistant",
        text: "Recovered",
      },
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)

    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    await subscriptions.replaceGeneration("reconnect")
    await expect(recovered.settled).resolves.toBeUndefined()
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
    expect(
      native.calls.filter(
        ({ method }) => method === "sessions.messages.subscribe"
      )
    ).toHaveLength(2)
  })

  it("rejects reconnect history from a rotated foreign transcript generation", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-foreign",
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-a"] },
      inFlightRun: { runId: "run-a", text: "foreign" },
    }

    await expect(subscriptions.replaceGeneration("reconnect")).rejects.toThrow(
      "Invalid OpenClaw chat.history response"
    )
    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events.at(-1)).toMatchObject({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_CONNECTION_INTERRUPTED",
    })
  })

  it("recovers exact completed assistant text from authoritative history", async () => {
    const native = new ControlledNative()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Already completed" }],
          __openclaw: { runId: "run-a", id: "message-a", seq: 8 },
        },
      ],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })

    const handle = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-a",
    })
    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "run-a:assistant",
      text: "Already completed",
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(0)
  })

  it("recovers plan and tools from in-flight history and official session.tool without negotiated detail", async () => {
    const native = new ControlledNative()
    native.history = {
      sessionKey: scope.sessionId,
      sessionId: "transcript-a",
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-a"] },
      inFlightRun: {
        runId: "run-a",
        text: "Working",
        plan: {
          steps: [{ step: "Inspect", status: "in_progress" }],
        },
        events: [
          {
            runId: "run-a",
            seq: 0,
            stream: "tool",
            ts: 1_000,
            data: {
              phase: "start",
              name: "read",
              toolCallId: "recovered-tool",
              args: { secret: "history-secret" },
            },
          },
          {
            runId: "run-a",
            seq: 1,
            stream: "tool",
            ts: 1_001,
            data: {
              phase: "result",
              name: "read",
              toolCallId: "recovered-tool",
              result: { secret: "history-result" },
              isError: false,
            },
          },
        ],
      },
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawTurnEngine({ client: native, subscriptions })
    const handle = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-a",
    })

    const emitSessionTool = (seq: number, data: Record<string, unknown>) =>
      subscriptions.accept(
        {
          type: "event",
          event: "session.tool",
          seq: 50 + seq,
          payload: {
            runId: "run-a",
            sessionKey: scope.sessionId,
            sessionId: "transcript-a",
            agentId: scope.agentId,
            seq,
            stream: "tool",
            ts: 2_000 + seq,
            data,
          },
        },
        subscriptions.generation
      )
    emitSessionTool(2, {
      phase: "start",
      name: "search",
      toolCallId: "live-tool",
      args: { secret: "live-secret" },
    })
    emitSessionTool(3, {
      phase: "result",
      name: "search",
      toolCallId: "live-tool",
      result: { secret: "live-result" },
      isError: false,
    })
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 60,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
          message: { content: [{ type: "text", text: "Working" }] },
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("history-secret")
    expect(serialized).not.toContain("history-result")
    expect(serialized).not.toContain("live-secret")
    expect(serialized).not.toContain("live-result")
    expect(events).toEqual(
      expect.arrayContaining([
        {
          kind: TurnEventKind.PlanUpdated,
          todos: [{ id: "0", label: "Inspect", status: "active" }],
        },
        expect.objectContaining({
          kind: TurnEventKind.ToolCallStarted,
          toolCallId: "recovered-tool",
          name: "read",
          toolKind: ToolKind.Read,
        }),
        expect.objectContaining({
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: "recovered-tool",
          output: '{"status":"completed","isError":false}',
        }),
        expect.objectContaining({
          kind: TurnEventKind.ToolCallStarted,
          toolCallId: "live-tool",
        }),
        expect.objectContaining({
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: "live-tool",
          output: '{"status":"completed","isError":false}',
        }),
      ])
    )
  })
})
