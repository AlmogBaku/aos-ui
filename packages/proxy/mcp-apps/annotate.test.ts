import { afterEach, describe, expect, it, vi } from "vitest"

import { TurnEventKind, type TurnEvent } from "../core/events"
import type {
  ServerMcpApps,
  ServerTurnEngine,
  ServerTurnHandle,
  ServerRuntime,
  SessionScope,
} from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"
import { withMcpApps } from "./annotate"

/** A provider segment the test feeds by hand, as a native engine would. */
class NativeTurn implements ServerTurnHandle {
  readonly #values: TurnEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<TurnEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly settled: Promise<void>
  #settle!: () => void
  #closed = false

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#settle = resolve
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

  /** The provider settles and ends its stream, as a finished native turn does. */
  finish() {
    this.#settle()
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined })
  }

  recoveryPosition() {
    return { epoch: "epoch-1", lastSeen: 7 }
  }
}

const scope: SessionScope = {
  agentId: "aos-test",
  sessionId: "stored-1",
  threadId: "stored-1",
}

const access = {
  subscriberId: "browser",
  controllerId: "browser",
  lane: "operator",
  canControl: true,
} as const

/** A `render_chart` turn exactly as far as the provider streams it. */
const chartTurn: TurnEvent[] = [
  { kind: TurnEventKind.TurnStarted },
  {
    kind: TurnEventKind.ToolCallStarted,
    toolCallId: "call-1",
    title: "render_chart",
    name: "render_chart",
    parentMessageId: "assistant-1",
  },
  {
    kind: TurnEventKind.ToolCallInputChunk,
    toolCallId: "call-1",
    delta: '{"type":"pie","data":[{"label":"a","value":1}]}',
  },
  { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "call-1" },
  {
    kind: TurnEventKind.ToolCallFinished,
    toolCallId: "call-1",
    output: '{"content":[{"type":"text","text":"Chart shown."}]}',
    failed: false,
  },
  {
    kind: TurnEventKind.MessageChunk,
    messageId: "assistant-2",
    text: "Here is the chart.",
  },
  { kind: TurnEventKind.TurnEnded },
]

function harness(describeView: ServerMcpApps["describe"]) {
  const native = new NativeTurn()
  const engine = {
    start: vi.fn(async () => native),
    recover: vi.fn(async () => native),
  } satisfies ServerTurnEngine
  const apps: ServerMcpApps = {
    describe: vi.fn(describeView),
    observe: vi.fn(),
    open: vi.fn(),
    callTool: vi.fn(),
    readResource: vi.fn(),
  }
  const runtime = withMcpApps({
    turns: engine,
    mcpApps: apps,
  } as unknown as ServerRuntime)
  const sessions = new SessionCoordinator({
    engine: runtime.turns,
    readings: runtime,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: 64,
    maxSubscriberBytes: 256 * 1024,
    maxReplayEvents: 64,
    maxReplayBytes: 256 * 1024,
  })
  return { native, engine, apps, sessions }
}

async function runTurn(
  sessions: SessionCoordinator,
  native: NativeTurn,
  afterStream: () => Promise<void> = async () => undefined
) {
  const subscription = await sessions.start(
    scope,
    {
      turnId: "turn-1",
      messageId: "user-1",
      prompt: "show me a piechart",
    },
    access
  )
  // The provider streams the whole turn and settles before the wrapper has
  // learned whether the first call opens a view.
  for (const event of chartTurn) native.emit(event)
  native.finish()
  await afterStream()
  const received: TurnEvent[] = []
  for await (const { event } of subscription.events) {
    received.push(event)
    if (event.kind === TurnEventKind.TurnEnded) break
  }
  subscription.close()
  return received
}

afterEach(() => {
  vi.useRealTimers()
})

describe("withMcpApps on a live turn", () => {
  it("finishes a turn whose view lookup outlasts the provider stream", async () => {
    let answer!: (value: boolean) => void
    const { native, engine, apps, sessions } = harness(
      () => new Promise((resolve) => (answer = resolve))
    )

    const received = await runTurn(sessions, native, async () => {
      await vi.waitFor(() => expect(apps.describe).toHaveBeenCalled())
      answer(true)
    })

    expect(received.map((event) => event.kind)).toEqual(
      chartTurn.map((event) => event.kind)
    )
    expect(received[1]).toMatchObject({ name: "render_chart", app: true })
    expect(received[4]).toMatchObject({ toolCallId: "call-1", app: true })
    expect(received.at(-1)?.kind).toBe(TurnEventKind.TurnEnded)
    expect(sessions.state(scope)).toBe("idle")
    expect(engine.recover).not.toHaveBeenCalled()
    expect(apps.observe).toHaveBeenLastCalledWith(scope, {
      toolCallId: "call-1",
      toolName: "render_chart",
      result: { content: [{ type: "text", text: "Chart shown." }] },
    })
  })

  it.each([
    ["never answers", () => new Promise<boolean>(() => undefined)],
    ["fails", () => Promise.reject(new Error("tools/list failed"))],
  ])(
    "finishes an unflagged turn when the view lookup %s",
    async (_case, describeView) => {
      vi.useFakeTimers()
      const { native, engine, sessions } = harness(describeView)

      const turn = runTurn(sessions, native)
      await vi.advanceTimersByTimeAsync(5_000)
      const received = await turn

      expect(received.map((event) => event.kind)).toEqual(
        chartTurn.map((event) => event.kind)
      )
      expect(received.some((event) => "app" in event)).toBe(false)
      expect(sessions.state(scope)).toBe("idle")
      expect(engine.recover).not.toHaveBeenCalled()
    }
  )
})

describe("withMcpApps on a watched Session", () => {
  it("keeps the engine's watch, so rooms still hear runtime-started turns", () => {
    const stop = vi.fn()
    const watch = vi.fn(() => stop)
    const engine = {
      start: vi.fn(),
      recover: vi.fn(),
      watch,
    } as unknown as ServerTurnEngine
    const runtime = withMcpApps({
      turns: engine,
      mcpApps: {} as ServerMcpApps,
    } as unknown as ServerRuntime)
    const watcher = { onTurn: vi.fn(), onError: vi.fn() }

    runtime.turns.watch?.(scope, watcher)()

    expect(watch).toHaveBeenCalledWith(scope, watcher)
    expect(stop).toHaveBeenCalledOnce()
  })
})
