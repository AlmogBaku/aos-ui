import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import type {
  OpenCodeClient,
  OpenCodeDurableEvent,
  OpenCodeSessionEvents,
} from "./client"
import { OpenCodeMutationUncertainError } from "./client"
import { OpenCodeRunEngine } from "./run"

const scope = {
  agentId: "writer",
  sessionId: "session-1",
  threadId: "thread-1",
}
const admission = {
  "run-1":
    "aos_05d71f07f383373fe7777c8bcf8282cb6cd66f15ea7d45671d26279c7c5ef561",
  "run-recovered":
    "aos_957d880ef3fdbdf4c7672021817c07ee7a619ed7e18b557da7e9b07adad0b12c",
}

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: scope.threadId,
    runId: "run-1",
    state: {},
    messages: [{ id: "user-1", role: "user", content: "Hello OpenCode" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  }
}

function historyEvent(
  seq: number,
  type: string,
  data: Record<string, unknown> = {}
) {
  return {
    id: `native-${seq}`,
    type,
    durable: { aggregateID: scope.sessionId, seq, version: 1 },
    data: { sessionID: scope.sessionId, ...data },
  }
}

function liveEvent(
  seq: number,
  type: string,
  data: Record<string, unknown> = {}
): OpenCodeDurableEvent {
  return {
    id: String(seq),
    event: "session",
    data: historyEvent(seq, type, data),
  }
}

function admitted(seq: number, id: string) {
  return historyEvent(seq, "session.next.prompt.admitted", {
    timestamp: seq,
    messageID: id,
    prompt: { text: "prompt" },
    delivery: "queue",
  })
}

function textEnded(seq: number, text: string, message = `assistant-${seq}`) {
  return historyEvent(seq, "session.next.text.ended", {
    timestamp: seq,
    assistantMessageID: message,
    textID: `text-${seq}`,
    text,
  })
}

function controlledStream() {
  const values: OpenCodeDurableEvent[] = []
  const waiters: Array<() => void> = []
  let aborted = false
  let failure: unknown
  const abort = vi.fn(() => {
    aborted = true
    for (const wake of waiters.splice(0)) wake()
  })
  const source: OpenCodeSessionEvents = {
    async *[Symbol.asyncIterator]() {
      while (!aborted) {
        if (failure) throw failure
        const value = values.shift()
        if (value) {
          yield value
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
    abort,
  }
  return {
    source,
    abort,
    publish(value: OpenCodeDurableEvent) {
      values.push(value)
      waiters.shift()?.()
    },
    fail(error = new Error("lost")) {
      failure = error
      waiters.shift()?.()
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function client(overrides: Record<string, unknown> = {}) {
  const observation = controlledStream()
  const sessions = {
    get: vi.fn(async () => ({
      data: { id: scope.sessionId, agent: scope.agentId },
    })),
    active: vi.fn(async () => ({ data: {} })),
    prompt: vi.fn(
      async (_sessionId: string, request: { id: string; prompt: unknown }) => ({
        data: {
          admittedSeq: 0,
          id: request.id,
          sessionID: scope.sessionId,
          prompt: request.prompt,
          delivery: "queue",
          timeCreated: 1,
        },
      })
    ),
    interrupt: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
    history: vi.fn(async () => ({ data: [], hasMore: false })),
    events: vi.fn(async () => observation.source),
    ...overrides,
  }
  return {
    native: {
      sessions,
      catalog: {},
      close: async () => undefined,
    } as unknown as OpenCodeClient,
    sessions,
    observation,
  }
}

async function collect(handle: { events: AsyncIterable<unknown> }) {
  const values: unknown[] = []
  for await (const value of handle.events) values.push(value)
  return values
}

async function until(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 5 })
}

describe("OpenCodeRunEngine", () => {
  it("rejects a wrong native Agent owner before observation or mutation", async () => {
    const state = client({
      get: vi.fn(async () => ({
        data: { id: scope.sessionId, agent: "other-agent" },
      })),
    })

    await expect(
      new OpenCodeRunEngine(state.native).start(scope, input())
    ).rejects.toThrow("Session does not belong to this Agent")
    expect(state.sessions.events).not.toHaveBeenCalled()
    expect(state.sessions.prompt).not.toHaveBeenCalled()
  })

  it("subscribes before prompt admission and finishes only after wait plus authoritative idle reconciliation", async () => {
    const wait = deferred()
    let running = false
    const state = client({
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
      wait: vi.fn(async () => wait.promise),
    })
    state.sessions.prompt = vi.fn(
      async (_sessionId: string, request: { id: string; prompt: unknown }) => {
        expect(state.sessions.events).toHaveBeenCalledOnce()
        running = true
        return {
          data: {
            admittedSeq: 0,
            id: request.id,
            sessionID: scope.sessionId,
            prompt: request.prompt,
            delivery: "queue",
            timeCreated: 1,
          },
        }
      }
    )

    const handle = await new OpenCodeRunEngine(state.native).start(
      scope,
      input()
    )
    state.observation.publish(
      liveEvent(0, "session.next.prompt.admitted", {
        timestamp: 0,
        messageID: admission["run-1"],
        prompt: { text: "Hello OpenCode" },
        delivery: "queue",
      })
    )
    state.observation.publish(
      liveEvent(1, "session.next.text.ended", {
        timestamp: 1,
        assistantMessageID: "assistant-1",
        textID: "text-1",
        text: "Done",
      })
    )
    running = false
    wait.resolve()

    const events = await collect(handle)
    expect(state.sessions.prompt).toHaveBeenCalledOnce()
    expect(state.sessions.events).toHaveBeenCalledWith(scope.sessionId, {})
    expect(events.map((value) => (value as { type: string }).type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    for (const value of events)
      expect(EventSchemas.safeParse(value).success).toBe(true)
  })

  it("uses a backoff timer for authoritative reconciliation when native wait is unavailable", async () => {
    let running = false
    const state = client({
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
      prompt: vi.fn(
        async (_id: string, request: { id: string; prompt: unknown }) => {
          running = true
          return {
            data: {
              admittedSeq: 0,
              id: request.id,
              sessionID: scope.sessionId,
              prompt: request.prompt,
              delivery: "queue",
              timeCreated: 1,
            },
          }
        }
      ),
      wait: vi.fn(async () => {
        running = false
        throw new Error("operation unavailable")
      }),
    })
    const handle = await new OpenCodeRunEngine(state.native, {
      waitRetryMs: 1,
    }).start(scope, input())
    state.observation.publish(
      liveEvent(0, "session.next.prompt.admitted", {
        timestamp: 0,
        messageID: admission["run-1"],
        prompt: { text: "Hello OpenCode" },
        delivery: "queue",
      })
    )

    await expect(handle.settled).resolves.toBeUndefined()
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
    })
    expect(state.sessions.wait).toHaveBeenCalledOnce()
  })

  it("validates a bound resume before bypassing active conflict, subscribes before its void mutation, and invents no cursor", async () => {
    const order: string[] = []
    const state = client({
      active: vi.fn(async () => ({
        data: { [scope.sessionId]: { type: "running" } },
      })),
      events: vi.fn(async () => {
        order.push("subscribe")
        return controlledStream().source
      }),
      wait: vi.fn(async () => new Promise<void>(() => {})),
    })
    const engine = new OpenCodeRunEngine(state.native, {
      resume: {
        validate: vi.fn(async () => {
          order.push("validate")
        }),
        dispatch: vi.fn(async () => {
          order.push("dispatch")
        }),
      },
    })

    const handle = await engine.start(
      scope,
      input({
        runId: "run-resume",
        messages: [],
        resume: [
          { interruptId: "approval-1", status: "resolved", payload: "once" },
        ],
      })
    )

    expect(order).toEqual(["validate", "subscribe", "dispatch"])
    expect(state.sessions.events).toHaveBeenCalledWith(scope.sessionId, {})
    expect(state.sessions.prompt).not.toHaveBeenCalled()
    await handle.stop()
  })

  it("recovers only the verified stable admission interval and never resends", async () => {
    const all = [
      admitted(0, "other-run"),
      textEnded(1, "Other"),
      admitted(2, admission["run-recovered"]),
      textEnded(3, "Recovered", "assistant-recovered"),
      admitted(4, "newer-run"),
      textEnded(5, "Newer"),
    ]
    const state = client({
      history: vi.fn(async (_id: string, options?: { after?: number }) => ({
        data: all.filter((event) => event.durable.seq > (options?.after ?? -1)),
        hasMore: false,
      })),
    })

    const handle = await new OpenCodeRunEngine(state.native).recover(scope, {
      threadId: scope.threadId,
      runId: "run-recovered",
    })
    const events = await collect(handle)

    expect(state.sessions.prompt).not.toHaveBeenCalled()
    expect(JSON.stringify(events)).toContain("Recovered")
    expect(JSON.stringify(events)).not.toContain("Other")
    expect(JSON.stringify(events)).not.toContain("Newer")
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it("rejects recovery when the stable admission cannot be verified", async () => {
    const state = client({
      history: vi.fn(async () => ({
        data: [admitted(0, "another-run"), textEnded(1, "Not ours")],
        hasMore: false,
      })),
    })

    await expect(
      new OpenCodeRunEngine(state.native).recover(scope, {
        threadId: scope.threadId,
        runId: "run-recovered",
      })
    ).rejects.toThrow("stable prompt admission")
    expect(state.sessions.prompt).not.toHaveBeenCalled()
  })

  it("buffers live events during recovery reads and merges the final event before idle settlement", async () => {
    let calls = 0
    const state = client()
    state.sessions.history = vi.fn(
      async (_id: string, options?: { after?: number }) => {
        calls += 1
        if (calls === 1) {
          state.observation.publish(
            liveEvent(1, "session.next.text.ended", {
              timestamp: 1,
              assistantMessageID: "assistant-race",
              textID: "text-race",
              text: "Won the race",
            })
          )
          return {
            data: [admitted(0, admission["run-recovered"])],
            hasMore: false,
          }
        }
        return {
          data:
            options?.after === 0
              ? [
                  historyEvent(1, "session.next.text.ended", {
                    timestamp: 1,
                    assistantMessageID: "assistant-race",
                    textID: "text-race",
                    text: "Won the race",
                  }),
                ]
              : [],
          hasMore: false,
        }
      }
    )

    const handle = await new OpenCodeRunEngine(state.native).recover(scope, {
      threadId: scope.threadId,
      runId: "run-recovered",
    })
    expect(JSON.stringify(await collect(handle))).toContain("Won the race")
  })

  it("keeps native lifecycle nonterminal after transport loss so Stop still interrupts", async () => {
    const wait = deferred()
    const state = client({
      wait: vi.fn(async () => wait.promise),
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValue({
          data: { [scope.sessionId]: { type: "running" } },
        }),
    })
    const handle = await new OpenCodeRunEngine(state.native).start(
      scope,
      input()
    )
    state.observation.fail()
    await until(() => expect(state.observation.abort).toHaveBeenCalled())

    await expect(handle.stop()).resolves.toBe("stopping")
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
    const events = await collect(handle)
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR })
  })

  it("marks Stop idle only after the interrupt is acknowledged and active state is authoritatively empty", async () => {
    let running = false
    const state = client({
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
      prompt: vi.fn(
        async (_id: string, request: { id: string; prompt: unknown }) => {
          running = true
          return {
            data: {
              admittedSeq: 0,
              id: request.id,
              sessionID: scope.sessionId,
              prompt: request.prompt,
              delivery: "queue",
              timeCreated: 1,
            },
          }
        }
      ),
      interrupt: vi.fn(async () => {
        running = false
      }),
      wait: vi.fn(async () => new Promise<void>(() => {})),
    })
    const handle = await new OpenCodeRunEngine(state.native).start(
      scope,
      input()
    )
    state.observation.publish(
      liveEvent(0, "session.next.prompt.admitted", {
        timestamp: 0,
        messageID: admission["run-1"],
        prompt: { text: "Hello OpenCode" },
        delivery: "queue",
      })
    )
    await until(() => expect(handle.recoveryPosition().lastSeen).toBe(0))

    await expect(handle.stop()).resolves.toBe("idle")
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      result: { stopped: true },
    })
  })

  it("replaces the prior scoped observation and bounds an unconsumed event queue", async () => {
    const first = controlledStream()
    const second = controlledStream()
    const sources = [first.source, second.source]
    const state = client({
      events: vi.fn(async () => sources.shift()!),
      wait: vi.fn(async () => new Promise<void>(() => {})),
      history: vi.fn(async (_id: string, options?: { after?: number }) => ({
        data:
          sources.length === 0 && (options?.after ?? -1) < 0
            ? [admitted(0, admission["run-recovered"])]
            : [],
        hasMore: false,
      })),
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValue({
          data: { [scope.sessionId]: { type: "running" } },
        }),
    })
    const engine = new OpenCodeRunEngine(state.native, { maxQueueEvents: 2 })
    const prior = await engine.start(scope, input())
    await engine.recover(scope, {
      threadId: scope.threadId,
      runId: "run-recovered",
    })

    expect(first.abort).toHaveBeenCalledOnce()
    const priorEvents = await collect(prior)
    expect(priorEvents).toHaveLength(2)
    expect(priorEvents.at(-1)).toMatchObject({ type: EventType.RUN_ERROR })
  })

  it("resets a segment instead of growing an unconsumed AG-UI queue", async () => {
    const state = client({
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValue({
          data: { [scope.sessionId]: { type: "running" } },
        }),
      wait: vi.fn(async () => new Promise<void>(() => {})),
    })
    const handle = await new OpenCodeRunEngine(state.native, {
      maxQueueEvents: 2,
    }).start(scope, input())

    state.observation.publish(
      liveEvent(0, "session.next.prompt.admitted", {
        timestamp: 0,
        messageID: admission["run-1"],
        prompt: { text: "Hello OpenCode" },
        delivery: "queue",
      })
    )
    state.observation.publish(
      liveEvent(1, "session.next.text.ended", {
        timestamp: 1,
        assistantMessageID: "assistant-overflow",
        textID: "text-overflow",
        text: "overflow",
      })
    )

    const events = await collect(handle)
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "AOS_RESET_REQUIRED",
    })
  })

  it("preserves uncertain prompt and Stop mutations without retry", async () => {
    const promptUncertain = new OpenCodeMutationUncertainError()
    const promptCase = client({
      prompt: vi.fn(async () => Promise.reject(promptUncertain)),
    })
    await expect(
      new OpenCodeRunEngine(promptCase.native).start(scope, input())
    ).rejects.toBe(promptUncertain)
    expect(promptCase.sessions.prompt).toHaveBeenCalledOnce()

    const stopUncertain = new OpenCodeMutationUncertainError()
    const stopCase = client({
      wait: vi.fn(async () => new Promise<void>(() => {})),
      interrupt: vi.fn(async () => Promise.reject(stopUncertain)),
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValue({
          data: { [scope.sessionId]: { type: "running" } },
        }),
    })
    const handle = await new OpenCodeRunEngine(stopCase.native).start(
      scope,
      input()
    )
    await expect(handle.stop()).rejects.toBe(stopUncertain)
    expect(stopCase.sessions.interrupt).toHaveBeenCalledOnce()
  })
})
