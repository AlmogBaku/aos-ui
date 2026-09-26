import { describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import {
  PendingRequestKind,
  TurnEventKind,
  type ExecutionEvent,
  type TurnEvent,
  type PromptTurnInput,
} from "./events"

import {
  ServerRequestStaleError,
  ServerSessionNotFoundError,
  ServerTurnCapacityError,
  ServerTurnConflictError,
  ServerTurnStopNotDispatchedError,
  ServerTurnUncertainError,
  type ServerTurnEngine,
  type ServerAttachmentStage,
  type ServerTurnHandle,
  type SessionScope,
} from "./runtime"
import {
  ADMISSION_DEADLINE_MS,
  CLIENT_ADMISSIONS,
  RECONCILE_BACKOFF,
  UNCERTAINTY_DEADLINE_MS,
} from "./limits"
import {
  ReplayCursorLostError,
  ServerClientIdReusedError,
  SessionCoordinator,
  type CoordinatedTurnSubscription,
  type SessionCoordinatorOptions,
} from "./session-coordinator"
import { READY_LINK } from "./link"
import { FanoutOverflowError } from "./subscriber-fanout"

class EventSource implements ServerTurnHandle {
  readonly #values: TurnEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<TurnEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly steer = vi.fn(async () => "steered" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor(
    /** `null` for a segment that names no position a recovery can continue. */
    readonly position: string | null = "token-1"
  ) {
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve
    })
  }

  readonly events: AsyncIterable<TurnEvent> = {
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

  emit(event: TurnEvent) {
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
  providerSessionId: "stored-1",
  sessionId: "stored-1",
}

const otherScope: SessionScope = {
  agentId: "researcher",
  providerSessionId: "stored-2",
  sessionId: "stored-2",
}

function input(turnId: string): PromptTurnInput {
  return { turnId, messageId: `message-${turnId}`, prompt: "Hello" }
}

/** The answer to the one question a paused test turn asks. */
const REPLY = {
  requestId: "question-1",
  status: "resolved",
  payload: { answers: [["yes"]] },
} as const

/** Answers the paused turn's one question; returns the turn that continues. */
async function continueTurn(sessions: SessionCoordinator) {
  const continued = await sessions.answer(scope, REPLY)
  if (!continued) throw new Error("The answer did not continue the turn")
  return continued.turnId
}

function access(id: string) {
  return { membershipId: id, principalId: id }
}

function reader(subscription: CoordinatedTurnSubscription) {
  const iterator = subscription.events[Symbol.asyncIterator]()
  return () => iterator.next()
}

function coordinator(
  engine: ServerTurnEngine,
  limits: Partial<Omit<SessionCoordinatorOptions, "engine">> = {}
) {
  return new SessionCoordinator({
    engine,
    // No test here subscribes anything to a reading.
    readings: {
      context: vi.fn(),
      models: vi.fn(),
      publicError: () => undefined,
      link: READY_LINK,
    },
    maxActiveExecutions: 8,
    maxSubscriberEvents: 8,
    maxSubscriberBytes: 64 * 1024,
    logger: captureLogs().logger,
    ...limits,
  })
}

const turnStarted = { kind: TurnEventKind.TurnStarted } as const
/** The start a journal replays, dated where the turn began. */
const datedStart = { ...turnStarted, startedAt: expect.any(String) }
const turnEnded = { kind: TurnEventKind.TurnEnded } as const

const interruptedError = {
  kind: TurnEventKind.TurnFailed,
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
  turnId: string
) {
  const reload = await sessions.recover(
    target,
    { sessionId: target.sessionId, turnId },
    access(`reload-${turnId}`)
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
    input("neighbor-run"),
    access("neighbor")
  )
  const read = reader(subscription)
  source.emit(turnStarted)
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
  const emitted: TurnEvent[] = [
    turnStarted,
    ...Array.from({ length: deltas }, (_, index) => ({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: String(index % 10),
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
 * Every cursor before it is refused instead of answered with a partial run.
 */
async function oldestReplayableCursor(
  sessions: SessionCoordinator,
  highest: number
) {
  const lost = async (after: number) => {
    const probe = await sessions
      .recover(
        scope,
        { sessionId: scope.sessionId, turnId: "run-1", after },
        access(`probe-${after}`)
      )
      .catch((error: unknown) => {
        if (error instanceof ReplayCursorLostError) return null
        throw error
      })
    probe?.close()
    return probe === null
  }
  let low = 1
  let high = highest
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (await lost(middle)) low = middle + 1
    else high = middle
  }
  return low
}

describe("SessionCoordinator", () => {
  it("passes one server-side attachment stage only to the admitted native turn", async () => {
    const source = new EventSource()
    const start = vi.fn(async () => source)
    const engine: ServerTurnEngine = {
      start,
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const stage: ServerAttachmentStage = {
      public: [{ type: "file", filename: "notes.txt", mimeType: "text/plain" }],
      appendTo: (text) => text,
      cleanup: vi.fn(async () => undefined),
    }

    await sessions.start(
      scope,
      {
        clientId: "client-1",
        sent: "Hello",
        prepare: async () => ({ prompt: "Hello", stage }),
      },
      access("one")
    )

    expect(start).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ prompt: "Hello" }),
      stage,
      expect.any(AbortSignal)
    )
  })

  it("fans one provider stream out to multiple reconnecting browsers", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const first = await sessions.start(scope, input("run-1"), access("one"))
    const readFirst = reader(first)

    source.emit(turnStarted)
    await expect(readFirst()).resolves.toMatchObject({
      value: { sequence: 1, event: { kind: TurnEventKind.TurnStarted } },
    })

    const second = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 0 },
      access("two")
    )
    const readSecond = reader(second)
    await expect(readSecond()).resolves.toMatchObject({
      value: { sequence: 1, event: { kind: TurnEventKind.TurnStarted } },
    })

    source.emit(turnEnded)
    source.finish()

    await expect(readFirst()).resolves.toMatchObject({
      value: { sequence: 2, event: { kind: TurnEventKind.TurnEnded } },
    })
    await expect(readSecond()).resolves.toMatchObject({
      value: { sequence: 2, event: { kind: TurnEventKind.TurnEnded } },
    })
    expect(engine.start).toHaveBeenCalledOnce()
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("fails the stream of a subscriber whose queue fell behind the run", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine, { maxSubscriberEvents: 1 })
    const subscription = await sessions.start(
      scope,
      input("run-1"),
      access("one")
    )

    // Nothing reads this subscription, so the run outruns its one-event queue
    // while settling normally at the provider.
    source.emit(turnStarted)
    source.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Hel",
    })
    source.emit(turnEnded)
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    // The subscriber missed part of the run, so its stream reports the gap
    // instead of the end the provider reached.
    await expect(reader(subscription)()).rejects.toBeInstanceOf(
      FanoutOverflowError
    )
  })

  it("replays a compacted active run from the beginning for a cursorless reload", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a fresh browser")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberEvents: 64 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    const emitted: TurnEvent[] = [
      turnStarted,
      ...Array.from({ length: 40 }, (_, index) => ({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: String(index % 10),
      })),
      ...Array.from({ length: 11 }, (_, index) => {
        const toolCallId = `tool-${index + 1}`
        return [
          {
            kind: TurnEventKind.ToolCallStarted,
            toolCallId,
            title: "search",
            parentMessageId: "assistant-1",
          },
          {
            kind: TurnEventKind.ToolCallInputChunk,
            toolCallId,
            delta: `{"query":"${index + 1}"}`,
          },
          { kind: TurnEventKind.ToolCallInputEnded, toolCallId },
          {
            kind: TurnEventKind.ToolCallFinished,
            toolCallId,
            output: `result-${index + 1}`,
            failed: false,
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
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("refreshed")
    )
    const readRefreshed = reader(refreshed)

    const replayed = await Promise.all(
      Array.from({ length: 46 }, () => readRefreshed())
    )
    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      datedStart,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "0123456789012345678901234567890123456789",
      },
      ...emitted.slice(41),
    ])

    // The compacted prefix is followed by the live tail of the same run.
    const tail = {
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "tail",
    } as const
    source.emit(tail)
    await expect(readRefreshed()).resolves.toMatchObject({
      value: { sequence: emitted.length + 1, event: tail },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("compacts adjacent reasoning and tool argument deltas without interpreting them", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
    const events: TurnEvent[] = [
      turnStarted,
      ...Array.from({ length: 20 }, () => ({
        kind: TurnEventKind.ThoughtChunk,
        messageId: "assistant-1",
        text: "r",
      })),
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "tool-1",
        title: "search",
        parentMessageId: "assistant-1",
      },
      ...Array.from({ length: 20 }, () => ({
        kind: TurnEventKind.ToolCallInputChunk,
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
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("refreshed")
    )
    const iterator = refreshed.events[Symbol.asyncIterator]()
    const replayed = await Promise.all(
      Array.from({ length: 4 }, () => iterator.next())
    )

    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      datedStart,
      {
        kind: TurnEventKind.ThoughtChunk,
        messageId: "assistant-1",
        text: "r".repeat(20),
      },
      events[21],
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "tool-1",
        delta: "a".repeat(20),
      },
    ])
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("compacts tool output per call and keeps a subagent's prose apart", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
    const output = (toolCallId: string, text: string): TurnEvent => ({
      kind: TurnEventKind.ToolCallOutputChunk,
      toolCallId,
      text,
    })
    const prose = (text: string, subagentId?: string): TurnEvent => ({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text,
      ...(subagentId ? { subagentId } : {}),
    })
    const terminal: TurnEvent = {
      kind: TurnEventKind.TerminalOutput,
      terminalId: "term-1",
      toolCallId: "tool-1",
      data: "x",
    }
    const events: TurnEvent[] = [
      turnStarted,
      output("tool-1", "a"),
      output("tool-1", "b"),
      output("tool-2", "c"),
      terminal,
      terminal,
      prose("own "),
      prose("child ", "sub-1"),
      prose("prose", "sub-1"),
    ]
    for (const event of events) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const refreshed = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("refreshed")
    )
    const iterator = refreshed.events[Symbol.asyncIterator]()
    const replayed = await Promise.all(
      Array.from({ length: 7 }, () => iterator.next())
    )

    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      datedStart,
      output("tool-1", "ab"),
      output("tool-2", "c"),
      terminal,
      terminal,
      prose("own "),
      prose("child prose", "sub-1"),
    ])
  })

  it("replays only the events after a redial cursor", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
      turnStarted,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "a",
      } as const,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "b",
      } as const,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "c",
      } as const,
    ]) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const redial = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 3 },
      access("redial")
    )
    const readRedial = reader(redial)

    // A cursor never repeats a delta the browser already rendered, so the
    // journaled text is replayed from the cursor rather than from its merge.
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: 4,
        event: { kind: TurnEventKind.MessageChunk, text: "c" },
      },
    })
    source.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "d",
    })
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: 5,
        event: { kind: TurnEventKind.MessageChunk, text: "d" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("serves a redial cursor of a long run without native recovery", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
    const emitted: TurnEvent[] = [
      turnStarted,
      // More single-character deltas than one browser stream may buffer: the
      // journal compacts them, so the run stays replayable from any cursor.
      ...Array.from({ length: 38 }, (_, index) => ({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: String(index % 10),
      })),
    ]
    for (const event of emitted) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const redial = await sessions.recover(
      scope,
      {
        sessionId: scope.sessionId,
        turnId: "run-1",
        after: emitted.length - 1,
      },
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
    const engine: ServerTurnEngine = {
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
      turnStarted,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "He",
      } as const,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "llo",
      } as const,
    ]) {
      source.emit(event)
      await readInitial()
    }
    initial.close()

    const redial = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 2 },
      access("redial")
    )
    const readRedial = reader(redial)
    const reload = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)

    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: 3,
        event: { kind: TurnEventKind.MessageChunk, text: "llo" },
      },
    })
    const replayed = await Promise.all([readReload(), readReload()])
    expect(replayed.map((entry) => entry.value)).toEqual([
      { sequence: 1, event: datedStart },
      {
        sequence: 3,
        event: {
          kind: TurnEventKind.MessageChunk,
          messageId: "assistant-1",
          text: "Hello",
        },
      },
    ])

    const tail = {
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "!",
    } as const
    source.emit(tail)
    const live = await Promise.all([readRedial(), readReload()])
    expect(live.map((entry) => entry.value)).toEqual([
      { sequence: 4, event: tail },
      { sequence: 4, event: tail },
    ])
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("keeps a replay journal for every concurrently active Session", async () => {
    const sources = Array.from({ length: 6 }, () => new EventSource())
    let sourceIndex = 0
    const engine: ServerTurnEngine = {
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
          providerSessionId: `stored-${id}`,
          sessionId: `stored-${id}`,
        }
        const runInput = input(`run-${id}`)
        const subscription = await sessions.start(
          sessionScope,
          runInput,
          access(`operator-${id}`)
        )
        const source = sources[index]!
        source.emit(turnStarted)
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
        sessionId: oldest.sessionScope.sessionId,
        turnId: oldest.runInput.turnId,
      },
      access("refreshed-oldest")
    )
    await expect(reader(leastRecent)()).resolves.toMatchObject({
      value: {
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      },
    })

    const retained = await sessions.recover(
      newest.sessionScope,
      {
        sessionId: newest.sessionScope.sessionId,
        turnId: newest.runInput.turnId,
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
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => sources[sourceIndex++]!),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a missing journal")
      }),
    }
    const sessions = coordinator(engine, { maxActiveExecutions: 1 })
    const first = await sessions.start(scope, input("run-1"), access("one"))
    const readFirst = reader(first)
    sources[0]!.emit(turnStarted)
    await readFirst()
    // The provider stream ends settled without a terminal event, so this
    // Session is idle and still holds the journal of its last run.
    sources[0]!.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    first.close()

    const second = await sessions.start(
      otherScope,
      input("run-2"),
      access("two")
    )
    const readSecond = reader(second)
    sources[1]!.emit(turnStarted)
    await readSecond()

    await expect(reloadedHead(sessions, scope, "run-1")).resolves.toMatchObject(
      {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      }
    )
    await expect(
      reloadedHead(sessions, otherScope, "run-2")
    ).resolves.toMatchObject({
      sequence: 1,
      event: { kind: TurnEventKind.TurnStarted },
    })
    expect(engine.recover).not.toHaveBeenCalled()
    second.close()
  })

  it("serves the redial after a reset from the live segment of an overflowed run", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a live segment")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberEvents: 4 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    for (const [index] of Array.from({ length: 6 }).entries()) {
      source.emit({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: `tool-${index + 1}`,
        title: "search",
        parentMessageId: "assistant-1",
      })
      await readInitial()
    }
    initial.close()

    // The browser reloaded the authoritative history after the one reset, so
    // the run it is still watching answers this cursor with its live events.
    const redial = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 0 },
      access("redial")
    )
    const readRedial = reader(redial)
    source.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Hello",
    })

    await expect(readRedial()).resolves.toMatchObject({
      value: { sequence: 7, event: { kind: TurnEventKind.MessageChunk } },
    })
    expect(sessions.state(scope)).toBe("running")
    expect(engine.recover).not.toHaveBeenCalled()
    redial.close()
  })

  it("journals a delta-heavy run whose compacted replay fits the replay bound", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    // Every raw delta event costs more than its delta, so 120 of them exceed
    // the event bound long before the one event they compact into does. The
    // bytes bound is the retention cap of the raw entries too, so it is set
    // where this run's own raw events still fit inside it.
    const sessions = coordinator(engine, { maxSubscriberBytes: 32 * 1024 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    source.emit(turnStarted)
    await readInitial()
    for (const text of Array.from({ length: 120 }, () => "abcd")) {
      source.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text,
      })
      await readInitial()
    }
    initial.close()

    const reload = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)
    const replayed = await Promise.all([readReload(), readReload()])

    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      datedStart,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "abcd".repeat(120),
      },
    ])
    expect(engine.recover).not.toHaveBeenCalled()
    reload.close()
  })

  it("holds a delta flood to the retention cap and replays a cursor inside it", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberBytes: 2 * 1024 })
    const emitted = await deltaFlood(sessions, source, 400)
    const total = emitted.length

    const redial = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: total - 3 },
      access("redial")
    )
    const readRedial = reader(redial)
    // A cursor the journal still holds replays exactly the deltas after it.
    await expect(readRedial()).resolves.toMatchObject({
      value: {
        sequence: total,
        event: { kind: TurnEventKind.MessageChunk, text: "789" },
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

  it("refuses a redial before the retained prefix", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberBytes: 2 * 1024 })
    await deltaFlood(sessions, source, 400)

    await expect(
      sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: "run-1", after: 1 },
        access("redial")
      )
    ).rejects.toThrow(ReplayCursorLostError)
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("returns reset-required once for a cursorless reload of a pruned run", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a journaled run")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberBytes: 2 * 1024 })
    await deltaFlood(sessions, source, 400)

    // The journal no longer holds this run from its beginning, so a reload that
    // owns nothing is owed authoritative history instead of a partial replay.
    const reload = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)
    await expect(readReload()).resolves.toMatchObject({
      value: {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readReload()).resolves.toMatchObject({ done: true })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("says whether a cursorless reload still replays the live turn from its start", async () => {
    const pruned = new EventSource()
    const whole = new EventSource()
    const sources = [pruned, whole]
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => sources.shift() ?? new EventSource()),
      recover: vi.fn(async () => new EventSource()),
    }
    const sessions = coordinator(engine, { maxSubscriberBytes: 2 * 1024 })
    expect(sessions.replayStart(scope)).toBeUndefined()

    await deltaFlood(sessions, pruned, 400)
    expect(sessions.replayStart(scope)).toBeUndefined()

    const running = await sessions.start(
      otherScope,
      input("run-2"),
      access("other")
    )
    whole.emit(turnStarted)
    await reader(running)()
    expect(sessions.replayStart(otherScope)).toMatchObject({ turnId: "run-2" })

    whole.emit(turnEnded)
    await vi.waitFor(() => expect(sessions.state(otherScope)).toBe("idle"))
    expect(sessions.replayStart(otherScope)).toBeUndefined()
    running.close()
  })

  it("keeps where a running turn's replay starts and dates its start there", async () => {
    const first = new EventSource()
    const continued = new EventSource()
    const sources = [first, continued]
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => sources.shift() ?? new EventSource()),
      recover: vi.fn(async () => new EventSource()),
    }
    const sessions = coordinator(engine)
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
    try {
      const own = await sessions.start(scope, input("run-1"), access("own"))
      expect(sessions.replayStart(scope)).toEqual({
        turnId: "run-1",
        at: 1_000,
      })

      // Emitted long after admission, the start still reads as the admission.
      clock.mockReturnValue(61_000)
      first.emit(turnStarted)
      await expect(reloadedHead(sessions, scope, "run-1")).resolves.toEqual({
        sequence: 1,
        event: { ...turnStarted, startedAt: new Date(1_000).toISOString() },
      })

      first.emit({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          {
            requestId: "question-1",
            kind: PendingRequestKind.Elicitation,
            message: "Which one?",
          },
        ],
      })
      await vi.waitFor(() =>
        expect(sessions.state(scope)).toBe("waiting-for-input")
      )
      own.close()

      // A continued turn's journal starts at the answer, not at the prompt.
      clock.mockReturnValue(90_000)
      const turnId = await continueTurn(sessions)
      expect(sessions.replayStart(scope)).toEqual({ turnId, at: 90_000 })
    } finally {
      clock.mockRestore()
    }
  })

  it("resets a reload that holds part of the turn it cannot position", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const own = await sessions.start(scope, input("run-1"), access("own"))
    source.emit(turnStarted)
    await reader(own)()

    const reload = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", reset: true },
      access("reload")
    )

    // A reset names only its code: no message the browser would show.
    const head = await reader(reload)()
    expect(head.value?.event).toEqual({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_RESET_REQUIRED",
    })
    expect(sessions.state(scope)).toBe("running")
    own.close()
  })

  it("serves the redial after a reset from the live segment of a pruned run", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a live segment")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberBytes: 2 * 1024 })
    const emitted = await deltaFlood(sessions, source, 400)

    // The browser reloaded the authoritative history after the one reset, so
    // the run it is still watching answers this cursor with its live events.
    const redial = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 0 },
      access("redial")
    )
    const readRedial = reader(redial)
    const tail = {
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "tail",
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
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a live segment")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberBytes: 2 * 1024 })
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
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "tail",
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
    const engine: ServerTurnEngine = {
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
    source.emit(turnEnded)
    await expect(readInitial()).resolves.toMatchObject({
      value: { event: { kind: TurnEventKind.TurnEnded } },
    })

    const refreshed = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("refreshed")
    )
    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("refuses a redial for a settled run", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
    source.emit(turnStarted)
    await readInitial()
    source.emit(turnEnded)
    source.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    // Provider history owns a run that ended, so a redial that missed the last
    // events reloads it instead of replaying a journal AOS no longer keeps.
    await expect(
      sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: "run-1", after: 1 },
        access("redial")
      )
    ).rejects.toThrow(ReplayCursorLostError)
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("delivers an event published at the fresh replay boundary exactly once", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    source.emit(turnStarted)
    await reader(initial)()
    initial.close()
    const refreshed = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("refreshed")
    )
    const readRefreshed = reader(refreshed)

    await expect(readRefreshed()).resolves.toMatchObject({
      value: { sequence: 1, event: { kind: TurnEventKind.TurnStarted } },
    })
    source.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "tail",
    })
    await expect(readRefreshed()).resolves.toMatchObject({
      value: {
        sequence: 2,
        event: { kind: TurnEventKind.MessageChunk, text: "tail" },
      },
    })
  })

  it("returns reset-required when an active run is too large to journal", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "x".repeat(300 * 1024),
    })
    // The event is larger than one subscriber queue as well as the journal, so
    // this browser is told it missed it.
    await expect(reader(initial)()).rejects.toBeInstanceOf(FanoutOverflowError)
    initial.close()

    const refreshed = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("refreshed")
    )
    const readRefreshed = reader(refreshed)

    await expect(readRefreshed()).resolves.toMatchObject({
      value: {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      },
    })
    // One overflow answers one reset: the stream ends after it.
    await expect(readRefreshed()).resolves.toMatchObject({ done: true })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("refuses a redial and resets a reload once an active run journals more events than AOS can replay", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("native recovery must not run for a fresh browser")
      }),
    }
    const sessions = coordinator(engine, { maxSubscriberEvents: 4 })
    const initial = await sessions.start(
      scope,
      input("run-1"),
      access("initial")
    )
    const readInitial = reader(initial)
    for (const [index] of Array.from({ length: 6 }).entries()) {
      source.emit({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: `tool-${index + 1}`,
        title: "search",
        parentMessageId: "assistant-1",
      })
      await readInitial()
    }
    initial.close()

    await expect(
      sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: "run-1", after: 3 },
        access("redial")
      )
    ).rejects.toThrow(ReplayCursorLostError)

    const reload = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("reload")
    )
    const readReload = reader(reload)
    await expect(readReload()).resolves.toMatchObject({
      value: {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readReload()).resolves.toMatchObject({ done: true })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("rejects fresh replay when the run belongs to another Agent or Session", async () => {
    const sources = [new EventSource(), new EventSource(), new EventSource()]
    let sourceIndex = 0
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => sources[sourceIndex++]!),
      recover: vi.fn(async () => sources[0]!),
    }
    const sessions = coordinator(engine)
    const scopes = [
      scope,
      {
        agentId: "writer",
        providerSessionId: scope.providerSessionId,
        sessionId: "writer-1",
      },
      {
        agentId: scope.agentId,
        providerSessionId: "stored-2",
        sessionId: "stored-2",
      },
    ]
    for (const [index, sessionScope] of scopes.entries()) {
      await sessions.start(
        sessionScope,
        input(`run-${index + 1}`),
        access(`operator-${index + 1}`)
      )
    }

    for (const sessionScope of scopes.slice(1)) {
      await expect(
        sessions.recover(
          sessionScope,
          { sessionId: sessionScope.sessionId, turnId: "run-1" },
          access(`refresh-${sessionScope.sessionId}`)
        )
      ).rejects.toThrow("An AOS turn is already active")
    }
    await expect(
      sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: "unknown-run" },
        access("refresh-unknown")
      )
    ).rejects.toThrow("An AOS turn is already active")
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("keeps provider work alive when every browser disconnects", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
    const engine: ServerTurnEngine = {
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
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    const changed = { ...input("run-1"), prompt: "Changed" }

    await expect(sessions.start(scope, changed, access("one"))).rejects.toThrow(
      "already active"
    )
    expect(engine.start).toHaveBeenCalledOnce()
  })

  it("accepts an idempotent admission regardless of object key insertion order", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const original = input("run-1")
    await sessions.start(scope, original, access("one"))
    const reordered = Object.fromEntries(
      Object.entries(original).reverse()
    ) as PromptTurnInput

    await expect(
      sessions.start(scope, reordered, access("two"))
    ).resolves.toBeDefined()
    expect(engine.start).toHaveBeenCalledOnce()
  })

  describe("admissions a client may repeat", () => {
    const engine = (): ServerTurnEngine => ({
      start: vi.fn(async () => new EventSource()),
      recover: vi.fn(async () => new EventSource()),
    })

    it("answers a repeated send with its first turn, also once the Session no longer holds it", async () => {
      const first = new EventSource()
      const start = vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(first)
        .mockResolvedValue(new EventSource())
      const sessions = coordinator({ ...engine(), start })
      const sent = (clientId: string, prompt: string) => ({
        clientId,
        sent: prompt,
        prepare: async () => ({ prompt }),
      })
      const send = sent("client-1", "Hello")

      const [admitted, repeated] = await Promise.all([
        sessions.start(scope, send, access("one")),
        sessions.start(scope, send, access("one")),
      ])
      expect(repeated.turnId).toBe(admitted.turnId)
      await expect(
        sessions.start(scope, sent("client-1", "Changed"), access("one"))
      ).rejects.toThrow(ServerClientIdReusedError)

      const read = reader(admitted)
      first.emit(turnEnded)
      await read()
      await sessions.start(scope, sent("client-2", "Next"), access("one"))

      await expect(
        sessions.start(scope, send, access("one"))
      ).resolves.toMatchObject({ turnId: admitted.turnId })
      expect(start).toHaveBeenCalledTimes(2)
    })

    it("answers a repeated create with its first Session, and a failed one afresh", async () => {
      const createSession = vi
        .fn()
        .mockRejectedValueOnce(new Error("Provider unavailable"))
        .mockResolvedValueOnce({ session: { id: "created-1" } })
        .mockResolvedValue({ session: { id: "created-2" } })
      const sessions = coordinator(engine(), {
        readings: {
          context: vi.fn(),
          models: vi.fn(),
          createSession,
          publicError: () => undefined,
          link: READY_LINK,
        },
      })
      const create = { title: "Plans", clientId: "client-1" }

      await expect(
        sessions.createSession("researcher", create, "operator")
      ).rejects.toThrow("Provider unavailable")
      for (let repeat = 0; repeat < 2; repeat++)
        await expect(
          sessions.createSession("researcher", create, "operator")
        ).resolves.toEqual({ session: { id: "created-1" } })
      await expect(
        sessions.createSession(
          "researcher",
          { ...create, title: "Other" },
          "operator"
        )
      ).rejects.toThrow(ServerClientIdReusedError)
      // A client id is its principal's own: another's never reads this Session.
      await expect(
        sessions.createSession("researcher", create, "guest:invite-1")
      ).resolves.toEqual({ session: { id: "created-2" } })
      expect(createSession).toHaveBeenCalledTimes(3)
    })

    it("forgets a client id once it expires or falls beyond the bound", async () => {
      const clock = useFakeClock()
      const createSession = vi.fn(async () => ({}))
      const sessions = coordinator(engine(), {
        readings: {
          context: vi.fn(),
          models: vi.fn(),
          createSession,
          publicError: () => undefined,
          link: READY_LINK,
        },
      })
      const create = (clientId: string) =>
        sessions.createSession("researcher", { clientId }, "operator")

      await create("client-1")
      await clock.advance(CLIENT_ADMISSIONS.ttlMs - 1)
      await create("client-1")
      expect(createSession).toHaveBeenCalledTimes(1)
      await clock.advance(1)
      await create("client-1")
      expect(createSession).toHaveBeenCalledTimes(2)

      for (let index = 1; index < CLIENT_ADMISSIONS.entries; index++)
        await create(`other-${index}`)
      await create("client-1")
      expect(createSession).toHaveBeenCalledTimes(CLIENT_ADMISSIONS.entries + 1)
      await create("other-last")
      await create("client-1")
      expect(createSession).toHaveBeenCalledTimes(CLIENT_ADMISSIONS.entries + 3)
    })
  })

  it("retains a paused execution and resumes it as a fresh segment", async () => {
    const interrupted = new EventSource()
    const resumed = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(resumed),
      recover: vi.fn(async () => resumed),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))
    interrupted.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "question-1",
          kind: PendingRequestKind.Elicitation,
          responseSchema: { type: "object" },
        },
      ],
    })
    interrupted.finish()
    await vi.waitFor(() =>
      expect(sessions.state(scope)).toBe("waiting-for-input")
    )

    const turnId = await continueTurn(sessions)

    expect(engine.start).toHaveBeenCalledTimes(2)
    expect(engine.start.mock.calls[1]?.[1]).toEqual({
      turnId,
      replies: [REPLY],
    })
    expect(sessions.state(scope)).toBe("running")
  })

  describe("answering a paused turn's requests", () => {
    const questions = ["question-1", "question-2"].map((requestId) => ({
      requestId,
      kind: PendingRequestKind.Elicitation,
      responseSchema: { type: "object" },
    }))
    const replyTo = (requestId: string) => ({
      requestId,
      status: "resolved" as const,
      payload: { answers: [[requestId]] },
    })

    /** A turn `starter` admitted, now waiting on both questions. */
    async function waitingOnTwo(starter = "one") {
      const interrupted = new EventSource()
      const resumed = new EventSource()
      const engine: ServerTurnEngine = {
        start: vi
          .fn<ServerTurnEngine["start"]>()
          .mockResolvedValueOnce(interrupted)
          .mockResolvedValueOnce(resumed),
        recover: vi.fn(async () => resumed),
      }
      const sessions = coordinator(engine)
      const observed: ExecutionEvent[] = []
      sessions.subscribeScope(scope, (event) => observed.push(event))
      await sessions.start(scope, input("run-1"), access(starter))
      interrupted.emit({
        kind: TurnEventKind.TurnRequiresAction,
        requests: questions,
      })
      interrupted.finish()
      await vi.waitFor(() =>
        expect(sessions.state(scope)).toBe("waiting-for-input")
      )
      return { engine, sessions, observed, resumed }
    }

    const resolvedIds = (observed: ExecutionEvent[]) =>
      observed.flatMap((event) =>
        event.kind === "attention-resolved" ? [event.requestId] : []
      )

    it("takes one answer per request from whoever answers, then continues the turn", async () => {
      const { engine, sessions, observed } = await waitingOnTwo()

      await expect(
        sessions.answer(scope, replyTo("question-1"))
      ).resolves.toBeUndefined()
      // The answered request is withdrawn at once; the other stays open.
      expect(resolvedIds(observed)).toEqual(["question-1"])
      expect(sessions.snapshot(scope).requests).toEqual([questions[1]])
      expect(engine.start).toHaveBeenCalledOnce()

      const continued = await sessions.answer(scope, replyTo("question-2"))

      expect(continued).toEqual({ from: "run-1", turnId: expect.any(String) })
      expect(engine.start).toHaveBeenCalledTimes(2)
      expect(engine.start.mock.calls[1]?.[1]).toEqual({
        turnId: continued?.turnId,
        replies: [replyTo("question-1"), replyTo("question-2")],
      })
      expect(sessions.snapshot(scope)).toMatchObject({
        state: "running",
        turnId: continued?.turnId,
      })
      expect(resolvedIds(observed)).toEqual(["question-1", "question-2"])
    })

    it("refuses a later answer to a request already answered as stale", async () => {
      const { engine, sessions } = await waitingOnTwo()
      await sessions.answer(scope, replyTo("question-1"))

      await expect(
        sessions.answer(scope, replyTo("question-1"))
      ).rejects.toBeInstanceOf(ServerRequestStaleError)
      await expect(
        sessions.answer(scope, replyTo("never-asked"))
      ).rejects.toBeInstanceOf(ServerRequestStaleError)
      expect(engine.start).toHaveBeenCalledOnce()
    })

    it("leaves the continuation uncertain when its provider never answers", async () => {
      const { advance } = useFakeClock()
      const asking = new EventSource()
      const engine: ServerTurnEngine = {
        start: vi
          .fn<ServerTurnEngine["start"]>()
          .mockResolvedValueOnce(asking)
          .mockReturnValueOnce(new Promise(() => {})),
        recover: vi.fn(async () => {
          throw new Error("provider unavailable")
        }),
      }
      const sessions = coordinator(engine)
      await sessions.start(scope, input("run-1"), access("one"))
      asking.emit({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [questions[0]!],
      })
      asking.finish()
      await advance(0)

      const answered = expect(
        sessions.answer(scope, replyTo("question-1"))
      ).rejects.toBeInstanceOf(ServerTurnUncertainError)
      await advance(ADMISSION_DEADLINE_MS)
      await answered

      // The provider may have taken the answer, so the continuation holds the
      // Session, uncertain, and the paused turn's request is not reissued.
      const [, continuation, , signal] = vi.mocked(engine.start).mock.calls[1]!
      expect(signal?.aborted).toBe(true)
      expect(sessions.snapshot(scope)).toEqual({
        state: "uncertain",
        turnId: continuation.turnId,
        requests: [],
        startedBy: "one",
      })
    })

    it("keeps the starter across the continued segment", async () => {
      const { sessions, observed, resumed } = await waitingOnTwo("starter")
      expect(sessions.snapshot(scope).startedBy).toBe("starter")
      expect(
        observed.find(({ kind }) => kind === "attention-requested")
      ).toMatchObject({ startedBy: "starter" })

      await sessions.answer(scope, replyTo("question-1"))
      await sessions.answer(scope, replyTo("question-2"))
      resumed.emit({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [questions[0]!],
      })

      await vi.waitFor(() =>
        expect(sessions.state(scope)).toBe("waiting-for-input")
      )
      expect(sessions.snapshot(scope).startedBy).toBe("starter")
      expect(
        observed.filter(({ kind }) => kind === "attention-requested").at(-1)
      ).toMatchObject({ startedBy: "starter" })
    })

    it("names no starter for a turn it recovered or discovered without holding it", async () => {
      const source = new EventSource()
      const sessions = coordinator({
        start: vi.fn(async () => source),
        recover: vi.fn(async () => source),
        discover: vi.fn(async () => ({
          handle: source,
          state: "running" as const,
        })),
      })
      await sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: "run-1" },
        access("recovering")
      )
      await sessions.discover(otherScope)

      expect(sessions.snapshot(scope).startedBy).toBeUndefined()
      expect(sessions.snapshot(otherScope).startedBy).toBeUndefined()
    })
  })

  it("keeps Stop in stopping until the provider settles", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(sessions.stop(scope)).resolves.toBe("stopping")

    expect(sessions.state(scope)).toBe("stopping")
  })

  it("keeps a run that reports a failure awaiting Stop active and stoppable", async () => {
    const source = new EventSource()
    const next = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(next),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const announced: ExecutionEvent["kind"][] = []
    sessions.subscribeExecutions((event) => announced.push(event.kind))
    const onTerminal = vi.fn(async () => undefined)
    const read = reader(
      await sessions.start(scope, input("run-1"), {
        ...access("operator"),
        onTerminal,
      })
    )
    const lost = {
      kind: TurnEventKind.TurnFailed,
      code: "AOS_INTERACTION_LOST",
      message:
        "This Session is waiting on a question that can no longer be answered here. Stop the turn to continue.",
      awaitingStop: true,
    } as const
    source.emit(turnStarted)
    source.emit(lost)

    await expect(read()).resolves.toMatchObject({
      value: { event: turnStarted },
    })
    await expect(read()).resolves.toMatchObject({ value: { event: lost } })
    expect(sessions.state(scope)).toBe("running")
    expect(onTerminal).not.toHaveBeenCalled()
    await expect(
      sessions.start(scope, input("run-2"), access("operator"))
    ).rejects.toBeInstanceOf(ServerTurnConflictError)

    await expect(sessions.stop(scope)).resolves.toBe("stopping")
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(sessions.state(scope)).toBe("stopping")
    const finished = {
      kind: TurnEventKind.TurnEnded,
    } as const
    source.emit(finished)
    source.finish()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith(finished)
    expect(announced).toEqual(["turn-started", "turn-finished"])
    await sessions.start(scope, input("run-2"), access("operator"))
    expect(sessions.state(scope)).toBe("running")
  })

  it("stops a turn for whoever asks, not only its starter, and rechecks a stopping handle", async () => {
    const source = new EventSource()
    source.stop.mockResolvedValueOnce("stopping").mockResolvedValueOnce("idle")
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("starter"))

    // A Stop names nobody: the coordinator keeps who started a turn, never
    // who may stop it.
    await expect(sessions.stop(scope)).resolves.toBe("stopping")
    await expect(sessions.stop(scope)).resolves.toBe("idle")
    expect(source.stop).toHaveBeenCalledTimes(2)
    expect(sessions.state(scope)).toBe("idle")
  })

  it("keeps a run active when Stop definitely was not dispatched", async () => {
    const source = new EventSource()
    const failure = new Error("Provider unavailable")
    source.stop.mockRejectedValueOnce(
      new ServerTurnStopNotDispatchedError(failure)
    )
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(sessions.stop(scope)).rejects.toBe(failure)
    expect(sessions.state(scope)).toBe("running")
  })

  it("keeps an ambiguous Stop failure uncertain", async () => {
    const { advance } = useFakeClock()
    const source = new EventSource()
    source.stop.mockRejectedValueOnce(new Error("Connection lost"))
    const recover = vi.fn(async (): Promise<ServerTurnHandle> => source)
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover,
    })
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(sessions.stop(scope)).rejects.toThrow("Connection lost")
    expect(sessions.state(scope)).toBe("uncertain")

    // The stream reports the outcome while the reconcile is recovering the
    // turn, and that recovery fails: the turn rests where the stream left it.
    recover.mockImplementationOnce(async () => {
      const finished = new Promise<void>((resolve) => {
        const unsubscribe = sessions.subscribeExecutions((event) => {
          if (event.kind !== "turn-finished") return
          unsubscribe()
          resolve()
        })
      })
      source.emit(turnEnded)
      source.finish()
      await finished
      throw new Error("Provider unavailable")
    })
    await advance(0)
    expect(sessions.state(scope)).toBe("idle")
  })

  it("reports a Session idle when its run terminates after every browser detached", async () => {
    const source = new EventSource()
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    const live = await sessions.start(scope, input("run-1"), access("one"))
    source.emit(turnStarted)
    await reader(live)()
    live.close()

    source.emit(turnEnded)
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
    const stopping = sessions.stop(scope)

    source.emit(turnEnded)
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
            reject(new ServerTurnStopNotDispatchedError(failure))
        })
    )
    const sessions = coordinator({
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    })
    await sessions.start(scope, input("run-1"), access("operator"))
    const stopping = sessions.stop(scope)

    source.emit(turnEnded)
    source.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    refuseStop()

    await expect(stopping).rejects.toBe(failure)
    expect(sessions.state(scope)).toBe("idle")
  })

  it("does not reopen a Session whose stream died when Stop answers afterwards", async () => {
    const { advance } = useFakeClock()
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
      recover: vi.fn(async () => {
        throw new Error("provider unavailable")
      }),
    })
    await sessions.start(scope, input("run-1"), access("operator"))
    const stopping = sessions.stop(scope)

    // The stream ends without a terminal event and without settling.
    source.close()
    await advance(0)
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
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(resumed),
      recover: vi.fn(async () => resumed),
    })
    await sessions.start(scope, input("run-1"), access("operator"))
    const stopping = sessions.stop(scope)

    interrupted.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "question-1",
          kind: PendingRequestKind.Elicitation,
          responseSchema: { type: "object" },
        },
      ],
    })
    interrupted.finish()
    await vi.waitFor(() =>
      expect(sessions.state(scope)).toBe("waiting-for-input")
    )
    await continueTurn(sessions)
    answerStop()

    await expect(stopping).resolves.toBe("stopping")
    // The answered Stop belongs to run-1; its continuation is a live turn of
    // its own.
    expect(sessions.state(scope)).toBe("running")
  })

  it("steers the matching active run once and publishes a replayable acknowledgement", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
      sessions.steer(scope, {
        requestId: "queue-item-1",
        expectedTurnId: "run-1",
        text: "Use the newer API",
      })
    ).resolves.toEqual({ status: "steered" })
    await expect(read()).resolves.toMatchObject({
      value: {
        sequence: 1,
        event: {
          kind: TurnEventKind.SteerAccepted,
          requestId: "queue-item-1",
          text: "Use the newer API",
          delivery: "steered",
        },
      },
    })
    expect(source.steer).toHaveBeenCalledWith({
      requestId: "queue-item-1",
      text: "Use the newer API",
    })

    await expect(
      sessions.steer(scope, {
        requestId: "queue-item-1",
        expectedTurnId: "run-1",
        text: "Use the newer API",
      })
    ).resolves.toEqual({ status: "steered" })
    expect(source.steer).toHaveBeenCalledOnce()
  })

  it("rejects stale run identity, conflicting request reuse, and steering after Stop", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))

    await expect(
      sessions.steer(scope, {
        requestId: "one",
        expectedTurnId: "stale",
        text: "Correction",
      })
    ).rejects.toThrow("already active")
    await sessions.steer(scope, {
      requestId: "one",
      expectedTurnId: "run-1",
      text: "Correction",
    })
    await expect(
      sessions.steer(scope, {
        requestId: "one",
        expectedTurnId: "run-1",
        text: "Different",
      })
    ).rejects.toThrow("already active")

    await sessions.stop(scope)
    await expect(
      sessions.steer(scope, {
        requestId: "two",
        expectedTurnId: "run-1",
        text: "Too late",
      })
    ).rejects.toThrow("already active")
  })

  it("takes up a turn it does not hold whatever the capacity", async () => {
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => new EventSource()),
      recover: vi.fn(async () => new EventSource()),
      discover: vi.fn(async () => ({
        handle: new EventSource(),
        state: "running" as const,
      })),
    }
    const sessions = coordinator(engine, { maxActiveExecutions: 1 })
    await sessions.start(otherScope, input("run-1"), access("one"))

    await expect(
      sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: "unheld" },
        access("two")
      )
    ).resolves.toMatchObject({ turnId: "unheld" })
    // A turn lost to a restart is found when its Session opens, not started.
    await expect(
      sessions.discover({
        agentId: "researcher",
        providerSessionId: "stored-3",
        sessionId: "stored-3",
      })
    ).resolves.toBeDefined()
  })

  it("gives up every admission at close, stops a start that lands after it, but leaves a recovered turn running", async () => {
    const { advance } = useFakeClock()
    const started = new EventSource()
    const recovered = new EventSource()
    const signals: AbortSignal[] = []
    let answerStart!: (handle: ServerTurnHandle) => void
    let answerRecover!: (handle: ServerTurnHandle) => void
    const engine: ServerTurnEngine = {
      start: vi.fn<ServerTurnEngine["start"]>(
        (_target, _input, _stage, signal) => {
          signals.push(signal!)
          return new Promise((resolve) => {
            answerStart = resolve
          })
        }
      ),
      recover: vi.fn<ServerTurnEngine["recover"]>(
        (_target, _request, signal) => {
          signals.push(signal!)
          return new Promise((resolve) => {
            answerRecover = resolve
          })
        }
      ),
    }
    const sessions = coordinator(engine)
    const start = sessions.start(scope, input("run-1"), access("one"))
    const recover = sessions.recover(
      otherScope,
      { sessionId: otherScope.sessionId, turnId: "run-2" },
      access("two")
    )
    await advance(0)

    sessions.close()
    // Neither waits out its deadline for a provider that may never answer.
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, true])
    await expect(start).rejects.toThrow("Session coordinator is closed")
    await expect(recover).rejects.toThrow("Session coordinator is closed")
    answerStart(started)
    answerRecover(recovered)
    await advance(0)

    // Nothing owns the start any more; the recovered turn is the user's.
    expect(started.stop).toHaveBeenCalledOnce()
    expect(recovered.stop).not.toHaveBeenCalled()
  })

  it("coalesces concurrent authoritative recovery", async () => {
    const source = new EventSource()
    let resolveRecovery!: (handle: ServerTurnHandle) => void
    const pending = new Promise<ServerTurnHandle>((resolve) => {
      resolveRecovery = resolve
    })
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(() => pending),
    }
    const sessions = coordinator(engine)
    const first = sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("one")
    )
    const second = sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("two")
    )

    resolveRecovery(source)
    await expect(first).resolves.toBeDefined()
    await expect(second).resolves.toBeDefined()
    expect(engine.recover).toHaveBeenCalledOnce()
  })

  it("replays a recovered run from its start when its sequence is renumbered", async () => {
    const recovered = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => recovered),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)

    // No execution survived, so the cursor this browser holds belongs to a
    // sequence the recovered segment does not continue.
    const redial = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 57 },
      access("redial")
    )
    const readRedial = reader(redial)
    recovered.emit(turnStarted)

    await expect(readRedial()).resolves.toMatchObject({
      value: { sequence: 1, event: { kind: TurnEventKind.TurnStarted } },
    })
    expect(engine.recover).toHaveBeenCalledOnce()
  })

  it("preserves terminal resource ownership across uncertain recovery", async () => {
    const { advance } = useFakeClock()
    const initial = new EventSource()
    const recovered = new EventSource()
    const onTerminal = vi.fn(async () => undefined)
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => initial),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), {
      ...access("operator"),
      onTerminal,
    })
    initial.emit({
      kind: TurnEventKind.TurnFailed,
      message: "Delivery uncertain",
      code: "AOS_SEND_UNCERTAIN",
    })
    initial.finish()
    await advance(0)

    const terminal = {
      kind: TurnEventKind.TurnFailed,
      message: "Slash commands cannot be sent with attachments.",
      code: "AOS_COMMAND_WITH_ATTACHMENTS",
    } as const
    recovered.emit(terminal)
    recovered.finish()
    await advance(0)

    expect(onTerminal).toHaveBeenCalledTimes(2)
    expect(onTerminal).toHaveBeenLastCalledWith(terminal)
  })

  it("discovers one provider execution after a coordinator restart", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
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
      turnId: expect.stringMatching(/^aos-recovered-/u),
    })
    expect(engine.start).not.toHaveBeenCalled()
  })

  it("refreshes a discovered waiting execution from provider authority", async () => {
    const source = new EventSource()
    const request = {
      requestId: "question-1",
      kind: PendingRequestKind.Elicitation,
      responseSchema: { type: "string" },
    }
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
      discover: vi
        .fn<NonNullable<ServerTurnEngine["discover"]>>()
        .mockResolvedValueOnce({
          handle: source,
          state: "waiting-for-input",
          requests: [request],
        })
        .mockResolvedValueOnce(undefined),
    }
    const sessions = coordinator(engine)

    const discovered = await sessions.discover(scope)
    expect(discovered?.state).toBe("waiting-for-input")
    expect(sessions.snapshot(scope)).toMatchObject({
      state: "waiting-for-input",
      requests: [request],
    })

    await expect(sessions.discover(scope)).resolves.toBeUndefined()
    expect(engine.discover).toHaveBeenCalledTimes(2)
    expect(sessions.state(scope)).toBe("idle")
  })

  describe("adopting a turn the runtime started after an earlier one", () => {
    async function afterOneTurn(
      discover: NonNullable<ServerTurnEngine["discover"]>,
      limits: Partial<Omit<SessionCoordinatorOptions, "engine">> = {}
    ) {
      const own = new EventSource()
      const engine: ServerTurnEngine = {
        start: vi.fn(async () => own),
        recover: vi.fn(async () => own),
        discover: vi.fn(discover),
      }
      const sessions = coordinator(engine, limits)
      const subscription = await sessions.start(
        scope,
        input("turn-1"),
        access("browser")
      )
      own.emit({ kind: TurnEventKind.TurnEnded })
      own.finish()
      await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
      subscription.close()
      return { engine, sessions }
    }

    it("adopts it as a fresh execution that no member started", async () => {
      const adopted = new EventSource()
      const { sessions } = await afterOneTurn(async () => ({
        handle: adopted,
        state: "running",
        fromStart: true,
      }))
      const events: ExecutionEvent[] = []
      sessions.subscribeExecutions((event) => events.push(event))

      await sessions.discover(scope)

      const { turnId, startedBy } = sessions.snapshot(scope)
      expect(sessions.state(scope)).toBe("running")
      expect(turnId).toMatch(/^aos-recovered-/u)
      // The browser started the turn before it, not this one.
      expect(startedBy).toBeUndefined()
      expect(events).toMatchObject([{ kind: "turn-started", turnId }])
      await expect(sessions.stop(scope)).resolves.toBe("stopping")
      expect(adopted.stop).toHaveBeenCalledOnce()
    })

    it("replays a turn read from its start to a member that joins without a cursor", async () => {
      const adopted = new EventSource()
      const { sessions } = await afterOneTurn(async () => ({
        handle: adopted,
        state: "running",
        fromStart: true,
      }))
      await sessions.discover(scope)
      const chunk = {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Done.",
      } as const
      adopted.emit(chunk)
      await vi.waitFor(() => expect(sessions.replayStart(scope)).toBeDefined())

      const member = await sessions.recover(
        scope,
        {
          sessionId: scope.sessionId,
          turnId: sessions.snapshot(scope).turnId!,
        },
        access("member")
      )

      await expect(reader(member)()).resolves.toMatchObject({
        value: { event: chunk },
      })
      member.close()
    })

    it("starts the replay where the runtime says the adopted turn began", async () => {
      const startedAt = Date.now() - 60_000
      const reported = await afterOneTurn(async () => ({
        handle: new EventSource(),
        state: "running",
        fromStart: true,
        startedAt,
      }))
      const unreported = await afterOneTurn(async () => ({
        handle: new EventSource(),
        state: "running",
        fromStart: true,
      }))

      await reported.sessions.discover(scope)
      await unreported.sessions.discover(scope)

      expect(reported.sessions.replayStart(scope)).toEqual({
        turnId: reported.sessions.snapshot(scope).turnId,
        at: startedAt,
      })
      expect(unreported.sessions.replayStart(scope)).toEqual({
        turnId: unreported.sessions.snapshot(scope).turnId,
        at: undefined,
      })
    })

    it("leaves the finished record alone when the runtime is idle", async () => {
      const { engine, sessions } = await afterOneTurn(async () => undefined)

      await expect(sessions.discover(scope)).resolves.toBeUndefined()

      expect(engine.discover).toHaveBeenCalledOnce()
      expect(sessions.snapshot(scope)).toMatchObject({
        state: "idle",
        turnId: "turn-1",
      })
    })

    it("counts the adopted turn against the capacity limit", async () => {
      const busy = new EventSource()
      const { engine, sessions } = await afterOneTurn(
        async () => ({ handle: new EventSource(), state: "running" }),
        { maxActiveExecutions: 1 }
      )
      vi.mocked(engine.start).mockResolvedValueOnce(busy)
      await sessions.start(otherScope, input("turn-2"), access("other"))

      await expect(sessions.discover(scope)).rejects.toThrow()
      expect(sessions.state(scope)).toBe("idle")
    })

    it("refuses to adopt while the proxy's own start is in flight", async () => {
      let admit!: (handle: ServerTurnHandle) => void
      const { engine, sessions } = await afterOneTurn(async () => ({
        handle: new EventSource(),
        state: "running",
      }))
      vi.mocked(engine.start).mockImplementationOnce(
        () => new Promise((resolve) => (admit = resolve))
      )
      const starting = sessions.start(scope, input("turn-2"), access("browser"))

      await expect(sessions.discover(scope)).rejects.toBeInstanceOf(
        ServerTurnConflictError
      )
      admit(new EventSource())
      await starting
      expect(sessions.snapshot(scope).turnId).toBe("turn-2")
    })
  })

  it("requires authoritative history for a run discovered after coordinator restart", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
      discover: vi.fn(async () => ({ handle: source, state: "running" })),
    }
    const sessions = coordinator(engine)
    await sessions.discover(scope)
    const turnId = sessions.snapshot(scope).turnId!
    const refreshed = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId },
      access("refreshed")
    )
    source.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "future-only",
    })

    await expect(reader(refreshed)()).resolves.toMatchObject({
      value: {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      },
    })
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("requires authoritative history for a cursorless reload after recovering a discovered run", async () => {
    const discovered = new EventSource()
    const recovered = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => discovered),
      recover: vi.fn(async () => recovered),
      discover: vi.fn(async () => ({
        handle: discovered,
        state: "running" as const,
      })),
    }
    const sessions = coordinator(engine)
    await sessions.discover(scope)
    const turnId = sessions.snapshot(scope).turnId!
    const live = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId, after: 0 },
      access("live")
    )
    const readLive = reader(live)
    for (const event of [
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Hel",
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
      { sessionId: scope.sessionId, turnId },
      access("reload")
    )
    const readReload = reader(reload)
    await expect(readReload()).resolves.toMatchObject({
      value: {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      },
    })
    await expect(readReload()).resolves.toMatchObject({ done: true })
    expect(engine.recover).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("running"))
  })

  it("admits a new turn after authoritative terminal settlement", async () => {
    const first = new EventSource()
    const second = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      recover: vi.fn(async () => second),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("operator"))
    first.emit(turnEnded)
    first.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    await expect(
      sessions.start(scope, input("run-2"), access("operator"))
    ).resolves.toBeDefined()
    expect(engine.start).toHaveBeenCalledTimes(2)
  })
  it("keeps the journaled prefix across a recoverable interrupt", async () => {
    const interrupted = new EventSource()
    const recovered = new EventSource("token-12")
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => interrupted),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    const observed: ExecutionEvent["kind"][] = []
    sessions.subscribeExecutions((event) => observed.push(event.kind))
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    const started = turnStarted
    for (const event of [
      started,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Hel",
      } as const,
    ]) {
      interrupted.emit(event)
      await readLive()
    }
    interrupted.emit({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    await readLive()
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    live.close()

    const redial = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 3 },
      access("one")
    )
    const readRedial = reader(redial)
    // Every adapter opens a recovered segment with its own TurnStarted.
    recovered.emit(started)
    await readRedial()
    recovered.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "lo",
    })
    await readRedial()
    redial.close()

    const reload = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      access("two")
    )
    const readReload = reader(reload)
    const replayed = await Promise.all([readReload(), readReload()])
    expect(replayed.map((entry) => entry.value?.event)).toEqual([
      datedStart,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Hello",
      },
    ])
    recovered.emit(turnEnded)
    await expect(readReload()).resolves.toMatchObject({
      value: { event: { kind: TurnEventKind.TurnEnded } },
    })
    // The interrupt neither ended the turn nor started a second one.
    expect(observed).toEqual(["turn-started", "turn-finished"])
  })

  it("delivers recovered events to two redials sharing one cursor", async () => {
    const interrupted = new EventSource()
    const recovered = new EventSource("token-12")
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => interrupted),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    for (const event of [
      turnStarted,
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Hel",
      } as const,
    ]) {
      interrupted.emit(event)
      await readLive()
    }
    interrupted.emit({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_CONNECTION_INTERRUPTED",
      message: "The provider connection was interrupted.",
    })
    await readLive()
    interrupted.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
    live.close()

    const first = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 2 },
      access("one")
    )
    const readFirst = reader(first)
    const second = await sessions.recover(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", after: 2 },
      access("two")
    )
    const readSecond = reader(second)
    recovered.emit(turnStarted)
    recovered.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "lo",
    })

    const [leftStart, rightStart] = await Promise.all([
      readFirst(),
      readSecond(),
    ])
    expect(leftStart.value?.event).toMatchObject({
      kind: TurnEventKind.TurnStarted,
    })
    expect(rightStart.value?.event).toMatchObject({
      kind: TurnEventKind.TurnStarted,
    })
    const [left, right] = await Promise.all([readFirst(), readSecond()])
    expect(left.value?.event).toMatchObject({ text: "lo" })
    expect(right.value?.event).toMatchObject({ text: "lo" })
    expect(left.value?.sequence).toBeGreaterThan(3)
    expect(right.value?.sequence).toBe(left.value?.sequence)
    expect(engine.recover).toHaveBeenCalledOnce()
  })

  it("reconciles an uncertain turn at once and admits the next once it settles", async () => {
    const { advance } = useFakeClock()
    const interrupted = new EventSource()
    const recovered = new EventSource("token-7")
    const admitted = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit(interruptedError)
    interrupted.finish()
    // The provider answers the recovery with an already-finished run.
    recovered.emit(turnEnded)
    recovered.finish()
    await advance(0)

    const subscription = await sessions.start(
      scope,
      input("run-2"),
      access("one")
    )

    expect(subscription.turnId).toBe("run-2")
    expect(engine.recover).toHaveBeenCalledWith(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1", position: "token-1" },
      expect.any(AbortSignal)
    )
  })

  it("recovers without a position when the replaced segment names none", async () => {
    const { advance } = useFakeClock()
    const restored = new EventSource(null)
    const recovered = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => restored),
      recover: vi.fn(async () => recovered),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    restored.emit(interruptedError)
    restored.finish()
    await advance(0)

    // A fabricated position could never match a provider epoch, so the recovery
    // asks for the run itself rather than for an interval nothing owns.
    expect(engine.recover).toHaveBeenCalledWith(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      expect.any(AbortSignal)
    )
  })

  it("restarts the uncertainty deadline when a recover confirms the turn running", async () => {
    const { advance } = useFakeClock()
    const interrupted = new EventSource()
    const recovered = new EventSource()
    let reachable = false
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => interrupted),
      recover: vi.fn(async () => {
        if (!reachable) throw new Error("provider unavailable")
        reachable = false
        return recovered
      }),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit(interruptedError)
    interrupted.finish()

    await advance(UNCERTAINTY_DEADLINE_MS - 60_000)
    reachable = true
    await advance(RECONCILE_BACKOFF.capMs)
    expect(sessions.state(scope)).toBe("running")

    // The confirmed turn drops again: its first deadline has passed, and only
    // the one its confirmation started ends it.
    recovered.emit(interruptedError)
    recovered.finish()
    await advance(60_000)
    expect(sessions.state(scope)).toBe("uncertain")
    await advance(UNCERTAINTY_DEADLINE_MS)
    expect(sessions.state(scope)).toBe("idle")
  })

  it("ends a turn no recover confirms with its outcome unknown and frees its slot", async () => {
    const { advance } = useFakeClock()
    const interrupted = new EventSource()
    const signals: AbortSignal[] = []
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValue(new EventSource()),
      // The provider never answers, so each recover waits out its deadline.
      recover: vi.fn<ServerTurnEngine["recover"]>(
        (_target, _request, signal) =>
          new Promise((_resolve, reject) => {
            signals.push(signal!)
            signal!.addEventListener("abort", () => reject(signal!.reason))
          })
      ),
    }
    const sessions = coordinator(engine, { maxActiveExecutions: 1 })
    const observed: ExecutionEvent[] = []
    sessions.subscribeExecutions((event) => observed.push(event))
    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit(interruptedError)
    interrupted.finish()

    await advance(ADMISSION_DEADLINE_MS)
    expect(signals[0]?.aborted).toBe(true)
    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).rejects.toThrow("already active")
    await expect(
      sessions.start(otherScope, input("run-3"), access("one"))
    ).rejects.toBeInstanceOf(ServerTurnCapacityError)

    await advance(UNCERTAINTY_DEADLINE_MS)

    expect(sessions.state(scope)).toBe("idle")
    // The interrupt left the turn uncertain, not over: only its deadline
    // announces how it ended.
    expect(observed.map(({ kind, turnId }) => [kind, turnId])).toEqual([
      ["turn-started", "run-1"],
      ["turn-failed", "run-1"],
    ])
    await expect(reloadedHead(sessions, scope, "run-1")).resolves.toMatchObject(
      {
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_OUTCOME_UNKNOWN" },
      }
    )
    await expect(
      sessions.start(otherScope, input("run-3"), access("one"))
    ).resolves.toBeDefined()

    // A Session its provider lost ends its uncertain turn at once: no later
    // recover can confirm a turn in a Session that is gone.
    const lost = new EventSource()
    const recover = vi
      .fn<ServerTurnEngine["recover"]>()
      .mockRejectedValue(new ServerSessionNotFoundError())
    const gone = coordinator(
      {
        start: vi.fn<ServerTurnEngine["start"]>().mockResolvedValue(lost),
        recover,
      },
      { maxActiveExecutions: 1 }
    )
    const ended: ExecutionEvent[] = []
    gone.subscribeExecutions((event) => ended.push(event))
    const onTerminal = vi.fn(async () => undefined)
    await gone.start(scope, input("run-4"), { ...access("one"), onTerminal })
    lost.emit(interruptedError)
    lost.finish()
    await advance(0)

    expect(gone.state(scope)).toBe("idle")
    expect(ended.map(({ kind }) => kind)).toEqual([
      "turn-started",
      "turn-failed",
    ])
    const goneFailure = { kind: TurnEventKind.TurnFailed, code: "not_found" }
    expect(onTerminal).toHaveBeenLastCalledWith(goneFailure)
    await expect(reloadedHead(gone, scope, "run-4")).resolves.toMatchObject({
      event: goneFailure,
    })
    await advance(UNCERTAINTY_DEADLINE_MS)
    expect(recover).toHaveBeenCalledTimes(1)
    await expect(
      gone.start(otherScope, input("run-5"), access("one"))
    ).resolves.toBeDefined()
  })

  it("leaves a start its provider never answers uncertain at the admission deadline", async () => {
    const { advance } = useFakeClock()
    const recovered = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce(new EventSource()),
      recover: vi
        .fn<ServerTurnEngine["recover"]>()
        .mockRejectedValueOnce(new Error("provider unavailable"))
        .mockResolvedValueOnce(recovered),
    }
    const sessions = coordinator(engine)
    const observed: ExecutionEvent[] = []
    sessions.subscribeExecutions((event) => observed.push(event))
    const hung = expect(
      sessions.start(scope, input("run-1"), access("one"))
    ).rejects.toBeInstanceOf(ServerTurnUncertainError)

    await advance(ADMISSION_DEADLINE_MS)
    await hung
    expect(sessions.state(scope)).toBe("uncertain")
    expect(vi.mocked(engine.start).mock.calls[0]?.[3]?.aborted).toBe(true)
    // A Stop has no handle to reach, but the turn is not over.
    await expect(sessions.stop(scope)).resolves.toBe("stopping")

    // The provider settles the turn once a reconcile reaches it.
    recovered.emit(turnEnded)
    recovered.finish()
    await advance(RECONCILE_BACKOFF.capMs)
    expect(engine.recover).toHaveBeenCalledWith(
      scope,
      { sessionId: scope.sessionId, turnId: "run-1" },
      expect.any(AbortSignal)
    )
    // The start nobody answered and the reconcile that confirmed it are one
    // turn, announced once.
    expect(observed.map(({ kind, turnId }) => [kind, turnId])).toEqual([
      ["turn-started", "run-1"],
      ["turn-finished", "run-1"],
    ])
    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).resolves.toMatchObject({ turnId: "run-2" })
  })

  it("keeps the journal of a turn whose Stop could not be confirmed", async () => {
    const { advance } = useFakeClock()
    const stopped = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => stopped),
      recover: vi.fn(async () => new EventSource()),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    stopped.emit(turnStarted)
    await readLive()
    // The adapter stopped consuming a run Hermes may still be running, so the
    // turn is not over: the journal outlives the error, and the reconcile
    // finds the run still going.
    stopped.emit({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_STOP_UNCERTAIN",
      message: "Stop could not be confirmed.",
    })
    await readLive()
    stopped.finish()
    live.close()
    await advance(0)

    expect(sessions.state(scope)).toBe("running")
    await expect(reloadedHead(sessions, scope, "run-1")).resolves.toMatchObject(
      { event: { kind: TurnEventKind.TurnStarted } }
    )
  })

  it("leaves an execution idle after a provider stream overflow", async () => {
    const overflowed = new EventSource()
    const admitted = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(overflowed)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => admitted),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    overflowed.emit({
      kind: TurnEventKind.TurnFailed,
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
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(reset)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => admitted),
    }
    const sessions = coordinator(engine)
    await sessions.start(scope, input("run-1"), access("one"))
    reset.emit({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_RESET_REQUIRED",
      message: "AOS turn history must be reloaded before continuing.",
    })
    reset.finish()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).resolves.toBeDefined()
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("threads cache key, journal, sequence and terminal hook into started, recovered, discovered, and resumed segments", async () => {
    // A started segment.
    {
      const source = new EventSource()
      const neighbor = new EventSource()
      const onTerminal = vi.fn(async () => undefined)
      const engine: ServerTurnEngine = {
        start: vi.fn(async (target: SessionScope) =>
          target.providerSessionId === otherScope.providerSessionId
            ? neighbor
            : source
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
      source.emit(turnStarted)
      await expect(readLive()).resolves.toMatchObject({
        value: { sequence: 1, event: { kind: TurnEventKind.TurnStarted } },
      })

      await expect(
        reloadedHead(sessions, scope, "run-1")
      ).resolves.toMatchObject({
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      })
      await expect(reloadNeighbor()).resolves.toMatchObject({
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      })

      const terminal = turnEnded
      source.emit(terminal)
      source.finish()
      await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1))
      expect(onTerminal).toHaveBeenCalledWith(terminal)
    }

    // A recovered segment inherits the journal.
    {
      const interrupted = new EventSource()
      const recovered = new EventSource("token-2")
      const neighbor = new EventSource()
      const onTerminal = vi.fn(async () => undefined)
      const engine: ServerTurnEngine = {
        start: vi.fn(async (target: SessionScope) =>
          target.providerSessionId === otherScope.providerSessionId
            ? neighbor
            : interrupted
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
      interrupted.emit(turnStarted)
      await readLive()
      interrupted.emit(interruptedError)
      await readLive()
      interrupted.finish()
      await vi.waitFor(() => expect(sessions.state(scope)).toBe("uncertain"))
      live.close()

      const redial = await sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: "run-1", after: 2 },
        access("one")
      )
      const readRedial = reader(redial)
      recovered.emit(turnStarted)
      // One run keeps one monotonic sequence across its segments.
      await expect(readRedial()).resolves.toMatchObject({
        value: { sequence: 3, event: { kind: TurnEventKind.TurnStarted } },
      })

      await expect(
        reloadedHead(sessions, scope, "run-1")
      ).resolves.toMatchObject({
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      })
      await expect(reloadNeighbor()).resolves.toMatchObject({
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      })

      const terminal = turnEnded
      recovered.emit(terminal)
      recovered.finish()
      await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(2))
      expect(onTerminal).toHaveBeenLastCalledWith(terminal)
    }

    // A discovered segment has no journal.
    {
      const discovered = new EventSource()
      const neighbor = new EventSource()
      const onTerminal = vi.fn(async () => undefined)
      const engine: ServerTurnEngine = {
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
      const turnId = sessions.snapshot(scope).turnId
      expect(turnId).toBeDefined()
      // A discovered run owns no request-scoped resources, so it carries no
      // terminal hook; a later subscriber cannot install one either.
      const live = await sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId: turnId!, after: 0 },
        { ...access("one"), onTerminal }
      )
      const readLive = reader(live)
      discovered.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Hel",
      })
      await expect(readLive()).resolves.toMatchObject({
        value: { sequence: 1, event: { kind: TurnEventKind.MessageChunk } },
      })

      // AOS never saw this run start, so there is nothing to replay.
      await expect(
        reloadedHead(sessions, scope, turnId!)
      ).resolves.toMatchObject({
        event: { kind: TurnEventKind.TurnFailed, code: "AOS_RESET_REQUIRED" },
      })
      await expect(reloadNeighbor()).resolves.toMatchObject({
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      })

      discovered.emit(turnEnded)
      discovered.finish()
      await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
      expect(onTerminal).not.toHaveBeenCalled()
    }

    // A resumed segment gets a fresh journal.
    {
      const interrupted = new EventSource()
      const resumed = new EventSource()
      const neighbor = new EventSource()
      const onTerminal = vi.fn(async () => undefined)
      const sources = [interrupted, resumed]
      const engine: ServerTurnEngine = {
        start: vi.fn(async (target: SessionScope) =>
          target.providerSessionId === otherScope.providerSessionId
            ? neighbor
            : sources.shift()!
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
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          {
            requestId: "question-1",
            kind: PendingRequestKind.Elicitation,
            responseSchema: { type: "object" },
          },
        ],
      })
      interrupted.finish()
      await vi.waitFor(() =>
        expect(sessions.state(scope)).toBe("waiting-for-input")
      )

      const turnId = await continueTurn(sessions)
      const live = await sessions.recover(
        scope,
        { sessionId: scope.sessionId, turnId },
        access("one")
      )
      const readLive = reader(live)
      resumed.emit(turnStarted)
      // A resumed turn is a fresh segment: its own journal and sequence.
      await expect(readLive()).resolves.toMatchObject({
        value: { sequence: 1, event: { kind: TurnEventKind.TurnStarted } },
      })
      await expect(
        reloadedHead(sessions, scope, turnId)
      ).resolves.toMatchObject({
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      })
      await expect(reloadNeighbor()).resolves.toMatchObject({
        sequence: 1,
        event: { kind: TurnEventKind.TurnStarted },
      })

      resumed.emit(turnEnded)
      resumed.finish()
      await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
      // The resumed segment carries no terminal hook of its own.
      expect(onTerminal).toHaveBeenCalledTimes(1)
    }
  })

  it("settles an execution whose provider stream ends after the turn settled", async () => {
    const source = new EventSource()
    const admitted = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(admitted),
      recover: vi.fn(async () => admitted),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    source.emit(turnStarted)
    await readLive()

    // The provider reported this turn over without a terminal turn event.
    source.settle()
    source.close()

    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    await expect(
      sessions.start(scope, input("run-2"), access("one"))
    ).resolves.toBeDefined()
    expect(engine.recover).not.toHaveBeenCalled()
  })

  it("leaves an execution uncertain when its provider stream ends unsettled", async () => {
    const { advance } = useFakeClock()
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => {
        throw new Error("provider unavailable")
      }),
    }
    const sessions = coordinator(engine)
    const live = await sessions.start(scope, input("run-1"), access("one"))
    const readLive = reader(live)
    source.emit(turnStarted)
    await readLive()

    source.close()
    await advance(0)

    expect(sessions.state(scope)).toBe("uncertain")
  })
  it("observes the lifecycle of a run it drives under public identity", async () => {
    const source = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi.fn(async () => source),
      recover: vi.fn(async () => source),
    }
    const sessions = coordinator(engine)
    const observed: ExecutionEvent[] = []
    sessions.subscribeExecutions((event) => observed.push(event))

    await sessions.start(scope, input("run-1"), access("one"))
    source.emit(turnEnded)
    source.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    expect(observed.map(({ kind, turnId }) => [kind, turnId])).toEqual([
      ["turn-started", "run-1"],
      ["turn-finished", "run-1"],
    ])
    expect(observed[0]).toMatchObject({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    })
    expect(Number.isNaN(Date.parse(observed[0]!.occurredAt))).toBe(false)
  })

  it("logs the transition that finishes a turn with the ids of that turn", async () => {
    const source = new EventSource()
    const logs = captureLogs()
    const sessions = coordinator(
      { start: vi.fn(async () => source), recover: vi.fn(async () => source) },
      { logger: logs.logger }
    )
    const read = reader(
      await sessions.start(scope, input("run-1"), access("one"))
    )

    source.emit(turnEnded)
    await read()

    expect(
      logs
        .records()
        .filter(
          ({ message, fields }) =>
            message === "turn.transition" && fields.to === "idle"
        )
    ).toMatchObject([
      {
        fields: {
          from: "running",
          to: "idle",
          generation: expect.any(Number),
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          turnId: "run-1",
        },
      },
    ])
  })

  it("observes one attention request per pending request and resolves it on reply", async () => {
    const interrupted = new EventSource()
    const resumed = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(resumed),
      recover: vi.fn(async () => resumed),
    }
    const sessions = coordinator(engine)
    const observed: ExecutionEvent[] = []
    sessions.subscribeExecutions((event) => observed.push(event))

    await sessions.start(scope, input("run-1"), access("one"))
    interrupted.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "question-1",
          kind: PendingRequestKind.Elicitation,
          responseSchema: { type: "object" },
        },
      ],
    })
    interrupted.finish()
    await vi.waitFor(() =>
      expect(sessions.state(scope)).toBe("waiting-for-input")
    )

    const turnId = await continueTurn(sessions)

    expect(observed.map((event) => [event.kind, event.turnId])).toEqual([
      ["turn-started", "run-1"],
      ["attention-requested", "run-1"],
      ["attention-resolved", "run-1"],
      ["turn-started", turnId],
    ])
    expect(observed[1]).toMatchObject({ request: { requestId: "question-1" } })
    expect(observed[2]).toMatchObject({ requestId: "question-1" })
  })

  it("observes one Session alone, matched on its provider scope", async () => {
    const [first, other, later] = [
      new EventSource(),
      new EventSource(),
      new EventSource(),
    ]
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(other)
        .mockResolvedValueOnce(later),
      recover: vi.fn(async () => later),
    }
    const sessions = coordinator(engine)
    const observed: ExecutionEvent[] = []
    const unsubscribe = sessions.subscribeScope(
      { agentId: scope.agentId, providerSessionId: scope.providerSessionId },
      (event) => observed.push(event)
    )

    // A guest's thread names the same Session under another public id.
    await sessions.start(
      { ...scope, sessionId: "guest-ref" },
      input("run-1"),
      access("one")
    )
    await sessions.start(otherScope, input("run-2"), access("two"))
    first.emit(turnEnded)
    other.emit(turnEnded)
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))
    await vi.waitFor(() => expect(sessions.state(otherScope)).toBe("idle"))
    unsubscribe()
    await sessions.start(scope, input("run-3"), access("one"))

    expect(observed.map(({ kind, turnId }) => [kind, turnId])).toEqual([
      ["turn-started", "run-1"],
      ["turn-finished", "run-1"],
    ])
  })

  it("observes a failed run and stops delivering after unsubscribing", async () => {
    const first = new EventSource()
    const second = new EventSource()
    const engine: ServerTurnEngine = {
      start: vi
        .fn<ServerTurnEngine["start"]>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      recover: vi.fn(async () => second),
    }
    const sessions = coordinator(engine)
    const observed: ExecutionEvent[] = []
    const unsubscribe = sessions.subscribeExecutions((event) =>
      observed.push(event)
    )

    await sessions.start(scope, input("run-1"), access("one"))
    first.emit({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_PROVIDER_FAILED",
      message: "The provider rejected the turn.",
    })
    first.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    expect(observed.map(({ kind, turnId }) => [kind, turnId])).toEqual([
      ["turn-started", "run-1"],
      ["turn-failed", "run-1"],
    ])

    unsubscribe()
    await sessions.start(scope, input("run-2"), access("one"))
    second.emit(turnEnded)
    second.finish()
    await vi.waitFor(() => expect(sessions.state(scope)).toBe("idle"))

    expect(observed).toHaveLength(2)
  })

  describe("eviction and gauges", () => {
    it("evicts an idle execution and its journal when its last reading subscriber leaves", async () => {
      const { advance } = useFakeClock()
      const source = new EventSource()
      const engine: ServerTurnEngine = {
        start: vi.fn(async () => source),
        recover: vi.fn(async () => source),
      }
      const sessions = coordinator(engine)
      const unsubscribe = sessions.subscribeReadings(scope, "member-1", {
        execution: async () => undefined,
      })

      await sessions.start(scope, input("run-1"), access("one"))
      // A stream that settles without a terminal event keeps its journal.
      source.emit(turnStarted)
      source.finish()
      await advance(0)
      expect(sessions.state(scope)).toBe("idle")
      expect(sessions.gauges().executions).toBe(1)
      expect(sessions.gauges().journalBytes).toBeGreaterThan(0)

      unsubscribe()
      expect(sessions.gauges()).toMatchObject({
        executions: 0,
        journalBytes: 0,
      })
    })

    it("does not evict a running execution when its last subscriber leaves", async () => {
      const { advance } = useFakeClock()
      const source = new EventSource()
      const engine: ServerTurnEngine = {
        start: vi.fn(async () => source),
        recover: vi.fn(async () => source),
      }
      const sessions = coordinator(engine)
      const unsubscribe = sessions.subscribeReadings(scope, "member-1", {
        execution: async () => undefined,
      })

      await sessions.start(scope, input("run-1"), access("one"))
      source.emit(turnStarted)
      await advance(0)

      unsubscribe()
      expect(sessions.gauges().executions).toBe(1)

      source.emit(turnEnded)
      source.finish()
      await advance(0)
      expect(sessions.gauges().executions).toBe(0)
    })

    it("lets a start in flight run when its last subscriber leaves", async () => {
      const { advance } = useFakeClock()
      const source = new EventSource()
      let answer!: (handle: ServerTurnHandle) => void
      const engine: ServerTurnEngine = {
        start: vi.fn(
          () =>
            new Promise<ServerTurnHandle>((resolve) => {
              answer = resolve
            })
        ),
        recover: vi.fn(async () => source),
      }
      const sessions = coordinator(engine)
      const unsubscribe = sessions.subscribeReadings(scope, "member-1", {
        execution: async () => undefined,
      })
      const started = sessions.start(scope, input("run-1"), access("one"))
      await advance(0)

      unsubscribe()
      answer(source)

      await expect(started).resolves.toMatchObject({ turnId: "run-1" })
      expect(sessions.state(scope)).toBe("running")
    })

    it("keeps a Session whose subscriber returns before its turn settles", async () => {
      const { advance } = useFakeClock()
      const source = new EventSource()
      const engine: ServerTurnEngine = {
        start: vi.fn(async () => source),
        recover: vi.fn(async () => source),
      }
      const sessions = coordinator(engine)
      const leave = sessions.subscribeReadings(scope, "member-1", {
        execution: async () => undefined,
      })
      await sessions.start(scope, input("run-1"), access("one"))
      leave()
      const readings: unknown[] = []
      sessions.subscribeReadings(scope, "member-2", {
        execution: async (reading) => {
          readings.push(reading)
        },
      })

      source.emit(turnEnded)
      source.finish()
      await advance(0)

      expect(sessions.gauges().executions).toBe(1)
      expect(readings.at(-1)).toMatchObject({ state: "idle" })
    })

    it("ends an uncertain turn its last subscriber left before evicting it", async () => {
      const { advance } = useFakeClock()
      const interrupted = new EventSource()
      const engine: ServerTurnEngine = {
        start: vi.fn(async () => interrupted),
        // The provider never answers, so each recover waits out its deadline.
        recover: vi.fn<ServerTurnEngine["recover"]>(
          (_target, _request, signal) =>
            new Promise((_resolve, reject) => {
              signal!.addEventListener("abort", () => reject(signal!.reason))
            })
        ),
      }
      const sessions = coordinator(engine)
      const observed: ExecutionEvent[] = []
      sessions.subscribeExecutions((event) => observed.push(event))
      const leave = sessions.subscribeReadings(scope, "member-1", {
        execution: async () => undefined,
      })
      const onTerminal = vi.fn(async () => undefined)
      await sessions.start(scope, input("run-1"), {
        ...access("one"),
        onTerminal,
      })
      interrupted.emit(interruptedError)
      interrupted.finish()
      await advance(0)
      leave()
      expect(sessions.gauges()).toMatchObject({ executions: 1, uncertain: 1 })

      await advance(ADMISSION_DEADLINE_MS + UNCERTAINTY_DEADLINE_MS)

      expect(observed.map(({ kind }) => kind)).toEqual([
        "turn-started",
        "turn-failed",
      ])
      expect(onTerminal).toHaveBeenLastCalledWith(
        expect.objectContaining({ code: "AOS_OUTCOME_UNKNOWN" })
      )
      expect(sessions.gauges()).toMatchObject({
        executions: 0,
        uncertain: 0,
        deadlinesFired: 1,
      })
    })
  })
})
