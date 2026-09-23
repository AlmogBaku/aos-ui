import { afterEach, describe, expect, it, vi } from "vitest"

import { RunEventKind, type RunEvent } from "../core/events"
import type {
  ServerMcpApps,
  ServerRunEngine,
  ServerRunHandle,
  ServerRuntime,
  SessionScope,
} from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"
import { withMcpApps } from "./annotate"

/** A provider segment the test feeds by hand, as a native engine would. */
class NativeRun implements ServerRunHandle {
  readonly #values: RunEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<RunEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly settled: Promise<void>
  #settle!: () => void
  #closed = false

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#settle = resolve
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
const chartTurn: RunEvent[] = [
  { type: RunEventKind.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
  {
    type: RunEventKind.TOOL_CALL_START,
    toolCallId: "call-1",
    toolCallName: "render_chart",
    parentMessageId: "assistant-1",
  },
  {
    type: RunEventKind.TOOL_CALL_ARGS,
    toolCallId: "call-1",
    delta: '{"type":"pie","data":[{"label":"a","value":1}]}',
  },
  { type: RunEventKind.TOOL_CALL_END, toolCallId: "call-1" },
  {
    type: RunEventKind.TOOL_CALL_RESULT,
    messageId: "tool-1",
    toolCallId: "call-1",
    content: '{"content":[{"type":"text","text":"Chart shown."}]}',
  },
  {
    type: RunEventKind.TEXT_MESSAGE_START,
    messageId: "assistant-2",
    role: "assistant",
  },
  {
    type: RunEventKind.TEXT_MESSAGE_CONTENT,
    messageId: "assistant-2",
    delta: "Here is the chart.",
  },
  { type: RunEventKind.TEXT_MESSAGE_END, messageId: "assistant-2" },
  { type: RunEventKind.RUN_FINISHED, threadId: scope.threadId, runId: "run-1" },
]

function harness(describeView: ServerMcpApps["describe"]) {
  const native = new NativeRun()
  const engine = {
    start: vi.fn(async () => native),
    recover: vi.fn(async () => native),
  } satisfies ServerRunEngine
  const apps: ServerMcpApps = {
    describe: vi.fn(describeView),
    observe: vi.fn(),
    open: vi.fn(),
    callTool: vi.fn(),
    readResource: vi.fn(),
  }
  const runtime = withMcpApps({
    runs: engine,
    mcpApps: apps,
  } as unknown as ServerRuntime)
  const sessions = new SessionCoordinator({
    engine: runtime.runs,
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
  native: NativeRun,
  afterStream: () => Promise<void> = async () => undefined
) {
  const subscription = await sessions.start(
    scope,
    {
      threadId: scope.threadId,
      runId: "run-1",
      state: {},
      messages: [{ id: "user-1", role: "user", content: "show me a piechart" }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
    access
  )
  // The provider streams the whole turn and settles before the wrapper has
  // learned whether the first call opens a view.
  for (const event of chartTurn) native.emit(event)
  native.finish()
  await afterStream()
  const received: RunEvent[] = []
  for await (const { event } of subscription.events) {
    received.push(event)
    if (event.type === RunEventKind.RUN_FINISHED) break
  }
  subscription.close()
  return received
}

afterEach(() => {
  vi.useRealTimers()
})

describe("withMcpApps on a live run", () => {
  it("finishes a turn whose view lookup outlasts the provider stream", async () => {
    let answer!: (value: boolean) => void
    const { native, engine, apps, sessions } = harness(
      () => new Promise((resolve) => (answer = resolve))
    )

    const received = await runTurn(sessions, native, async () => {
      await vi.waitFor(() => expect(apps.describe).toHaveBeenCalled())
      answer(true)
    })

    expect(received.map((event) => event.type)).toEqual(
      chartTurn.map((event) => event.type)
    )
    expect(received[1]).toMatchObject({ toolCallName: "render_chart", app: true })
    expect(received[4]).toMatchObject({ toolCallId: "call-1", app: true })
    expect(received.at(-1)?.type).not.toBe(RunEventKind.RUN_ERROR)
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

      expect(received.map((event) => event.type)).toEqual(
        chartTurn.map((event) => event.type)
      )
      expect(received.some((event) => "app" in event)).toBe(false)
      expect(sessions.state(scope)).toBe("idle")
      expect(engine.recover).not.toHaveBeenCalled()
    }
  )
})
