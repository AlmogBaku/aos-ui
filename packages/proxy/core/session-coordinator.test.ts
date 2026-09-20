import { describe, expect, it, vi } from "vitest"

import {
  RunEventKind,
  type ExecutionEvent,
  type RunEvent,
  type TurnInput,
} from "./events"

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
  type SessionCoordinatorOptions,
} from "./session-coordinator"

class EventSource implements ServerRunHandle {
  readonly #values: RunEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<RunEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly steer = vi.fn(async () => "steered" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor(
    /** `null` for a segment that names no position a recovery can continue. */
    readonly position: { epoch: string; lastSeen: number } | null = {
      epoch: "epoch-1",
      lastSeen: 0,
    }
  ) {
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve
    })
  }

  readonly events: AsyncIterable<RunEvent> = {
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

  emit(event: RunEvent) {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.#values.push(event)
  }

  /** Ends the provider stream without reporting the turn settled. */
  close() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined })
  }

  /** The provider's own settlement signal for this segment. */
  settle() {
    this.#resolveSettled()
  }

  finish() {
    this.settle()
    this.close()
  }

  recoveryPosition() {
    return this.position ?? undefined
  }
}

const scope: SessionScope = {
  agentId: "researcher",
  sessionId: "stored-1",
  threadId: "stored-1",
}

const otherScope: SessionScope = {
  agentId: "researcher",
  sessionId: "stored-2",
  threadId: "stored-2",
}

function input(runId: string, resume = false): TurnInput {
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

function coordinator(
  engine: ServerRunEngine,
  limits: Partial<Omit<SessionCoordinatorOptions, "engine">> = {}
) {
  return new SessionCoordinator({
    engine,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: 8,
    maxSubscriberBytes: 64 * 1024,
    maxReplayEvents: 32,
    maxReplayBytes: 256 * 1024,
    ...limits,
  })
}

function runStarted(runId: string, target: SessionScope = scope) {
  return {
    type: RunEventKind.RUN_STARTED,
    threadId: target.threadId,
    runId,
  } as const
}

const interruptedError = {
  type: RunEventKind.RUN_ERROR,
  code: "AOS_CONNECTION_INTERRUPTED",
  message: "The provider connection was interrupted.",
} as const

/**
 * The first event a reload recovery replays: a journaled run replays its own
 * beginning, and a run without a journal answers `AOS_RESET_REQUIRED`.
 */
async function reloadedHead(
  sessions: SessionCoordinator,
  target: SessionScope,
  runId: string
) {
  const reload = await sessions.recover(
    target,
    { threadId: target.threadId, runId },
    access(`reload-${runId}`)
  )
  const head = await reader(reload)()
  reload.close()
  return head.value
}

/**
 * A journaled run in a second Session. A segment built with another Session's
 * cache key drops this journal, so replaying it is the cache-key contract.
 */
async function neighborRun(sessions: SessionCoordinator, source: EventSource) {
  const subscription = await sessions.start(
    otherScope,
    { ...input("neighbor-run"), threadId: otherScope.threadId },
    access("neighbor")
  )
  const read = reader(subscription)
  source.emit(runStarted("neighbor-run", otherScope))
  await read()
  subscription.close()
  return () => reloadedHead(sessions, otherScope, "neighbor-run")
}

/**
 * One run that streamed far more single-character deltas than a journal may
 * retain. Returns every event it delivered, in run sequence order.
 */
async function deltaFlood(
  sessions: SessionCoordinator,
  source: EventSource,
  deltas: number
) {
  const subscription = await sessions.start(
    scope,
    input("run-1"),
    access("initial")
  )
  const read = reader(subscription)
  const emitted: RunEvent[] = [
    runStarted("run-1"),
    {
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    },
    ...Array.from({ length: deltas }, (_, index) => ({
      type: RunEventKind.TEXT_MESSAGE_CONTENT as const,
      messageId: "assistant-1",
      delta: String(index % 10),
    })),
  ]
  for (const event of emitted) {
    source.emit(event)
    await read()
  }
  subscription.close()
  return emitted
}

/**
 * The oldest cursor a journal still replays, probed the way a browser redials.
 * Every cursor before it is answered with one reset instead of a partial run.
 */
async function oldestReplayableCursor(
  sessions: SessionCoordinator,
  highest: number
) {
  const resets = async (after: number) => {
    const probe = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after },
      access(`probe-${after}`)
    )
    const head = await reader(probe)()
    probe.close()
    const event = head.value?.event
    return (
      event?.type === RunEventKind.RUN_ERROR &&
      event.code === "AOS_RESET_REQUIRED"
    )
  }
  let low = 1
  let high = highest
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (await resets(middle)) low = middle + 1
    else high = middle
  }
  return low
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
      type: RunEventKind.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    })
    await expect(readFirst()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: RunEventKind.RUN_STARTED } },
    })

    const second = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 0 },
      access("two")
    )
    const readSecond = reader(second)
    await expect(readSecond()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: RunEventKind.RUN_STARTED } },
    })

    source.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    source.finish()

    await expect(readFirst()).resolves.toMatchObject({
      value: { sequence: 2, event: { type: RunEventKind.RUN_FINISHED } },
    })
    await expect(readSecond()).resolves.toMatchObject({
      value: { sequence: 2, event: { type: RunEventKind.RUN_FINISHED } },
    })
    expect(engine.start).toHaveBeenCalledOnce()
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("replays a compacted active run from the beginning for a cursorless reload", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a fresh browser")
      }),
    }
    const sessions = coordinator(engine, { maxReplayEvents: 64 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    const emitted: RunEvent[] = [
      {
        type: RunEventKind.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      },
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        type: RunEventKind.TEXT_MESSAGE_CONTENT as const,
        messageId: "assistant-1",
        delta: String(index % 10),
      })),
      ...Array.from({ length: 11 }, (_, index) => {
        const toolCallId = `tool-${index + 1}`
        return [
          {
            type: RunEventKind.TOOL_CALL_START as const,
            toolCallId,
            toolCallName: "search",
            parentMessageId: "assistant-1",
          },
          {
            type: RunEventKind.TOOL_CALL_ARGS as const,
            toolCallId,
            delta: `{"query":"${index + 1}"}`,
          },
          { type: RunEventKind.TOOL_CALL_END as const, toolCallId },
          {
            type: RunEventKind.TOOL_CALL_RESULT as const,
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
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "0123456789012345678901234567890123456789",
      },
      ...emitted.slice(42),
    ])

    // The compacted prefix is followed by the live tail of the same run.
    const tail = {
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "tail",
    } as const
    source.emit(tail)
    await expect(readRefreshed()).resolves.toMatchObject({
      value: { sequence: emitted.length + 1, event: tail },
    })
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
    const events: RunEvent[] = [
      {
        type: RunEventKind.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      },
      {
        type: RunEventKind.REASONING_MESSAGE_START,
        messageId: "reasoning-1",
        role: "reasoning",
      },
      ...Array.from({ length: 20 }, () => ({
        type: RunEventKind.REASONING_MESSAGE_CONTENT as const,
        messageId: "reasoning-1",
        delta: "r",
      })),
      {
        type: RunEventKind.REASONING_MESSAGE_END,
        messageId: "reasoning-1",
      },
      {
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "search",
        parentMessageId: "assistant-1",
      },
      ...Array.from({ length: 20 }, () => ({
        type: RunEventKind.TOOL_CALL_ARGS as const,
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
        type: RunEventKind.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "r".repeat(20),
      },
      events[22],
      events[23],
      {
        type: RunEventKind.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: "a".repeat(20),
      },
    ])
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("replays only the events after a redial cursor", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    for (const event of [
      runStarted("run-1"),
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      } as const,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "a",
      } as const,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "b",
      } as const,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "c",
      } as const,
    ]) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 4 },
      access("redial")
    )
    const readRedial = reader(redial)

    // A cursor never repeats a delta the browser already rendered, so the
    // journaled text is replayed from the cursor rather than from its merge.
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: 5,
        event: { type: RunEventKind.TEXT_MESSAGE_CONTENT, delta: "c" },
      },
    })
    source.emit({
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "d",
    })
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: 6,
        event: { type: RunEventKind.TEXT_MESSAGE_CONTENT, delta: "d" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("serves a redial cursor of a long run without native recovery", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    const emitted: RunEvent[] = [
      runStarted("run-1"),
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      },
      // More single-character deltas than one browser stream may buffer: the
      // journal compacts them, so the run stays replayable from any cursor.
      ...Array.from({ length: 38 }, (_, index) => ({
        type: RunEventKind.TEXT_MESSAGE_CONTENT as const,
        messageId: "assistant-1",
        delta: String(index % 10),
      })),
    ]
    for (const event of emitted) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: emitted.length - 1 },
      access("redial")
    )
    const readRedial = reader(redial)

    await expect(readRedial()).resolves.toMatchObject({
      value: { sequence: emitted.length, event: emitted.at(-1) },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("serves a reload and a redial from one journal at their own cursors", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    const textStart = {
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    } as const
    for (const event of [
      runStarted("run-1"),
      textStart,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "He",
      } as const,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "llo",
      } as const,
    ]) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 3 },
      access("redial")
    )
    const readRedial = reader(redial)
    const reload = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)

    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: 4,
        event: { type: RunEventKind.TEXT_MESSAGE_CONTENT, delta: "llo" },
      },
    })
    const replayed = await Promise.all([
      readReload(),
      readReload(),
      readReload(),
    ])
    expect(replayed.map((entry) => entry.value)).toEqual([
      { sequence: 1, event: runStarted("run-1") },
      { sequence: 2, event: textStart },
      {
        sequence: 4,
        event: {
          type: RunEventKind.TEXT_MESSAGE_CONTENT,
          messageId: "assistant-1",
          delta: "Hello",
        },
      },
    ])

    const tail = {
      type: RunEventKind.TEXT_MESSAGE_END,
      messageId: "assistant-1",
    } as const
    source.emit(tail)
    const live = await Promise.all([readRedial(), readReload()])
    expect(live.map((entry) => entry.value)).toEqual([
      { sequence: 5, event: tail },
      { sequence: 5, event: tail },
    ])
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("keeps a replay journal for every concurrently active Session", async () => {
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
          type: RunEventKind.RUN_STARTED,
          threadId: sessionScope.threadId,
          runId: runInput.runId,
        })
        await reader(subscription)()
        return { sessionScope, runInput, subscription }
      })
    )
    const oldest = active[0]!
    const newest = active.at(-1)!

    // The least recently used of six running Sessions still owns its history:
    // a Session is stranded only past the execution limit.
    const leastRecent = await sessions.recover(
      oldest.sessionScope,
      {
        threadId: oldest.sessionScope.threadId,
        runId: oldest.runInput.runId,
      },
      access("refreshed-oldest")
    )
    await expect(reader(leastRecent)()).resolves.toMatchObject({
      value: {
        sequence: 1,
        event: {
          type: RunEventKind.RUN_STARTED,
          runId: oldest.runInput.runId,
        },
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
    leastRecent.close()
    retained.close()
    for (const { subscription } of active) subscription.close()
  })

  it("forgets the replay journal of a Session beyond the execution limit", async () => {
    const sources = [new EventSource(), new EventSource()]
    let sourceIndex = 0
    const engine: ServerRunEngine = {
      start: vi.fn(async () => sources[sourceIndex++]!),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a missing journal")
      }),
    }
    const sessions = coordinator(engine, { maxActiveExecutions: 1 })
    const first = await sessions.start(scope, input("run-1"), access("one"))
    const readFirst = reader(first)
    sources[0]!.emit(runStarted("run-1"))
    await readFirst()
    // The provider stream ends settled without a terminal event, so this
    // Session is idle and still holds the journal of its last run.
    sources[0]!.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    first.close()

    const second = await sessions.start(
      otherScope,
      { ...input("run-2"), threadId: otherScope.threadId },
      access("two")
    )
    const readSecond = reader(second)
    sources[1]!.emit(runStarted("run-2", otherScope))
    await readSecond()

    await expect(reloadedHead(sessions, scope, "run-1")).resolves.toMatchObject(
      {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      }
    )
    await expect(
      reloadedHead(sessions, otherScope, "run-2")
    ).resolves.toMatchObject({
      sequence: 1,
      event: { type: RunEventKind.RUN_STARTED },
    })
    expect(engine.recover).not.toHaveBeenCalled()
    second.close()
  })

  it("serves the redial after a reset from the live segment of an overflowed run", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a live segment")
      }),
    }
    const sessions = coordinator(engine, { maxReplayEvents: 4 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    for (const [index] of Array.from({ length: 6 }).entries()) {
      source.emit({
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: `tool-${index + 1}`,
        toolCallName: "search",
        parentMessageId: "assistant-1",
      })
      await readInitial()
    }
    initial.close()

    // The browser reloaded the authoritative history after the one reset, so
    // the run it is still watching answers this cursor with its live events.
    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 0 },
      access("redial")
    )
    const readRedial = reader(redial)
    source.emit({
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    })

    await expect(readRedial()).resolves.toMatchObject({
      value: { sequence: 7, event: { type: RunEventKind.TEXT_MESSAGE_START } },
    })
    expect(sessions.state(scope)).toBe("running")
    expect(engine.recover).not.toHaveBeenCalled()
    redial.close()
  })

  it("journals a delta-heavy run whose compacted replay fits the replay bound", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    // Every raw delta event costs more than its delta, so 120 of them exceed
    // the event bound long before the one event they compact into does. The
    // bytes bound is the retention cap of the raw entries too, so it is set
    // where this run's own raw events still fit inside it.
    const sessions = coordinator(engine, { maxReplayBytes: 32 * 1024 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    const textStart = {
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    } as const
    for (const event of [runStarted("run-1"), textStart]) {
      source.emit(event)
      await readInitial()
    }
    for (const delta of Array.from({ length: 120 }, () => "abcd")) {
      source.emit({
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta,
      })
      await readInitial()
    }
    initial.close()

    const reload = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)
    const replayed = await Promise.all([
      readReload(),
      readReload(),
      readReload(),
    ])

    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      runStarted("run-1"),
      textStart,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "abcd".repeat(120),
      },
    ])
    expect(engine.recover).not.toHaveBeenCalled()
    reload.close()
  })

  it("holds a delta flood to the retention cap and replays a cursor inside it", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine, { maxReplayBytes: 2 * 1024 })
    const emitted = await deltaFlood(sessions, source, 400)
    const total = emitted.length

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: total - 3 },
      access("redial")
    )
    const readRedial = reader(redial)
    // A cursor the journal still holds replays exactly the deltas after it.
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: total,
        event: { type: RunEventKind.TEXT_MESSAGE_CONTENT, delta: "789" },
      },
    })
    redial.close()

    // What one journal retains is bounded by the cap and not by the length of
    // the run: this flood streamed an order of magnitude more raw events.
    const oldest = await oldestReplayableCursor(sessions, total)
    const entryBytes = new TextEncoder().encode(
      JSON.stringify(emitted.at(-1))
    ).byteLength
    expect(total - oldest).toBeLessThanOrEqual(
      Math.ceil((2 * 1024) / entryBytes)
    )
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("returns reset-required once for a redial before the retained prefix", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine, { maxReplayBytes: 2 * 1024 })
    await deltaFlood(sessions, source, 400)

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 1 },
      access("redial")
    )
    const readRedial = reader(redial)
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readRedial()).resolves.toMatchObject({ done: true })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("returns reset-required once for a cursorless reload of a pruned run", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine, { maxReplayBytes: 2 * 1024 })
    await deltaFlood(sessions, source, 400)

    // The journal no longer holds this run from its beginning, so a reload that
    // owns nothing is owed authoritative history instead of a partial replay.
    const reload = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)
    await expect(readReload()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readReload()).resolves.toMatchObject({ done: true })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("serves the redial after a reset from the live segment of a pruned run", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a live segment")
      }),
    }
    const sessions = coordinator(engine, { maxReplayBytes: 2 * 1024 })
    const emitted = await deltaFlood(sessions, source, 400)

    // The browser reloaded the authoritative history after the one reset, so
    // the run it is still watching answers this cursor with its live events.
    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 0 },
      access("redial")
    )
    const readRedial = reader(redial)
    const tail = {
      type: RunEventKind.TEXT_MESSAGE_END,
      messageId: "assistant-1",
    } as const
    source.emit(tail)

    await expect(readRedial()).resolves.toMatchObject({
      value: { sequence: emitted.length + 1, event: tail },
    })
    expect(sessions.state(scope)).toBe("running")
    expect(engine.recover).not.toHaveBeenCalled()
    redial.close()
  })

  it("answers a retried admission of a pruned run from its live segment", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a live segment")
      }),
    }
    const sessions = coordinator(engine, { maxReplayBytes: 2 * 1024 })
    const emitted = await deltaFlood(sessions, source, 400)

    // A retry of the same admission reads the run from its beginning, and a
    // pruned journal no longer holds that beginning: replaying its surviving
    // deltas would open with content of a message this reader never saw start.
    const retried = await sessions.start(
      scope,
      input("run-1"),
      access("retried")
    )
    const readRetried = reader(retried)
    const tail = {
      type: RunEventKind.TEXT_MESSAGE_END,
      messageId: "assistant-1",
    } as const
    source.emit(tail)

    await expect(readRetried()).resolves.toMatchObject({
      value: { sequence: emitted.length + 1, event: tail },
    })
    expect(engine.start).toHaveBeenCalledOnce()
    retried.close()
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
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    await expect(readInitial()).resolves.toMatchObject({
      value: { event: { type: RunEventKind.RUN_FINISHED } },
    })

    const refreshed = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("refreshed")
    )
    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("answers a redial for a settled run with reset-required", async () => {
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
    source.emit(runStarted("run-1"))
    await readInitial()
    source.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    source.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    // Provider history owns a run that ended, so a redial that missed the last
    // events reloads it instead of replaying a journal AOS no longer keeps.
    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 1 },
      access("redial")
    )
    const readRedial = reader(redial)
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readRedial()).resolves.toMatchObject({ done: true })
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
      type: RunEventKind.RUN_STARTED,
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
          if (!published && event.type === RunEventKind.RUN_STARTED) {
            published = true
            source.emit({
              type: RunEventKind.TEXT_MESSAGE_CONTENT,
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
      value: { sequence: 1, event: { type: RunEventKind.RUN_STARTED } },
    })
    await expect(readRefreshed()).resolves.toMatchObject({
      value: {
        sequence: 2,
        event: { type: RunEventKind.TEXT_MESSAGE_CONTENT, delta: "tail" },
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
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
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
          return event.type === RunEventKind.TEXT_MESSAGE_CONTENT
            ? { ...event, delta: "public" }
            : event
        },
      }
    )

    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.TEXT_MESSAGE_CONTENT, delta: "public" },
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
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
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
    const readRefreshed = reader(refreshed)

    await expect(readRefreshed()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    // One overflow answers one reset: the stream ends after it.
    await expect(readRefreshed()).resolves.toMatchObject({ done: true })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("returns reset-required once when an active run journals more events than AOS can replay", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a fresh browser")
      }),
    }
    const sessions = coordinator(engine, { maxReplayEvents: 4 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    for (const [index] of Array.from({ length: 6 }).entries()) {
      source.emit({
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: `tool-${index + 1}`,
        toolCallName: "search",
        parentMessageId: "assistant-1",
      })
      await readInitial()
    }
    initial.close()

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 3 },
      access("redial")
    )
    const readRedial = reader(redial)
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readRedial()).resolves.toMatchObject({ done: true })

    const reload = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)
    await expect(readReload()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readReload()).resolves.toMatchObject({ done: true })
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
    ) as TurnInput

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
      type: RunEventKind.RUN_FINISHED,
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

  it("reports a Session idle when its run terminates after every browser detached", async () => {
    const source = new EventSource()
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    const live = await sessions.start(scope, input("run-1"), access("one"))
    source.emit(runStarted("run-1"))
    await reader(live)()
    live.close()

    source.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    source.finish()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
  })

  it("leaves a Session idle when Stop answers after the run already finished", async () => {
    const source = new EventSource()
    let answerStop = () => {}
    source.stop.mockImplementationOnce(
      () =>
        new Promise<"stopping">((resolve) => {
          answerStop = () => resolve("stopping")
        })
    )
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    await sessions.start(scope, input("run-1"), access("operator"))
    const stopping = sessions.stop(scope, "operator")

    source.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    source.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    answerStop()

    await expect(stopping).resolves.toBe("stopping")
    expect(sessions.state(scope)).toBe("idle")
  })

  it("leaves a Session idle when an undispatched Stop answers after the run finished", async () => {
    const source = new EventSource()
    const failure = new Error("Provider unavailable")
    let refuseStop = () => {}
    source.stop.mockImplementationOnce(
      () =>
        new Promise<"stopping">((_resolve, reject) => {
          refuseStop = () =>
            reject(new ServerRunStopNotDispatchedError(failure))
        })
    )
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    await sessions.start(scope, input("run-1"), access("operator"))
    const stopping = sessions.stop(scope, "operator")

    source.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    source.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    refuseStop()

    await expect(stopping).rejects.toBe(failure)
    expect(sessions.state(scope)).toBe("idle")
  })

  it("does not reopen a Session whose stream died when Stop answers afterwards", async () => {
    const source = new EventSource()
    let answerStop = () => {}
    source.stop.mockImplementationOnce(
      () =>
        new Promise<"stopping">((resolve) => {
          answerStop = () => resolve("stopping")
        })
    )
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    await sessions.start(scope, input("run-1"), access("operator"))
    const stopping = sessions.stop(scope, "operator")

    // The stream ends without a terminal event and without settling.
    source.close()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    answerStop()

    await expect(stopping).resolves.toBe("stopping")
    expect(sessions.state(scope)).toBe("uncertain")
  })

  it("keeps a resumed turn running when a Stop issued against the previous segment answers late", async () => {
    const interrupted = new EventSource()
    const resumed = new EventSource()
    let answerStop = () => {}
    interrupted.stop.mockImplementationOnce(
      () =>
        new Promise<"stopping">((resolve) => {
          answerStop = () => resolve("stopping")
        })
    )
    const sessions = coordinator({
      start: vi
        .fn<ServerRunEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(resumed),
      recover: vi.fn(async () => resumed),
    })
    await sessions.start(scope, input("run-1"), access("operator"))
    const stopping = sessions.stop(scope, "operator")

    interrupted.emit({
      type: RunEventKind.RUN_FINISHED,
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
    answerStop()

    await expect(stopping).resolves.toBe("stopping")
    // The answered Stop belongs to run-1; run-2 is a live turn of its own.
    expect(sessions.state(scope)).toBe("running")
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
          type: RunEventKind.CUSTOM,
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

  it("replays a recovered run from its start when its sequence is renumbered", async () => {
    const recovered = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => recovered),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)

    // No execution survived, so the cursor this browser holds belongs to a
    // sequence the recovered segment does not continue.
    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 57 },
      access("redial")
    )
    const readRedial = reader(redial)
    recovered.emit(runStarted("run-1"))

    await expect(readRedial()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: RunEventKind.RUN_STARTED } },
    })
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
      type: RunEventKind.RUN_ERROR,
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
      type: RunEventKind.RUN_ERROR,
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
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "future-only",
    })

    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("requires authoritative history for a cursorless reload after recovering a discovered run", async () => {
    const discovered = new EventSource()
    const recovered = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => discovered),
      recover: vi.fn(async () => recovered),
      discover: vi.fn(async () => ({
        handle: discovered,
        state: "running" as const,
      })),
    }
    const sessions = coordinator(engine)
    await sessions.discover(scope)
    const runId = sessions.snapshot(scope).runId!
    const live = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId, after: 0 },
      access("live")
    )
    const readLive = reader(live)
    for (const event of [
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      } as const,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Hel",
      } as const,
      interruptedError,
    ]) {
      discovered.emit(event)
      await readLive()
    }
    discovered.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    live.close()

    // The recovered segment inherits a journal that never held this run's
    // beginning, so a reload is owed authoritative history, not that prefix.
    const reload = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId },
      access("reload")
    )
    const readReload = reader(reload)
    await expect(readReload()).resolves.toMatchObject({
      value: {
        event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readReload()).resolves.toMatchObject({ done: true })
    expect(engine.recover).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("running"))
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
      type: RunEventKind.RUN_FINISHED,
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
      type: RunEventKind.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    } as const
    const textStart = {
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    } as const
    for (const event of [
      started,
      textStart,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Hel",
      } as const,
    ]) {
      interrupted.emit(event)
      await readLive()
    }
    interrupted.emit({
      type: RunEventKind.RUN_ERROR,
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
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
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
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Hello",
      },
    ])
    recovered.emit({
      type: RunEventKind.TEXT_MESSAGE_END,
      messageId: "assistant-1",
    })
    await expect(readReload()).resolves.toMatchObject({
      value: { event: { type: RunEventKind.TEXT_MESSAGE_END } },
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
        type: RunEventKind.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      } as const,
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      } as const,
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Hel",
      } as const,
    ]) {
      interrupted.emit(event)
      await readLive()
    }
    interrupted.emit({
      type: RunEventKind.RUN_ERROR,
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
      type: RunEventKind.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    })
    recovered.emit({
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "lo",
    })

    const [leftStart, rightStart] = await Promise.all([
      readFirst(),
      readSecond(),
    ])
    expect(leftStart.value?.event).toMatchObject({
      type: RunEventKind.RUN_STARTED,
    })
    expect(rightStart.value?.event).toMatchObject({
      type: RunEventKind.RUN_STARTED,
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
      type: RunEventKind.RUN_ERROR,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    // The provider answers the recovery with an already-finished run.
    recovered.emit({
      type: RunEventKind.RUN_FINISHED,
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

  it("recovers without a position when the replaced segment names none", async () => {
    const restored = new EventSource(null)
    const recovered = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => restored),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    restored.emit(interruptedError)
    restored.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 1 },
      access("two")
    )

    // A fabricated position could never match a provider epoch, so the recovery
    // asks for the run itself rather than for an interval nothing owns.
    expect(engine.recover).toHaveBeenCalledWith(scope, {
      threadId: scope.threadId,
      runId: "run-1",
    })
    redial.close()
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
      type: RunEventKind.RUN_ERROR,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    recovered.emit({
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "still working",
    })

    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).rejects.toThrow("already active")
    expect(engine.recover).toHaveBeenCalledOnce()
    expect(sessions.state(scope)).toBe("running")
  })

  it("admits a new turn when a recovered terminal needs more than one macrotask", async () => {
    vi.useFakeTimers()
    try {
      const interrupted = new EventSource()
      const recovered = new EventSource()
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
      interrupted.emit(interruptedError)
      interrupted.finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(sessions.state(scope)).toBe("uncertain")

      const turn = sessions.start(scope, input("run-2"), access("one"))
      // The provider answers the recovery with a run that finished, and it
      // takes more than the one event-loop turn a timer would have allowed.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      recovered.emit({
        type: RunEventKind.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      })
      recovered.finish()

      await expect(turn).resolves.toMatchObject({ runId: "run-2" })
      expect(engine.start).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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
      type: RunEventKind.RUN_ERROR,
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

  it("keeps a Session uncertain when a Stop cannot be confirmed", async () => {
    const stopped = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => stopped),
      recover: vi.fn(async () => new EventSource()),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    stopped.emit(runStarted("run-1"))
    await readLive()
    // The adapter stopped consuming a run Hermes may still be running, so the
    // turn is not over: the journal outlives the error and a new turn waits.
    stopped.emit({
      type: RunEventKind.RUN_ERROR,
      code: "AOS_STOP_UNCERTAIN",
      message: "Stop could not be confirmed.",
    })
    await readLive()
    stopped.finish()
    live.close()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    await expect(reloadedHead(sessions, scope, "run-1")).resolves.toMatchObject(
      { event: { type: RunEventKind.RUN_STARTED } }
    )
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
      type: RunEventKind.RUN_ERROR,
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
      type: RunEventKind.RUN_ERROR,
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

  it("threads cache key, journal, sequence and terminal hook into a started segment", async () => {
    const source = new EventSource()
    const neighbor = new EventSource()
    const onTerminal = vi.fn(async () => undefined)
    const engine: ServerRunEngine = {
      start: vi.fn(async (target: SessionScope) =>
        target.sessionId === otherScope.sessionId ? neighbor : source
      ),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine)
    const reloadNeighbor = await neighborRun(sessions, neighbor)

    const live = await sessions.start(scope, input("run-1"), {
      ...access("one"),
      onTerminal,
    })
    const readLive = reader(live)
    source.emit(runStarted("run-1"))
    await expect(readLive()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: RunEventKind.RUN_STARTED } },
    })

    await expect(reloadedHead(sessions, scope, "run-1")).resolves.toMatchObject(
      {
        sequence: 1,
        event: { type: RunEventKind.RUN_STARTED },
      }
    )
    await expect(reloadNeighbor()).resolves.toMatchObject({
      sequence: 1,
      event: { type: RunEventKind.RUN_STARTED },
    })

    const terminal = {
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    } as const
    source.emit(terminal)
    source.finish()
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1))
    expect(onTerminal).toHaveBeenCalledWith(terminal)
  })

  it("threads cache key, inherited journal, sequence and terminal hook into a recovered segment", async () => {
    const interrupted = new EventSource()
    const recovered = new EventSource({ epoch: "epoch-1", lastSeen: 1 })
    const neighbor = new EventSource()
    const onTerminal = vi.fn(async () => undefined)
    const engine: ServerRunEngine = {
      start: vi.fn(async (target: SessionScope) =>
        target.sessionId === otherScope.sessionId ? neighbor : interrupted
      ),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    const reloadNeighbor = await neighborRun(sessions, neighbor)

    const live = await sessions.start(scope, input("run-1"), {
      ...access("one"),
      onTerminal,
    })
    const readLive = reader(live)
    interrupted.emit(runStarted("run-1"))
    await readLive()
    interrupted.emit(interruptedError)
    await readLive()
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    live.close()

    const redial = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: "run-1", after: 2 },
      access("one")
    )
    const readRedial = reader(redial)
    recovered.emit(runStarted("run-1"))
    // One run keeps one monotonic sequence across its segments.
    await expect(readRedial()).resolves.toMatchObject({
      value: { sequence: 3, event: { type: RunEventKind.RUN_STARTED } },
    })

    await expect(reloadedHead(sessions, scope, "run-1")).resolves.toMatchObject(
      {
        sequence: 1,
        event: { type: RunEventKind.RUN_STARTED },
      }
    )
    await expect(reloadNeighbor()).resolves.toMatchObject({
      sequence: 1,
      event: { type: RunEventKind.RUN_STARTED },
    })

    const terminal = {
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    } as const
    recovered.emit(terminal)
    recovered.finish()
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(2))
    expect(onTerminal).toHaveBeenLastCalledWith(terminal)
  })

  it("threads cache key, absent journal, sequence and terminal hook into a discovered segment", async () => {
    const discovered = new EventSource()
    const neighbor = new EventSource()
    const onTerminal = vi.fn(async () => undefined)
    const engine: ServerRunEngine = {
      start: vi.fn(async () => neighbor),
      recover: vi.fn(async () => discovered),
      discover: vi.fn(async () => ({
        handle: discovered,
        state: "running" as const,
      })),
    }
    const sessions = coordinator(engine)
    const reloadNeighbor = await neighborRun(sessions, neighbor)

    await sessions.discover(scope)
    const runId = sessions.snapshot(scope).runId
    expect(runId).toBeDefined()
    // A discovered run owns no request-scoped resources, so it carries no
    // terminal hook; a later subscriber cannot install one either.
    const live = await sessions.recover(
      scope,
      { threadId: scope.threadId, runId: runId!, after: 0 },
      { ...access("one"), onTerminal }
    )
    const readLive = reader(live)
    discovered.emit({
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    })
    await expect(readLive()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: RunEventKind.TEXT_MESSAGE_START } },
    })

    // AOS never saw this run start, so there is nothing to replay.
    await expect(reloadedHead(sessions, scope, runId!)).resolves.toMatchObject({
      event: { type: RunEventKind.RUN_ERROR, code: "AOS_RESET_REQUIRED" },
    })
    await expect(reloadNeighbor()).resolves.toMatchObject({
      sequence: 1,
      event: { type: RunEventKind.RUN_STARTED },
    })

    discovered.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: runId!,
      outcome: { type: "success" },
    })
    discovered.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it("threads cache key, fresh journal, sequence and terminal hook into a resumed segment", async () => {
    const interrupted = new EventSource()
    const resumed = new EventSource()
    const neighbor = new EventSource()
    const onTerminal = vi.fn(async () => undefined)
    const sources = [interrupted, resumed]
    const engine: ServerRunEngine = {
      start: vi.fn(async (target: SessionScope) =>
        target.sessionId === otherScope.sessionId ? neighbor : sources.shift()!
      ),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine)
    const reloadNeighbor = await neighborRun(sessions, neighbor)

    await sessions.start(scope, input("run-1"), {
      ...access("one"),
      onTerminal,
    })
    interrupted.emit({
      type: RunEventKind.RUN_FINISHED,
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

    const live = await sessions.start(
      scope,
      input("run-2", true),
      access("one")
    )
    const readLive = reader(live)
    resumed.emit(runStarted("run-2"))
    // A resumed turn is a fresh AG-UI segment: its own journal and sequence.
    await expect(readLive()).resolves.toMatchObject({
      value: { sequence: 1, event: { type: RunEventKind.RUN_STARTED } },
    })
    await expect(reloadedHead(sessions, scope, "run-2")).resolves.toMatchObject(
      {
        sequence: 1,
        event: { type: RunEventKind.RUN_STARTED },
      }
    )
    await expect(reloadNeighbor()).resolves.toMatchObject({
      sequence: 1,
      event: { type: RunEventKind.RUN_STARTED },
    })

    resumed.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-2",
      outcome: { type: "success" },
    })
    resumed.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    // The resumed segment carries no terminal hook of its own.
    expect(onTerminal).toHaveBeenCalledTimes(1)
  })

  it("settles an execution whose provider stream ends after the turn settled", async () => {
    const source = new EventSource()
    const admitted = new EventSource()
    const engine: ServerRunEngine = {
      start: vi
        .fn<ServerRunEngine["start"]>()
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => admitted),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    source.emit(runStarted("run-1"))
    await readLive()

    // The provider reported this turn over without a terminal AG-UI event.
    source.settle()
    source.close()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).resolves.toBeDefined()
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("leaves an execution uncertain when its provider stream ends unsettled", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    source.emit(runStarted("run-1"))
    await readLive()

    source.close()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
  })
  it("observes the lifecycle of a run it drives under public identity", async () => {
    const source = new EventSource()
    const engine: ServerRunEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const observed: ExecutionEvent[] = []
    sessions.observe((event) => observed.push(event))

    await sessions.start(scope, input("run-1"), access("one"))
    source.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    source.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    expect(observed.map(({ type, runId }) => [type, runId])).toEqual([
      ["run-started", "run-1"],
      ["run-finished", "run-1"],
    ])
    expect(observed[0]).toMatchObject({
      agentId: scope.agentId,
      sessionId: scope.threadId,
    })
    expect(Number.isNaN(Date.parse(observed[0]!.occurredAt))).toBe(false)
  })

  it("observes one attention request per interrupt and resolves it on resume", async () => {
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
    const observed: ExecutionEvent[] = []
    sessions.observe((event) => observed.push(event))

    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "question-1",
            reason: "question",
            responseSchema: { type: "object" },
          },
        ],
      },
    })
    interrupted.finish()
    await vi.waitFor(() =>
      expect(sessions.state(scope)).toBe("waiting-for-input")
    )

    await sessions.start(scope, input("run-2", true), access("one"))

    expect(observed.map(({ type, runId }) => [type, runId])).toEqual([
      ["run-started", "run-1"],
      ["attention-requested", "run-1"],
      ["attention-resolved", "run-1"],
      ["run-started", "run-2"],
    ])
    expect(observed[1]).toMatchObject({ request: { id: "question-1" } })
    expect(observed[2]).toMatchObject({ interruptId: "question-1" })
  })

  it("observes a failed run and stops delivering after unsubscribing", async () => {
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
    const observed: ExecutionEvent[] = []
    const unobserve = sessions.observe((event) => observed.push(event))

    await sessions.start(scope, input("run-1"), access("one"))
    first.emit({
      type: RunEventKind.RUN_ERROR,
      code: "AOS_PROVIDER_FAILED",
      message: "The provider rejected the turn.",
    })
    first.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    expect(observed.map(({ type, runId }) => [type, runId])).toEqual([
      ["run-started", "run-1"],
      ["run-failed", "run-1"],
    ])

    unobserve()
    await sessions.start(scope, input("run-2"), access("one"))
    second.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-2",
      outcome: { type: "success" },
    })
    second.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    expect(observed).toHaveLength(2)
  })
})
