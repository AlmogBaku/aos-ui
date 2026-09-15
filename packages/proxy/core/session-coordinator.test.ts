import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import type { ServerRunEngine, ServerRunHandle, SessionScope } from "./runtime"
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

  it("keeps Stop idempotent and rejects an unrelated controller", async () => {
    const source = new EventSource()
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
    await expect(sessions.stop(scope, "operator")).resolves.toBe("stopping")
    expect(source.stop).toHaveBeenCalledOnce()
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
})
