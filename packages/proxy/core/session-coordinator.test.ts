import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import {
  ServerRunStopNotDispatchedError,
  type ServerRunEngine,
  type ServerAttachmentStage,
  type ServerRunHandle,
  type SessionScope,
} from "./runtime"
import {
  SessionCoordinator,
  type CoordinatedRunSubscription,
} from "./session-coordinator"

class EventSource implements ServerRunHandle {
  readonly #values: AGUIEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<AGUIEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly steer = vi.fn(async () => "steered" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor(readonly position = { epoch: "epoch-1", lastSeen: 0 }) {
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
    return this.position
  }
}

const scope: SessionScope = {
  agentId: "researcher",
  sessionId: "stored-1",
  threadId: "stored-1",
}

function input(runId: string, resume = false): RunAgentInput {
  return {
    threadId: scope.threadId,
    runId,
    state: {},
    messages: resume
      ? []
      : [{ id: `message-${runId}`, role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...(resume
      ? {
          resume: [
            {
              interruptId: "question-1",
              status: "resolved" as const,
              payload: { answers: [["yes"]] },
            },
          ],
        }
      : {}),
  }
}

function access(id: string, lane: "operator" | "guest" = "operator") {
  return {
    subscriberId: id,
    controllerId: id,
    lane,
    canControl: true,
  } as const
}

function reader(subscription: CoordinatedRunSubscription) {
  const iterator = subscription.events[Symbol.asyncIterator]()
  return () => iterator.next()
}

function coordinator(engine: ServerRunEngine) {
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

describe("SessionCoordinator", () => {
  it("passes one server-side attachment stage only to the admitted native turn", async () => {
    const source = new EventSource()
    const start = vi.fn(async () => source)
    const engine: ServerRunEngine = {
      start,
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const stage: ServerAttachmentStage = {
      public: [{ type: "file", filename: "notes.txt", mimeType: "text/plain" }],
      appendTo: (text) => text,
      cleanup: vi.fn(async () => undefined),
    }

    await sessions.start(scope, input("run-1"), access("one"), stage)

    expect(start).toHaveBeenCalledWith(scope, input("run-1"), stage)
  })

  it("fans one provider stream out to multiple reconnecting browsers", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const first = await sessions.start(scope, input("run-1"), access("one"))
    const readFirst = reader(first)

    source.emit({
      type: EventType.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    })
    await expect(readFirst()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: EventType.RUN_STARTED } },
    })

    const second = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 0 },
      access("two")
    )
    const readSecond = reader(second)
    await expect(readSecond()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: EventType.RUN_STARTED } },
    })

    source.emit({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    source.finish()

    await expect(readFirst()).resolves.toMatchObject({
      value: { sequence: 2, event: { type: EventType.RUN_FINISHED } },
    })
    await expect(readSecond()).resolves.toMatchObject({
      value: { sequence: 2, event: { type: EventType.RUN_FINISHED } },
    })
    expect(engine.start).toHaveBeenCalledOnce()
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("replays a compacted active run from the beginning after raw replay overflows", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a fresh browser")
      }),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    const emitted: AGUIEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        type: EventType.TEXT_MESSAGE_CONTENT as const,
        messageId: "assistant-1",
        delta: String(index % 10),
      })),
      ...Array.from({ length: 11 }, (_, index) => {
        const toolCallId = `tool-${index + 1}`
        return [
          {
            type: EventType.TOOL_CALL_START as const,
            toolCallId,
            toolCallName: "search",
            parentMessageId: "assistant-1",
          },
          {
            type: EventType.TOOL_CALL_ARGS as const,
            toolCallId,
            delta: `{"query":"${index + 1}"}`,
          },
          { type: EventType.TOOL_CALL_END as const, toolCallId },
          {
            type: EventType.TOOL_CALL_RESULT as const,
            messageId: `tool-result-${index + 1}`,
            toolCallId,
            content: `result-${index + 1}`,
            role: "tool" as const,
          },
        ]
      }).flat(),
    ]
    for (const event of emitted) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("refreshed")
    )
    const readRefreshed = reader(refreshed)

    const replayed = await Promise.all(
      Array.from({ length: 47 }, () => readRefreshed())
    )
    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      emitted[0],
      emitted[1],
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "0123456789012345678901234567890123456789",
      },
      ...emitted.slice(42),
    ])
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("compacts adjacent reasoning and tool argument deltas without interpreting them", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a fresh browser")
      }),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    const events: AGUIEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "reasoning-1",
        role: "reasoning",
      },
      ...Array.from({ length: 20 }, () => ({
        type: EventType.REASONING_MESSAGE_CONTENT as const,
        messageId: "reasoning-1",
        delta: "r",
      })),
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId: "reasoning-1",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "search",
        parentMessageId: "assistant-1",
      },
      ...Array.from({ length: 20 }, () => ({
        type: EventType.TOOL_CALL_ARGS as const,
        toolCallId: "tool-1",
        delta: "a",
      })),
    ]
    for (const event of events) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("refreshed")
    )
    const iterator = refreshed.events[Symbol.asyncIterator]()
    const replayed = await Promise.all(
      Array.from({ length: 6 }, () => iterator.next())
    )

    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      events[0],
      events[1],
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "r".repeat(20),
      },
      events[22],
      events[23],
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: "a".repeat(20),
      },
    ])
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("keeps fresh replay journals for only the five most recently used active Sessions", async () => {
    const sources = Array.from({ length: 6 }, () => new EventSource())
    let sourceIndex = 0
    const engine: ServerRunEngine = {
      start: vi.fn(async () => sources[sourceIndex++]!),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a missing journal")
      }),
    }
    const sessions = coordinator(engine)
    const active = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const id = index + 1
        const sessionScope = {
          agentId: "researcher",
          sessionId: `stored-${id}`,
          threadId: `stored-${id}`,
        }
        const runInput = {
          ...input(`run-${id}`),
          threadId: sessionScope.threadId,
        }
        const subscription = await sessions.start(
          sessionScope,
          runInput,
          access(`operator-${id}`)
        )
        const source = sources[index]!
        source.emit({
          type: EventType.RUN_STARTED,
          threadId: sessionScope.threadId,
          runId: runInput.runId,
        })
        await reader(subscription)()
        return { sessionScope, runInput, subscription }
      })
    )
    const oldest = active[0]!
    const newest = active.at(-1)!

    const evicted = await sessions.recover(
      oldest.sessionScope,
      {
        threadId: oldest.sessionScope.threadId,
        runId: oldest.runInput.runId,
      },
      access("refreshed-oldest")
    )
    await expect(reader(evicted)()).resolves.toMatchObject({
      value: {
        event: { type: EventType.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })

    const retained = await sessions.recover(
      newest.sessionScope,
      {
        threadId: newest.sessionScope.threadId,
        runId: newest.runInput.runId,
      },
      access("refreshed-newest")
    )
    expect((await reader(retained)()).done).toBe(false)
    expect(engine.recover).not.toHaveBeenCalled()
    for (const { subscription } of active) subscription.close()
  })

  it("drops the fresh replay journal after publishing a terminal event", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run after completion")
      }),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    source.emit({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    await expect(readInitial()).resolves.toMatchObject({
      value: { event: { type: EventType.RUN_FINISHED } },
    })

    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("refreshed")
    )
    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { type: EventType.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("delivers an event published at the fresh replay boundary exactly once", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    source.emit({
      type: EventType.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    })
    await reader(initial)()
    initial.close()
    let published = false
    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      {
        ...access("refreshed"),
        project(event) {
          if (!published && event.type === EventType.RUN_STARTED) {
            published = true
            source.emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "assistant-1",
              delta: "tail",
            })
          }
          return event
        },
      }
    )
    const readRefreshed = reader(refreshed)

    await expect(readRefreshed()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: EventType.RUN_STARTED } },
    })
    await expect(readRefreshed()).resolves.toMatchObject({
      value: {
        sequence: 2,
        event: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "tail" },
      },
    })
  })

  it("projects every event in a fresh replay through the subscriber access", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    source.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "private",
    })
    await reader(initial)()
    initial.close()

    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      {
        ...access("guest", "guest"),
        project(event) {
          return event.type === EventType.TEXT_MESSAGE_CONTENT
            ? { ...event, delta: "public" }
            : event
        },
      }
    )

    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "public" },
      },
    })
  })

  it("returns reset-required when an active run is too large to journal", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a fresh browser")
      }),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    source.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "x".repeat(300 * 1024),
    })
    await reader(initial)()
    initial.close()

    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("refreshed")
    )

    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { type: EventType.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("rejects fresh replay when the run belongs to another Agent or Session", async () => {
    const sources = [new EventSource(), new EventSource(), new EventSource()]
    let sourceIndex = 0
    const engine: ServerRunEngine = {
      start: vi.fn(async () => sources[sourceIndex++]!),
      recover: vi.fn(async () => sources[0]!),
    }
    const sessions = coordinator(engine)
    const scopes = [
      scope,
      { agentId: "writer", sessionId: scope.sessionId, threadId: "writer-1" },
      {
        agentId: scope.agentId,
        sessionId: "stored-2",
        threadId: "stored-2",
      },
    ]
    for (const [index, sessionScope] of scopes.entries()) {
      await sessions.start(
        sessionScope,
        {
          ...input(`run-${index + 1}`),
          threadId: sessionScope.threadId,
        },
        access(`operator-${index + 1}`)
      )
    }

    for (const sessionScope of scopes.slice(1)) {
      await expect(
        sessions.recover(
          sessionScope,
          { threadId: sessionScope.threadId, runId: "run-1" },
          access(`refresh-${sessionScope.threadId}`)
        )
      ).rejects.toThrow("An AOS run is already active")
    }
    await expect(
      sessions.recover(
        scope,
        { threadId: scope.threadId, runId: "unknown-run" },
        access("refresh-unknown")
      )
    ).rejects.toThrow("An AOS run is already active")
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("keeps provider work alive when every browser disconnects", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const subscription = await sessions.start(
      scope,
      input("run-1"),
      access("one")
    )

    subscription.close()

    expect(sessions.state(scope)).toBe("running")
    expect(source.stop).not.toHaveBeenCalled()
  })

  it("is idempotent for one admission and conflicts with a different turn", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))

    await expect(
      sessions.start(scope, input("run-1"), access("two"))
    ).resolves.toBeDefined()
    await expect(
      sessions.start(scope, input("run-2"), access("two"))
    ).rejects.toThrow("already active")
    expect(engine.start).toHaveBeenCalledOnce()
  })

  it("rejects a changed payload that reuses an admission run ID", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    const changed = {
      ...input("run-1"),
      messages: [
        { id: "message-run-1", role: "user" as const, content: "Changed" },
      ],
    }

    await expect(sessions.start(scope, changed, access("one"))).rejects.toThrow(
      "already active"
    )
    expect(engine.start).toHaveBeenCalledOnce()
  })

  it("accepts an idempotent admission regardless of object key insertion order", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const original = input("run-1")
    await sessions.start(scope, original, access("one"))
    const reordered = Object.fromEntries(
      Object.entries(original).reverse()
    ) as RunAgentInput

    await expect(
      sessions.start(scope, reordered, access("two"))
    ).resolves.toBeDefined()
    expect(engine.start).toHaveBeenCalledOnce()
  })

  it("retains an interrupted execution and resumes it as a fresh AG-UI segment", async () => {
    const interrupted = new EventSource()
    const resumed = new EventSource()
    const engine: ServerRunEngine = {
      start: vi
        .fn<ServerRunEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(resumed),
      recover: vi.fn(async () => resumed),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))
    interrupted.emit({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "question-1",
            reason: "input-required",
            responseSchema: { type: "object" },
          },
        ],
      },
    })
    interrupted.finish()
    await vi.waitFor(() =>
      expect(sessions.state(scope)).toBe("waiting-for-input")
    )

    await sessions.start(scope, input("run-2", true), access("operator"))

    expect(engine.start).toHaveBeenCalledTimes(2)
    expect(engine.start.mock.calls[1]?.[1]).toMatchObject({
      runId: "run-2",
      messages: [],
      resume: [{ interruptId: "question-1" }],
    })
    expect(sessions.state(scope)).toBe("running")
  })

  it("keeps Stop in stopping until the provider settles", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(sessions.stop(scope, "operator")).resolves.toBe("stopping")

    expect(sessions.state(scope)).toBe("stopping")
  })

  it("rechecks a stopping handle without granting another controller", async () => {
    const source = new EventSource()
    source.stop.mockResolvedValueOnce("stopping").mockResolvedValueOnce("idle")
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(sessions.stop(scope, "unrelated")).rejects.toThrow(
      "not authorized"
    )
    await expect(sessions.stop(scope, "operator")).resolves.toBe("stopping")
    await expect(sessions.stop(scope, "operator")).resolves.toBe("idle")
    expect(source.stop).toHaveBeenCalledTimes(2)
    expect(sessions.state(scope)).toBe("idle")
  })

  it("keeps a run active when Stop definitely was not dispatched", async () => {
    const source = new EventSource()
    const failure = new Error("Provider unavailable")
    source.stop.mockRejectedValueOnce(
      new ServerRunStopNotDispatchedError(failure)
    )
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(sessions.stop(scope, "operator")).rejects.toBe(failure)
    expect(sessions.state(scope)).toBe("running")
  })

  it("keeps an ambiguous Stop failure uncertain", async () => {
    const source = new EventSource()
    source.stop.mockRejectedValueOnce(new Error("Connection lost"))
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(sessions.stop(scope, "operator")).rejects.toThrow(
      "Connection lost"
    )
    expect(sessions.state(scope)).toBe("uncertain")
  })

  it("steers the matching active run once and publishes a replayable acknowledgement", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const subscription = await sessions.start(
      scope,
      input("run-1"),
      access("operator")
    )
    const read = reader(subscription)

    await expect(
      sessions.steer(
        scope,
        {
          requestId: "queue-item-1",
          expectedRunId: "run-1",
          text: "Use the newer API",
        },
        "operator"
      )
    ).resolves.toEqual({ status: "steered" })
    await expect(read()).resolves.toMatchObject({
      value: {
        sequence: 1,
        event: {
          type: EventType.CUSTOM,
          name: "aos.steer.accepted",
          value: {
            requestId: "queue-item-1",
            text: "Use the newer API",
            delivery: "steered",
          },
        },
      },
    })
    expect(source.steer).toHaveBeenCalledWith({
      requestId: "queue-item-1",
      text: "Use the newer API",
    })

    await expect(
      sessions.steer(
        scope,
        {
          requestId: "queue-item-1",
          expectedRunId: "run-1",
          text: "Use the newer API",
        },
        "operator"
      )
    ).resolves.toEqual({ status: "steered" })
    expect(source.steer).toHaveBeenCalledOnce()
  })

  it("rejects stale run identity, conflicting request reuse, and steering after Stop", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(
      sessions.steer(
        scope,
        { requestId: "one", expectedRunId: "stale", text: "Correction" },
        "operator"
      )
    ).rejects.toThrow("already active")
    await sessions.steer(
      scope,
      { requestId: "one", expectedRunId: "run-1", text: "Correction" },
      "operator"
    )
    await expect(
      sessions.steer(
        scope,
        { requestId: "one", expectedRunId: "run-1", text: "Different" },
        "operator"
      )
    ).rejects.toThrow("already active")

    await sessions.stop(scope, "operator")
    await expect(
      sessions.steer(
        scope,
        { requestId: "two", expectedRunId: "run-1", text: "Too late" },
        "operator"
      )
    ).rejects.toThrow("already active")
  })

  it("coalesces concurrent authoritative recovery", async () => {
    const source = new EventSource()
    let resolveRecovery!: (handle: ServerRunHandle) => void
    const pending = new Promise<ServerRunHandle>((resolve) => {
      resolveRecovery = resolve
    })
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(() => pending),
    }
    const sessions = coordinator(engine)
    const first = sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("one")
    )
    const second = sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("two")
    )

    resolveRecovery(source)
    await expect(first).resolves.toBeDefined()
    await expect(second).resolves.toBeDefined()
    expect(engine.recover).toHaveBeenCalledOnce()
  })

  it("preserves terminal resource ownership across uncertain recovery", async () => {
    const initial = new EventSource()
    const recovered = new EventSource()
    const onTerminal = vi.fn(async () => undefined)
    const engine: ServerRunEngine = {
      start: vi.fn(async () => initial),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), {
      ...access("operator"),
      onTerminal,
    })
    initial.emit({
      type: EventType.RUN_ERROR,
      message: "Delivery uncertain",
      code: "AOS_SEND_UNCERTAIN",
    })
    initial.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))

    await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("operator")
    )
    const terminal = {
      type: EventType.RUN_ERROR,
      message: "Slash commands cannot be sent with attachments.",
      code: "AOS_COMMAND_WITH_ATTACHMENTS",
    } as const
    recovered.emit(terminal)
    recovered.finish()

    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(2))
    expect(onTerminal).toHaveBeenLastCalledWith(terminal)
  })

  it("discovers one provider execution after a coordinator restart", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
      discover: vi.fn(async () => ({ handle: source, state: "running" })),
    }
    const sessions = coordinator(engine)

    const [first, second] = await Promise.all([
      sessions.discover(scope),
      sessions.discover(scope),
    ])

    expect(first).toBe(second)
    expect(engine.discover).toHaveBeenCalledOnce()
    expect(sessions.snapshot(scope)).toMatchObject({
      state: "running",
      runId: expect.stringMatching(/^aos-recovered-/u),
    })
    expect(engine.start).not.toHaveBeenCalled()
  })

  it("refreshes a discovered waiting execution from provider authority", async () => {
    const source = new EventSource()
    const interrupt = {
      id: "question-1",
      reason: "question",
      responseSchema: { type: "string" },
    }
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
      discover: vi
        .fn<NonNullable<ServerRunEngine["discover"]>>()
        .mockResolvedValueOnce({
          handle: source,
          state: "waiting-for-input",
          interrupts: [interrupt],
        })
        .mockResolvedValueOnce(undefined),
    }
    const sessions = coordinator(engine)

    const discovered = await sessions.discover(scope)
    expect(discovered?.state).toBe("waiting-for-input")
    expect(sessions.snapshot(scope)).toMatchObject({
      state: "waiting-for-input",
      interrupts: [interrupt],
    })

    await expect(sessions.discover(scope)).resolves.toBeUndefined()
    expect(engine.discover).toHaveBeenCalledTimes(2)
    expect(sessions.state(scope)).toBe("idle")
  })

  it("requires authoritative history for a run discovered after coordinator restart", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
      discover: vi.fn(async () => ({ handle: source, state: "running" })),
    }
    const sessions = coordinator(engine)
    await sessions.discover(scope)
    const runId = sessions.snapshot(scope).runId!
    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId },
      access("refreshed")
    )
    source.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "future-only",
    })

    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { type: EventType.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("admits a new turn after authoritative terminal settlement", async () => {
    const first = new EventSource()
    const second = new EventSource()
    const engine: ServerRunEngine = {
      start: vi
        .fn<ServerRunEngine["start"]>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      recover: vi.fn(async () => second),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))
    first.emit({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    first.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    await expect(
      sessions.start(scope, input("run-2"), access("operator"))
    ).resolves.toBeDefined()
    expect(engine.start).toHaveBeenCalledTimes(2)
  })
  it("keeps the journaled prefix across a recoverable interrupt", async () => {
    const interrupted = new EventSource()
    const recovered = new EventSource({ epoch: "epoch-1", lastSeen: 12 })
    const engine: ServerRunEngine = {
      start: vi.fn(async () => interrupted),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    const started = {
      type: EventType.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    } as const
    const textStart = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    } as const
    for (const event of [
      started,
      textStart,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Hel",
      } as const,
    ]) {
      interrupted.emit(event)
      await readLive()
    }
    interrupted.emit({
      type: EventType.RUN_ERROR,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    await readLive()
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    live.close()

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 4 },
      access("one")
    )
    const readRedial = reader(redial)
    // Every adapter opens a recovered segment with its own RUN_STARTED.
    recovered.emit(started)
    await readRedial()
    recovered.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "lo",
    })
    await readRedial()
    redial.close()

    const reload = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("two")
    )
    const readReload = reader(reload)
    const replayed = await Promise.all([
      readReload(),
      readReload(),
      readReload(),
    ])
    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      started,
      textStart,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Hello",
      },
    ])
    recovered.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "assistant-1",
    })
    await expect(readReload()).resolves.toMatchObject({
      value: { event: { type: EventType.TEXT_MESSAGE_END } },
    })
  })

  it("delivers recovered events to two redials sharing one cursor", async () => {
    const interrupted = new EventSource()
    const recovered = new EventSource({ epoch: "epoch-1", lastSeen: 12 })
    const engine: ServerRunEngine = {
      start: vi.fn(async () => interrupted),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    for (const event of [
      {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      } as const,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      } as const,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Hel",
      } as const,
    ]) {
      interrupted.emit(event)
      await readLive()
    }
    interrupted.emit({
      type: EventType.RUN_ERROR,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    await readLive()
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    live.close()

    const first = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 3 },
      access("one")
    )
    const readFirst = reader(first)
    const second = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 3 },
      access("two")
    )
    const readSecond = reader(second)
    recovered.emit({
      type: EventType.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    })
    recovered.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "lo",
    })

    const [leftStart, rightStart] = await Promise.all([
      readFirst(),
      readSecond(),
    ])
    expect(leftStart.value?.event).toMatchObject({
      type: EventType.RUN_STARTED,
    })
    expect(rightStart.value?.event).toMatchObject({
      type: EventType.RUN_STARTED,
    })
    const [left, right] = await Promise.all([readFirst(), readSecond()])
    expect(left.value?.event).toMatchObject({ delta: "lo" })
    expect(right.value?.event).toMatchObject({ delta: "lo" })
    expect(left.value?.sequence).toBeGreaterThan(4)
    expect(right.value?.sequence).toBe(left.value?.sequence)
    expect(engine.recover).toHaveBeenCalledOnce()
  })

  it("recovers an uncertain execution before refusing a new turn", async () => {
    const interrupted = new EventSource()
    const recovered = new EventSource({ epoch: "epoch-1", lastSeen: 7 })
    const admitted = new EventSource()
    const engine: ServerRunEngine = {
      start: vi
        .fn<ServerRunEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit({
      type: EventType.RUN_ERROR,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    // The provider answers the recovery with an already-finished run.
    recovered.emit({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    recovered.finish()

    const subscription = await sessions.start(
      scope,
      input("run-2"),
      access("one")
    )

    expect(subscription.runId).toBe("run-2")
    expect(engine.recover).toHaveBeenCalledWith(scope, {
      threadId: scope.threadId,
      runId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 0 },
    })
    expect(engine.start).toHaveBeenCalledTimes(2)
  })

  it("refuses a new turn when the recovered run is still running", async () => {
    const interrupted = new EventSource()
    const recovered = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => interrupted),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit({
      type: EventType.RUN_ERROR,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    recovered.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "still working",
    })

    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).rejects.toThrow("already active")
    expect(engine.recover).toHaveBeenCalledOnce()
    expect(sessions.state(scope)).toBe("running")
  })

  it("refuses a new turn when recovering an uncertain execution fails", async () => {
    const interrupted = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => interrupted),
      recover: vi.fn(async () => {
        throw new Error("provider unavailable")
      }),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit({
      type: EventType.RUN_ERROR,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))

    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).rejects.toThrow("already active")
    expect(engine.recover).toHaveBeenCalledOnce()
    expect(engine.start).toHaveBeenCalledOnce()
  })

  it("leaves an execution idle after a provider stream overflow", async () => {
    const overflowed = new EventSource()
    const admitted = new EventSource()
    const engine: ServerRunEngine = {
      start: vi
        .fn<ServerRunEngine["start"]>()
        .mockResolvedValueOnce(overflowed)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => admitted),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    overflowed.emit({
      type: EventType.RUN_ERROR,
      code: "AOS_STREAM_OVERFLOW",
      message: "The provider produced more events than AOS can buffer.",
    })
    overflowed.finish()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).resolves.toBeDefined()
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("settles a reset-required run so the next turn is admitted", async () => {
    const reset = new EventSource()
    const admitted = new EventSource()
    const engine: ServerRunEngine = {
      start: vi
        .fn<ServerRunEngine["start"]>()
        .mockResolvedValueOnce(reset)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => admitted),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    reset.emit({
      type: EventType.RUN_ERROR,
      code: "AOS_RESET_REQUIRED",
      message: "AOS run history must be reloaded before continuing.",
    })
    reset.finish()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).resolves.toBeDefined()
    expect(engine.recover).not.toHaveBeenCalled()
  })
})
