import { RunEventKind, RunEventSchema, type TurnInput } from "../../core/events"
import { describe, expect, it, vi } from "vitest"

import type {
  OpenCodeClient,
  OpenCodeDurableEvent,
  OpenCodeSessionEvents,
} from "./client"
import { SessionCoordinator } from "../../core/session-coordinator"
import { OpenCodeMutationUncertainError } from "./client"
import { OpenCodeContent } from "./content"
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

function input(overrides: Partial<TurnInput> = {}): TurnInput {
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
  let delivered = 0
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
          delivered += 1
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
    get delivered() {
      return delivered
    },
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
  it("passes one provider-validated staged file batch to the native prompt", async () => {
    const state = client()
    const stage = new OpenCodeContent().stage([
      {
        type: "file",
        dataUrl: "data:text/plain;base64,SGVsbG8=",
        filename: "brief.txt",
      },
    ])

    await new OpenCodeRunEngine(state.native).start(scope, input(), stage)

    expect(state.sessions.prompt).toHaveBeenCalledWith(
      scope.sessionId,
      expect.objectContaining({
        prompt: {
          text: "Hello OpenCode",
          files: [
            {
              uri: "data:text/plain;base64,SGVsbG8=",
              name: "brief.txt",
            },
          ],
        },
      })
    )
  })

  it("rejects a structurally similar foreign staged-file object before native prompt dispatch", async () => {
    const state = client()
    const foreign = {
      public: [],
      files: [{ uri: "data:text/plain;base64,SGVsbG8=", name: "brief.txt" }],
      appendTo: (value: string) => value,
      cleanup: async () => {},
    }

    await expect(
      new OpenCodeRunEngine(state.native).start(scope, input(), foreign)
    ).rejects.toThrow("attachment stage")
    expect(state.sessions.prompt).not.toHaveBeenCalled()
  })

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

  it("discovers and refreshes an authoritative pending interaction batch", async () => {
    const first = controlledStream()
    const second = controlledStream()
    const sources = [first.source, second.source]
    const order: string[] = []
    const interrupt = {
      id: "question-1",
      reason: "question",
      message: "Choose",
      responseSchema: { type: "string", enum: ["yes", "no"] },
    }
    const discover = vi
      .fn(async () => {
        order.push("interactions")
        return [interrupt]
      })
      .mockImplementationOnce(async () => {
        order.push("interactions")
        return [interrupt]
      })
      .mockImplementationOnce(async () => {
        order.push("interactions")
        return undefined
      })
    const state = client({
      get: vi.fn(async () => {
        order.push("ownership")
        return { data: { id: scope.sessionId, agent: scope.agentId } }
      }),
      history: vi.fn(async () => {
        order.push("history")
        return { data: [], hasMore: false }
      }),
      events: vi.fn(async () => {
        order.push("observation")
        return sources.shift()!
      }),
    })
    const engine = new OpenCodeRunEngine(state.native, {
      resume: {
        discover,
        validate: vi.fn(async () => undefined),
        dispatch: vi.fn(async () => undefined),
      },
    })

    const waiting = await engine.discover(scope, "recovered-question")

    expect(waiting?.state).toBe("waiting-for-input")
    expect(waiting?.interrupts).toEqual([interrupt])
    const waitingEvents = await collect(waiting!.handle)
    expect(waitingEvents).toEqual([
      {
        type: RunEventKind.RUN_STARTED,
        threadId: scope.threadId,
        runId: "recovered-question",
      },
      {
        type: RunEventKind.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "recovered-question",
        outcome: { type: "interrupt", interrupts: [interrupt] },
      },
    ])
    expect(
      waitingEvents.every((event) => RunEventSchema.safeParse(event).success)
    ).toBe(true)

    await expect(engine.discover(scope, "cleared-question")).resolves.toBe(
      undefined
    )
    expect(order).toEqual([
      "ownership",
      "history",
      "observation",
      "interactions",
      "ownership",
      "history",
      "observation",
      "interactions",
    ])
    expect(first.abort).toHaveBeenCalledOnce()
    expect(second.abort).toHaveBeenCalledOnce()
  })

  it("releases discovery observation when the interaction read fails", async () => {
    const failure = new Error("interaction authority unavailable")
    const state = client()
    const engine = new OpenCodeRunEngine(state.native, {
      resume: {
        discover: vi.fn(async () => Promise.reject(failure)),
        validate: vi.fn(async () => undefined),
        dispatch: vi.fn(async () => undefined),
      },
    })

    await expect(engine.discover(scope, "failed-discovery")).rejects.toBe(
      failure
    )
    expect(state.observation.abort).toHaveBeenCalledOnce()
  })

  it("repeats interaction discovery when a scoped event overlaps its read", async () => {
    const firstRead = deferred()
    const interrupt = {
      id: "question-current",
      reason: "question",
      message: "Current question",
      responseSchema: { type: "string" },
    }
    const discover = vi
      .fn(async () => [interrupt])
      .mockImplementationOnce(async () => {
        await firstRead.promise
        return [
          {
            id: "question-stale",
            reason: "question",
            message: "Stale question",
            responseSchema: { type: "string" },
          },
        ]
      })
    const state = client()
    const engine = new OpenCodeRunEngine(state.native, {
      resume: {
        discover,
        validate: vi.fn(async () => undefined),
        dispatch: vi.fn(async () => undefined),
      },
    })

    const discovered = engine.discover(scope, "recovered-current-question")
    await until(() => expect(discover).toHaveBeenCalledOnce())
    state.observation.publish(
      liveEvent(0, "session.next.prompt.admitted", {
        timestamp: 0,
        messageID: admission["run-1"],
        prompt: { text: "Hello OpenCode" },
        delivery: "queue",
      })
    )
    await until(() => expect(state.observation.delivered).toBe(1))
    firstRead.resolve()

    await expect(discovered).resolves.toMatchObject({
      state: "waiting-for-input",
      interrupts: [interrupt],
    })
    expect(discover).toHaveBeenCalledTimes(2)
    expect(state.observation.abort).toHaveBeenCalledOnce()
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
      RunEventKind.RUN_STARTED,
      RunEventKind.TEXT_MESSAGE_START,
      RunEventKind.TEXT_MESSAGE_CONTENT,
      RunEventKind.TEXT_MESSAGE_END,
      RunEventKind.RUN_FINISHED,
    ])
    for (const value of events)
      expect(RunEventSchema.safeParse(value).success).toBe(true)
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
      type: RunEventKind.RUN_FINISHED,
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
    expect(events.at(-1)).toMatchObject({ type: RunEventKind.RUN_FINISHED })
  })

  it.each([
    {
      name: "text",
      prefix: historyEvent(1, "session.next.text.started", {
        timestamp: 1,
        assistantMessageID: "assistant-open",
        textID: "text-open",
      }),
      suffix: [
        historyEvent(2, "session.next.text.ended", {
          timestamp: 2,
          assistantMessageID: "assistant-open",
          textID: "text-open",
          text: "continued text",
        }),
      ],
      expected: [
        RunEventKind.RUN_STARTED,
        RunEventKind.TEXT_MESSAGE_CONTENT,
        RunEventKind.TEXT_MESSAGE_END,
        RunEventKind.RUN_FINISHED,
      ],
    },
    {
      name: "reasoning",
      prefix: historyEvent(1, "session.next.reasoning.started", {
        timestamp: 1,
        assistantMessageID: "assistant-open",
        reasoningID: "reasoning-open",
      }),
      suffix: [
        historyEvent(2, "session.next.reasoning.ended", {
          timestamp: 2,
          assistantMessageID: "assistant-open",
          reasoningID: "reasoning-open",
          text: "continued reasoning",
        }),
      ],
      expected: [
        RunEventKind.RUN_STARTED,
        RunEventKind.REASONING_MESSAGE_CONTENT,
        RunEventKind.REASONING_MESSAGE_END,
        RunEventKind.RUN_FINISHED,
      ],
    },
    {
      name: "tool",
      prefix: historyEvent(1, "session.next.tool.input.started", {
        timestamp: 1,
        assistantMessageID: "assistant-open",
        callID: "call-open",
        name: "read",
      }),
      suffix: [
        historyEvent(2, "session.next.tool.input.ended", {
          timestamp: 2,
          assistantMessageID: "assistant-open",
          callID: "call-open",
          text: '{"path":"README.md"}',
        }),
        historyEvent(3, "session.next.tool.success", {
          timestamp: 3,
          assistantMessageID: "assistant-open",
          callID: "call-open",
          structured: {},
          content: [{ type: "text", text: "contents" }],
          provider: { executed: true },
        }),
      ],
      expected: [
        RunEventKind.RUN_STARTED,
        RunEventKind.TOOL_CALL_ARGS,
        RunEventKind.TOOL_CALL_END,
        RunEventKind.TOOL_CALL_RESULT,
        RunEventKind.RUN_FINISHED,
      ],
    },
  ])(
    "reconstructs the admitted $name lifecycle before emitting only a cursor suffix",
    async ({ prefix, suffix, expected }) => {
      const nextAdmissionSeq = suffix.at(-1)!.durable.seq + 1
      const all = [
        admitted(0, admission["run-recovered"]),
        prefix,
        ...suffix,
        admitted(nextAdmissionSeq, "newer-run"),
      ]
      const state = client({
        history: vi.fn(async (_id: string, options?: { after?: number }) => ({
          data: all.filter(
            (event) => event.durable.seq > (options?.after ?? -1)
          ),
          hasMore: false,
        })),
      })

      const handle = await new OpenCodeRunEngine(state.native).recover(scope, {
        threadId: scope.threadId,
        runId: "run-recovered",
        position: {
          epoch: `opencode:${scope.sessionId}`,
          lastSeen: 1,
        },
      })
      const events = await collect(handle)

      expect(events.map((event) => (event as { type: string }).type)).toEqual(
        expected
      )
      expect(state.sessions.events).toHaveBeenCalledWith(scope.sessionId, {
        after: "1",
      })
      expect(state.sessions.prompt).not.toHaveBeenCalled()
    }
  )

  it("re-emits one valid run error when recovery starts after a durable step failure", async () => {
    const failure = {
      ...historyEvent(1, "session.next.step.failed", {
        timestamp: 1,
        assistantMessageID: "assistant-failed",
        error: { type: "unknown", message: "native failure" },
      }),
      durable: { aggregateID: scope.sessionId, seq: 1, version: 2 },
    }
    const all = [
      admitted(0, admission["run-recovered"]),
      failure,
      admitted(2, "newer-run"),
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
      position: {
        epoch: `opencode:${scope.sessionId}`,
        lastSeen: 1,
      },
    })
    const events = await collect(handle)

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      RunEventKind.RUN_STARTED,
      RunEventKind.RUN_ERROR,
    ])
    expect(
      events.filter((event) => RunEventSchema.safeParse(event).success)
    ).toHaveLength(events.length)
    expect(state.sessions.prompt).not.toHaveBeenCalled()
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
    let running = true
    const state = client({
      wait: vi.fn(async () => wait.promise),
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockImplementation(async () => ({
          data: running ? { [scope.sessionId]: { type: "running" } } : {},
        })),
    })
    const handle = await new OpenCodeRunEngine(state.native).start(
      scope,
      input()
    )
    state.observation.fail()
    await until(() => expect(state.observation.abort).toHaveBeenCalled())

    const stopped = handle.stop()
    await until(() => expect(state.sessions.interrupt).toHaveBeenCalledOnce())
    running = false
    wait.resolve()

    await expect(stopped).resolves.toBe("idle")
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
    const events = await collect(handle)
    expect(events.at(-1)).toMatchObject({ type: RunEventKind.RUN_ERROR })
  })

  it("emits valid open-lifecycle closures before transport RUN_ERROR", async () => {
    const state = client({
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValue({
          data: { [scope.sessionId]: { type: "running" } },
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
    state.observation.publish(
      liveEvent(1, "session.next.reasoning.started", {
        timestamp: 1,
        assistantMessageID: "assistant-open",
        reasoningID: "reasoning-open",
      })
    )
    await until(() => expect(handle.recoveryPosition().lastSeen).toBe(1))
    state.observation.fail()

    expect(
      (await collect(handle)).map((event) => (event as { type: string }).type)
    ).toEqual([
      RunEventKind.RUN_STARTED,
      RunEventKind.REASONING_MESSAGE_START,
      RunEventKind.REASONING_MESSAGE_END,
      RunEventKind.RUN_ERROR,
    ])
  })

  it("returns stopping during an active-read outage and settles later without another interrupt", async () => {
    let running = false
    let activeUnavailable = false
    const state = client({
      active: vi.fn(async () => {
        if (activeUnavailable) throw new Error("active unavailable")
        return {
          data: running ? { [scope.sessionId]: { type: "running" } } : {},
        }
      }),
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
      wait: vi.fn(async () => new Promise<void>(() => {})),
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
    await until(() => expect(handle.recoveryPosition().lastSeen).toBe(0))
    state.observation.fail()
    await until(() => expect(state.observation.abort).toHaveBeenCalled())

    activeUnavailable = true
    const stopped = handle.stop()
    const immediate = await Promise.race([
      stopped,
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 100)
      ),
    ])

    activeUnavailable = false
    running = false
    const settled = await handle.stop()

    expect(immediate).toBe("stopping")
    await expect(stopped).resolves.toBe("stopping")
    expect(settled).toBe("idle")
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
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
      type: RunEventKind.RUN_FINISHED,
      result: { stopped: true },
    })
  })

  it("terminalizes an open stopped run before the coordinator admits another turn", async () => {
    const first = controlledStream()
    const second = controlledStream()
    const sources = [first.source, second.source]
    const durable: ReturnType<typeof historyEvent>[] = []
    let running = false
    let nextAdmissionSeq = 0
    const state = client({
      events: vi.fn(async () => sources.shift()!),
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
      history: vi.fn(async (_id: string, options?: { after?: number }) => ({
        data: durable.filter(
          (event) => event.durable.seq > (options?.after ?? -1)
        ),
        hasMore: false,
      })),
      prompt: vi.fn(
        async (_id: string, request: { id: string; prompt: unknown }) => {
          running = true
          return {
            data: {
              admittedSeq: nextAdmissionSeq++,
              id: request.id,
              sessionID: scope.sessionId,
              prompt: request.prompt,
              delivery: "queue",
              timeCreated: 1,
            },
          }
        }
      ),
      wait: vi.fn(async () => new Promise<void>(() => {})),
    })
    const engine = new OpenCodeRunEngine(state.native, { waitRetryMs: 1 })
    const started = vi.spyOn(engine, "start")
    const sessions = new SessionCoordinator({
      engine,
      maxActiveExecutions: 8,
      maxGuestActiveExecutions: 2,
      maxSubscriberEvents: 8,
      maxSubscriberBytes: 64 * 1024,
      maxReplayEvents: 32,
      maxReplayBytes: 256 * 1024,
    })
    const access = {
      subscriberId: "operator",
      controllerId: "operator",
      lane: "operator",
      canControl: true,
    } as const
    const subscription = await sessions.start(scope, input(), access)
    const firstHandle = await started.mock.results[0]!.value
    const collected = (async () => {
      const events: unknown[] = []
      for await (const value of subscription.events) events.push(value.event)
      return events
    })()
    const firstAdmission = historyEvent(0, "session.next.prompt.admitted", {
      timestamp: 0,
      messageID: admission["run-1"],
      prompt: { text: "Hello OpenCode" },
      delivery: "queue",
    })
    durable.push(firstAdmission)
    first.publish({ id: "0", event: "session", data: firstAdmission })

    await expect(sessions.stop(scope, "operator")).resolves.toBe("stopping")
    running = false
    await expect(sessions.stop(scope, "operator")).resolves.toBe("idle")
    const terminal = await Promise.race([
      Promise.all([collected, firstHandle.settled]),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 100)
      ),
    ])
    const next = await sessions.start(scope, input({ runId: "run-2" }), access)

    expect(terminal).not.toBe("timed-out")
    if (terminal === "timed-out") throw new Error("run did not settle")
    const [events] = terminal
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      RunEventKind.RUN_STARTED,
      RunEventKind.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({
      type: RunEventKind.RUN_FINISHED,
      result: { stopped: true },
    })
    expect(RunEventSchema.safeParse(events.at(-1)).success).toBe(true)
    expect(next.runId).toBe("run-2")
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
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
    expect(priorEvents.at(-1)).toMatchObject({ type: RunEventKind.RUN_ERROR })
  })

  it("settles a transport-failed Stop through the authoritative replacement recovery", async () => {
    const first = controlledStream()
    const second = controlledStream()
    const wait = deferred()
    let subscriptionCount = 0
    let running = false
    const state = client({
      events: vi.fn(async () => {
        subscriptionCount += 1
        return subscriptionCount === 1 ? first.source : second.source
      }),
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
      history: vi.fn(async (_id: string, options?: { after?: number }) => ({
        data:
          subscriptionCount > 1 && (options?.after ?? -1) < 0
            ? [admitted(0, admission["run-1"])]
            : [],
        hasMore: false,
      })),
      wait: vi.fn(async () => wait.promise),
    })
    const engine = new OpenCodeRunEngine(state.native, { waitRetryMs: 1 })
    const prior = await engine.start(scope, input())
    first.publish(
      liveEvent(0, "session.next.prompt.admitted", {
        timestamp: 0,
        messageID: admission["run-1"],
        prompt: { text: "Hello OpenCode" },
        delivery: "queue",
      })
    )
    await until(() => expect(prior.recoveryPosition().lastSeen).toBe(0))
    first.fail()
    await prior.settled

    const stopped = prior.stop()
    await until(() => expect(state.sessions.interrupt).toHaveBeenCalledOnce())
    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      runId: "run-1",
      position: {
        epoch: `opencode:${scope.sessionId}`,
        lastSeen: 0,
      },
    })
    const recoveredEventsPromise = collect(recovered)
    running = false
    wait.resolve()
    await recovered.settled
    const recoveredEvents = await recoveredEventsPromise

    await expect(stopped).resolves.toBe("stopping")
    await expect(recovered.stop()).resolves.toBe("idle")
    expect(
      recoveredEvents.filter(
        (event) => event.type === RunEventKind.RUN_FINISHED
      )
    ).toEqual([
      expect.objectContaining({
        type: RunEventKind.RUN_FINISHED,
        result: { stopped: true },
      }),
    ])
    expect(first.abort).toHaveBeenCalledOnce()
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
  })

  it("preserves a Stop acknowledged after its observation was replaced", async () => {
    const first = controlledStream()
    const second = controlledStream()
    const interruptAcknowledgement = deferred()
    const wait = deferred()
    let subscriptionCount = 0
    let running = false
    const state = client({
      events: vi.fn(async () => {
        subscriptionCount += 1
        return subscriptionCount === 1 ? first.source : second.source
      }),
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
      interrupt: vi.fn(async () => interruptAcknowledgement.promise),
      history: vi.fn(async (_id: string, options?: { after?: number }) => ({
        data:
          subscriptionCount > 1 && (options?.after ?? -1) < 0
            ? [admitted(0, admission["run-1"])]
            : [],
        hasMore: false,
      })),
      wait: vi.fn(async () => wait.promise),
    })
    const engine = new OpenCodeRunEngine(state.native, { waitRetryMs: 1 })
    const prior = await engine.start(scope, input())
    first.publish(
      liveEvent(0, "session.next.prompt.admitted", {
        timestamp: 0,
        messageID: admission["run-1"],
        prompt: { text: "Hello OpenCode" },
        delivery: "queue",
      })
    )
    await until(() => expect(prior.recoveryPosition().lastSeen).toBe(0))
    first.fail()
    await prior.settled

    const stopped = prior.stop()
    await until(() => expect(state.sessions.interrupt).toHaveBeenCalledOnce())
    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      runId: "run-1",
      position: {
        epoch: `opencode:${scope.sessionId}`,
        lastSeen: 0,
      },
    })
    const recoveredEventsPromise = collect(recovered)

    interruptAcknowledgement.resolve()
    await expect(stopped).resolves.toBe("stopping")
    running = false
    wait.resolve()
    await recovered.settled
    const recoveredEvents = await recoveredEventsPromise

    expect(
      recoveredEvents.filter(
        (event) => event.type === RunEventKind.RUN_FINISHED
      )
    ).toEqual([
      expect.objectContaining({
        type: RunEventKind.RUN_FINISHED,
        result: { stopped: true },
      }),
    ])
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
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
      type: RunEventKind.RUN_ERROR,
      code: "AOS_RESET_REQUIRED",
    })
  })

  it("preserves uncertain prompt and Stop mutations without retry", async () => {
    const promptUncertain = new OpenCodeMutationUncertainError()
    const promptCase = client({
      prompt: vi.fn(async () => Promise.reject(promptUncertain)),
    })
    const stage = new OpenCodeContent().stage([
      { type: "file", dataUrl: "data:text/plain;base64,SGVsbG8=" },
    ])
    await expect(
      new OpenCodeRunEngine(promptCase.native).start(scope, input(), stage)
    ).rejects.toBe(promptUncertain)
    expect(promptCase.sessions.prompt).toHaveBeenCalledOnce()
    expect(promptCase.sessions.prompt).toHaveBeenCalledWith(
      scope.sessionId,
      expect.objectContaining({
        prompt: expect.objectContaining({
          files: [{ uri: "data:text/plain;base64,SGVsbG8=" }],
        }),
      })
    )

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
