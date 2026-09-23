import {
  PendingRequestKind,
  TurnEventKind,
  TurnEventSchema,
  type PromptTurnInput,
  type TurnInput,
} from "../../core/events"
import { describe, expect, it, vi } from "vitest"

import type {
  OpenCodeClient,
  OpenCodeDurableEvent,
  OpenCodeSessionEvents,
} from "./client"
import { ServerTurnConflictError } from "../../core/runtime"
import { SessionCoordinator } from "../../core/session-coordinator"
import { OpenCodeMutationUncertainError } from "./client"
import { OpenCodeContent } from "./content"
import { OpenCodeTurnEngine } from "./run"

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

function input(overrides: Partial<PromptTurnInput> = {}): TurnInput {
  return {
    turnId: "run-1",
    messageId: "user-1",
    prompt: "Hello OpenCode",
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

    await new OpenCodeTurnEngine(state.native).start(scope, input(), stage)

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
      new OpenCodeTurnEngine(state.native).start(scope, input(), foreign)
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
      new OpenCodeTurnEngine(state.native).start(scope, input())
    ).rejects.toThrow("Session does not belong to this Agent")
    expect(state.sessions.events).not.toHaveBeenCalled()
    expect(state.sessions.prompt).not.toHaveBeenCalled()
  })

  it("discovers and refreshes an authoritative pending interaction batch", async () => {
    const first = controlledStream()
    const second = controlledStream()
    const sources = [first.source, second.source]
    const order: string[] = []
    const request = {
      requestId: "question-1",
      kind: PendingRequestKind.Elicitation,
      message: "Choose",
      responseSchema: { type: "string", enum: ["yes", "no"] },
    }
    const discover = vi
      .fn(async () => {
        order.push("interactions")
        return [request]
      })
      .mockImplementationOnce(async () => {
        order.push("interactions")
        return [request]
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
    const engine = new OpenCodeTurnEngine(state.native, {
      replies: {
        discover,
        validate: vi.fn(async () => undefined),
        dispatch: vi.fn(async () => undefined),
      },
    })

    const waiting = await engine.discover(scope, "aos-recovered-1")

    expect(waiting?.state).toBe("waiting-for-input")
    expect(waiting?.requests).toEqual([request])
    // A restored wait was never streamed, so it names no position: a fabricated
    // one would force the next recovery to reset.
    expect(waiting?.handle.recoveryPosition()).toBeUndefined()
    const waitingEvents = await collect(waiting!.handle)
    expect(waitingEvents).toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnRequiresAction, requests: [request] },
    ])
    expect(
      waitingEvents.every((event) => TurnEventSchema.safeParse(event).success)
    ).toBe(true)

    await expect(engine.discover(scope, "aos-recovered-1")).resolves.toBe(
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
    const engine = new OpenCodeTurnEngine(state.native, {
      replies: {
        discover: vi.fn(async () => Promise.reject(failure)),
        validate: vi.fn(async () => undefined),
        dispatch: vi.fn(async () => undefined),
      },
    })

    await expect(engine.discover(scope, "aos-recovered-1")).rejects.toBe(
      failure
    )
    expect(state.observation.abort).toHaveBeenCalledOnce()
  })

  it("repeats interaction discovery when a scoped event overlaps its read", async () => {
    const firstRead = deferred()
    const request = {
      requestId: "question-current",
      kind: PendingRequestKind.Elicitation,
      message: "Current question",
      responseSchema: { type: "string" },
    }
    const discover = vi
      .fn(async () => [request])
      .mockImplementationOnce(async () => {
        await firstRead.promise
        return [
          {
            requestId: "question-stale",
            kind: PendingRequestKind.Elicitation,
            message: "Stale question",
            responseSchema: { type: "string" },
          },
        ]
      })
    const state = client()
    const engine = new OpenCodeTurnEngine(state.native, {
      replies: {
        discover,
        validate: vi.fn(async () => undefined),
        dispatch: vi.fn(async () => undefined),
      },
    })

    const discovered = engine.discover(scope, "aos-recovered-1")
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
      requests: [request],
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

    const handle = await new OpenCodeTurnEngine(state.native).start(
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
    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Done",
      },
      { kind: TurnEventKind.TurnEnded },
    ])
    for (const value of events)
      expect(TurnEventSchema.safeParse(value).success).toBe(true)
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
    const handle = await new OpenCodeTurnEngine(state.native, {
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
      kind: TurnEventKind.TurnEnded,
    })
    expect(state.sessions.wait).toHaveBeenCalledOnce()
  })

  it("refuses a new turn as a run conflict while the native Session is running", async () => {
    const state = client({
      active: vi.fn(async () => ({
        data: { [scope.sessionId]: { type: "running" } },
      })),
    })

    // The browser owns this answer: a Session OpenCode is still running is a
    // conflict the workspace resolves by reloading, not a provider failure.
    await expect(
      new OpenCodeTurnEngine(state.native).start(scope, input())
    ).rejects.toBeInstanceOf(ServerTurnConflictError)
    expect(state.sessions.prompt).not.toHaveBeenCalled()
  })

  it("validates bound replies before bypassing active conflict, subscribes before its void mutation, and invents no cursor", async () => {
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
    const engine = new OpenCodeTurnEngine(state.native, {
      replies: {
        validate: vi.fn(async () => {
          order.push("validate")
        }),
        dispatch: vi.fn(async () => {
          order.push("dispatch")
        }),
      },
    })

    const handle = await engine.start(scope, {
      turnId: "turn-replies",
      replies: [
        { requestId: "approval-1", status: "resolved", payload: "once" },
      ],
    })

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

    const handle = await new OpenCodeTurnEngine(state.native).recover(scope, {
      threadId: scope.threadId,
      turnId: "run-recovered",
    })
    const events = await collect(handle)

    expect(state.sessions.prompt).not.toHaveBeenCalled()
    expect(JSON.stringify(events)).toContain("Recovered")
    expect(JSON.stringify(events)).not.toContain("Other")
    expect(JSON.stringify(events)).not.toContain("Newer")
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
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
        TurnEventKind.TurnStarted,
        TurnEventKind.MessageChunk,
        TurnEventKind.TurnEnded,
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
        TurnEventKind.TurnStarted,
        TurnEventKind.ThoughtChunk,
        TurnEventKind.TurnEnded,
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
        TurnEventKind.TurnStarted,
        TurnEventKind.ToolCallInputChunk,
        TurnEventKind.ToolCallInputEnded,
        TurnEventKind.ToolCallFinished,
        TurnEventKind.TurnEnded,
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

      const handle = await new OpenCodeTurnEngine(state.native).recover(scope, {
        threadId: scope.threadId,
        turnId: "run-recovered",
        position: {
          epoch: `opencode:${scope.sessionId}`,
          lastSeen: 1,
        },
      })
      const events = await collect(handle)

      expect(events.map((event) => event.kind)).toEqual(expected)
      expect(state.sessions.events).toHaveBeenCalledWith(scope.sessionId, {
        after: "1",
      })
      expect(state.sessions.prompt).not.toHaveBeenCalled()
    }
  )

  it("re-emits one valid turn failure when recovery starts after a durable step failure", async () => {
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

    const handle = await new OpenCodeTurnEngine(state.native).recover(scope, {
      threadId: scope.threadId,
      turnId: "run-recovered",
      position: {
        epoch: `opencode:${scope.sessionId}`,
        lastSeen: 1,
      },
    })
    const events = await collect(handle)

    expect(events.map((event) => event.kind)).toEqual([
      TurnEventKind.TurnStarted,
      TurnEventKind.TurnFailed,
    ])
    expect(
      events.filter((event) => TurnEventSchema.safeParse(event).success)
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
      new OpenCodeTurnEngine(state.native).recover(scope, {
        threadId: scope.threadId,
        turnId: "run-recovered",
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

    const handle = await new OpenCodeTurnEngine(state.native).recover(scope, {
      threadId: scope.threadId,
      turnId: "run-recovered",
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
    const handle = await new OpenCodeTurnEngine(state.native).start(
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
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnFailed })
  })

  it("emits valid open-lifecycle closures before a transport turn failure", async () => {
    const state = client({
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValue({
          data: { [scope.sessionId]: { type: "running" } },
        }),
      wait: vi.fn(async () => new Promise<void>(() => {})),
    })
    const handle = await new OpenCodeTurnEngine(state.native).start(
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
      liveEvent(1, "session.next.tool.input.started", {
        timestamp: 1,
        assistantMessageID: "assistant-open",
        callID: "call-open",
        name: "read",
      })
    )
    await until(() => expect(handle.recoveryPosition().lastSeen).toBe(1))
    state.observation.fail()

    expect((await collect(handle)).map((event) => event.kind)).toEqual([
      TurnEventKind.TurnStarted,
      TurnEventKind.ToolCallStarted,
      TurnEventKind.ToolCallInputEnded,
      TurnEventKind.TurnFailed,
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
    const handle = await new OpenCodeTurnEngine(state.native, {
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
    const handle = await new OpenCodeTurnEngine(state.native).start(
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
    expect((await collect(handle)).at(-1)).toEqual({
      kind: TurnEventKind.TurnEnded,
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
    const engine = new OpenCodeTurnEngine(state.native, { waitRetryMs: 1 })
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
    const next = await sessions.start(scope, input({ turnId: "run-2" }), access)

    expect(terminal).not.toBe("timed-out")
    if (terminal === "timed-out") throw new Error("run did not settle")
    const [events] = terminal
    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnEnded },
    ])
    expect(next.turnId).toBe("run-2")
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
    const engine = new OpenCodeTurnEngine(state.native, { maxQueueEvents: 2 })
    const prior = await engine.start(scope, input())
    await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-recovered",
    })

    expect(first.abort).toHaveBeenCalledOnce()
    const priorEvents = await collect(prior)
    expect(priorEvents).toHaveLength(2)
    expect(priorEvents.at(-1)).toMatchObject({ kind: TurnEventKind.TurnFailed })
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
    const engine = new OpenCodeTurnEngine(state.native, { waitRetryMs: 1 })
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
      turnId: "run-1",
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
      recoveredEvents.filter((event) => event.kind === TurnEventKind.TurnEnded)
    ).toEqual([{ kind: TurnEventKind.TurnEnded }])
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
    const engine = new OpenCodeTurnEngine(state.native, { waitRetryMs: 1 })
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
      turnId: "run-1",
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
      recoveredEvents.filter((event) => event.kind === TurnEventKind.TurnEnded)
    ).toEqual([{ kind: TurnEventKind.TurnEnded }])
    expect(state.sessions.interrupt).toHaveBeenCalledOnce()
  })

  it("resets a segment instead of growing an unconsumed turn-event queue", async () => {
    const state = client({
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValue({
          data: { [scope.sessionId]: { type: "running" } },
        }),
      wait: vi.fn(async () => new Promise<void>(() => {})),
    })
    const handle = await new OpenCodeTurnEngine(state.native, {
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
    // Nothing reads the queue while one native call projects its start and input.
    state.observation.publish(
      liveEvent(1, "session.next.tool.called", {
        timestamp: 1,
        assistantMessageID: "assistant-overflow",
        callID: "call-overflow",
        tool: "read",
        input: { path: "README.md" },
        provider: { executed: true },
      })
    )
    await until(() => expect(handle.recoveryPosition().lastSeen).toBe(1))

    const events = await collect(handle)
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      kind: TurnEventKind.TurnFailed,
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
      new OpenCodeTurnEngine(promptCase.native).start(scope, input(), stage)
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
    const handle = await new OpenCodeTurnEngine(stopCase.native).start(
      scope,
      input()
    )
    await expect(handle.stop()).rejects.toBe(stopUncertain)
    expect(stopCase.sessions.interrupt).toHaveBeenCalledOnce()
  })
})

function live(event: ReturnType<typeof historyEvent>): OpenCodeDurableEvent {
  return { id: String(event.durable.seq), event: "session", data: event }
}

function watcher() {
  return { onTurn: vi.fn(), onError: vi.fn() }
}

/** A native log the test appends to, served from any requested cursor. */
function nativeLog(events: ReturnType<typeof historyEvent>[] = []) {
  return {
    events,
    history: vi.fn(async (_id: string, options?: { after?: number }) => ({
      data: events.filter(
        (event) => event.durable.seq > (options?.after ?? -1)
      ),
      hasMore: false,
    })),
  }
}

describe("OpenCodeRunEngine foreign turns", () => {
  it("stays silent for its own start, including the submit window and a resubscribe during it", async () => {
    const log = nativeLog()
    const watchStreams = [controlledStream(), controlledStream()]
    const run = controlledStream()
    const streams = [
      watchStreams[0]!.source,
      run.source,
      watchStreams[1]!.source,
    ]
    let running = false
    const state = client({
      history: log.history,
      events: vi.fn(async () => streams.shift()!),
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
      wait: vi.fn(async () => new Promise<void>(() => {})),
    })
    const engine = new OpenCodeTurnEngine(state.native, { waitRetryMs: 1 })
    const observer = watcher()
    const stop = engine.watch(scope, observer)
    await until(() => expect(state.sessions.events).toHaveBeenCalledOnce())
    state.sessions.prompt = vi.fn(
      async (_id: string, request: { id: string; prompt: unknown }) => {
        // OpenCode announces the admission before it acknowledges the submit.
        watchStreams[0]!.publish(live(admitted(0, request.id)))
        await until(() => expect(watchStreams[0]!.delivered).toBe(1))
        log.events.push(admitted(0, request.id))
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

    const handle = await engine.start(scope, input())
    watchStreams[0]!.fail()
    await until(() => expect(state.sessions.events).toHaveBeenCalledTimes(3))
    // The resubscribed watch reads its stream only after its running check.
    watchStreams[1]!.publish(live(textEnded(1, "Working")))
    await until(() => expect(watchStreams[1]!.delivered).toBe(1))

    expect(observer.onError).toHaveBeenCalledOnce()
    expect(observer.onTurn).not.toHaveBeenCalled()
    stop()
    running = false
    await handle.stop()
  })

  it("announces a foreign start once however often it is delivered", async () => {
    const state = client()
    const observer = watcher()
    const stop = new OpenCodeTurnEngine(state.native).watch(scope, observer)
    await until(() => expect(state.sessions.events).toHaveBeenCalledOnce())

    state.observation.publish(live(admitted(0, "msg-tui")))
    state.observation.publish(live(admitted(0, "msg-tui")))
    state.observation.publish(live(textEnded(1, "From the TUI")))
    await until(() => expect(state.observation.delivered).toBe(3))

    expect(observer.onTurn).toHaveBeenCalledOnce()
    expect(observer.onError).not.toHaveBeenCalled()
    stop()
  })

  it("announces once a foreign turn already running at setup", async () => {
    const log = nativeLog([admitted(0, "msg-tui"), textEnded(1, "Working")])
    const state = client({
      history: log.history,
      active: vi.fn(async () => ({
        data: { [scope.sessionId]: { type: "running" } },
      })),
    })
    const observer = watcher()
    const stop = new OpenCodeTurnEngine(state.native).watch(scope, observer)

    await until(() => expect(observer.onTurn).toHaveBeenCalledOnce())
    expect(state.sessions.events).toHaveBeenCalledWith(
      scope.sessionId,
      expect.objectContaining({ after: "1" })
    )
    state.observation.publish(live(textEnded(2, "Still working")))
    await until(() => expect(state.observation.delivered).toBe(1))
    expect(observer.onTurn).toHaveBeenCalledOnce()
    stop()
  })

  it("reconnects after a stream failure and announces a foreign turn found running", async () => {
    const log = nativeLog()
    const first = controlledStream()
    const second = controlledStream()
    const streams = [first.source, second.source]
    let running = false
    const state = client({
      history: log.history,
      events: vi.fn(async () => streams.shift()!),
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
    })
    const observer = watcher()
    const stop = new OpenCodeTurnEngine(state.native, {
      waitRetryMs: 1,
    }).watch(scope, observer)
    await until(() => expect(state.sessions.events).toHaveBeenCalledOnce())

    // The foreign turn starts while the stream is down.
    log.events.push(admitted(0, "msg-tui"))
    running = true
    first.fail()

    await until(() => expect(observer.onTurn).toHaveBeenCalledOnce())
    expect(observer.onError).toHaveBeenCalledOnce()
    expect(state.sessions.events).toHaveBeenCalledTimes(2)
    stop()
  })

  it("stops once, ending its stream and every retry", async () => {
    const state = client()
    const observer = watcher()
    const stop = new OpenCodeTurnEngine(state.native, {
      waitRetryMs: 20,
    }).watch(scope, observer)
    await until(() => expect(state.sessions.events).toHaveBeenCalledOnce())

    state.observation.fail()
    await until(() => expect(observer.onError).toHaveBeenCalledOnce())
    stop()
    stop()
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(state.sessions.events).toHaveBeenCalledOnce()
    expect(observer.onError).toHaveBeenCalledOnce()
    expect(observer.onTurn).not.toHaveBeenCalled()
  })

  it("adopts a running foreign turn from its first event, and recovers the same admission later", async () => {
    const log = nativeLog([
      admitted(0, "msg-tui"),
      textEnded(1, "From the TUI"),
    ])
    let running = true
    const state = client({
      history: log.history,
      events: vi.fn(async () => controlledStream().source),
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
    })
    const engine = new OpenCodeTurnEngine(state.native, { waitRetryMs: 1 })

    const discovered = await engine.discover(scope, "aos-recovered-1")
    running = false

    expect(discovered).toMatchObject({ state: "running", fromStart: true })
    const events = await collect(discovered!.handle)
    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "From the TUI",
      },
      { kind: TurnEventKind.TurnEnded },
    ])

    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "aos-recovered-1",
    })
    expect(JSON.stringify(await collect(recovered))).toContain("From the TUI")
    expect(state.sessions.prompt).not.toHaveBeenCalled()
  })

  it("never discovers its own running turn", async () => {
    const log = nativeLog()
    let running = false
    const state = client({
      history: log.history,
      active: vi.fn(async () => ({
        data: running ? { [scope.sessionId]: { type: "running" } } : {},
      })),
      prompt: vi.fn(
        async (_id: string, request: { id: string; prompt: unknown }) => {
          log.events.push(admitted(0, request.id))
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
    const engine = new OpenCodeTurnEngine(state.native)
    const handle = await engine.start(scope, input())

    await expect(
      engine.discover(scope, "aos-recovered-1")
    ).resolves.toBeUndefined()
    running = false
    await handle.stop()
  })
})
