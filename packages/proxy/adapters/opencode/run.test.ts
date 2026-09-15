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

function event(
  id: number,
  type: string,
  properties: Record<string, unknown> = {}
): OpenCodeDurableEvent {
  return {
    id: String(id),
    event: "session",
    data: {
      type,
      properties: { sessionID: scope.sessionId, ...properties },
    },
  }
}

function stream(
  values: readonly OpenCodeDurableEvent[]
): OpenCodeSessionEvents {
  let aborted = false
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) {
        if (aborted) return
        yield value
      }
    },
    abort() {
      aborted = true
    },
  }
}

function controlledStream() {
  const values: OpenCodeDurableEvent[] = []
  const waiters: (() => void)[] = []
  let aborted = false
  const source: OpenCodeSessionEvents = {
    async *[Symbol.asyncIterator]() {
      while (!aborted) {
        if (values.length) {
          yield values.shift()!
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
    abort() {
      aborted = true
      for (const wake of waiters.splice(0)) wake()
    },
  }
  return {
    source,
    publish(value: OpenCodeDurableEvent) {
      values.push(value)
      waiters.shift()?.()
    },
  }
}

function client(overrides: Record<string, unknown> = {}) {
  const sessions = {
    get: vi.fn(async () => ({
      data: { id: scope.sessionId, agent: scope.agentId },
    })),
    active: vi.fn(async () => ({ data: {} })),
    prompt: vi.fn(
      async (_sessionId: string, request: { id: string; prompt: unknown }) => ({
        data: {
          admittedSeq: 4,
          id: request.id,
          sessionID: scope.sessionId,
          prompt: request.prompt,
          delivery: "queue",
          timeCreated: 1,
        },
      })
    ),
    interrupt: vi.fn(async () => undefined),
    history: vi.fn(async () => ({ data: [], hasMore: false })),
    events: vi.fn(async () =>
      stream([
        event(5, "session.next.text.ended", {
          assistantMessageID: "assistant-1",
          textID: "text-1",
          text: "Done",
          timestamp: 5,
        }),
        event(6, "session.idle"),
      ])
    ),
    ...overrides,
  }
  return {
    sessions,
    catalog: {},
    close: async () => undefined,
  } as unknown as OpenCodeClient
}

async function collect(handle: { events: AsyncIterable<unknown> }) {
  const events: unknown[] = []
  for await (const value of handle.events) events.push(value)
  return events
}

describe("OpenCodeRunEngine", () => {
  it("admits one authorized text turn with a stable native identity and observes only that Session", async () => {
    const native = client()
    const handle = await new OpenCodeRunEngine(native).start(scope, input())
    const events = await collect(handle)

    expect(native.sessions.prompt).toHaveBeenCalledOnce()
    expect(native.sessions.prompt).toHaveBeenCalledWith(scope.sessionId, {
      id: "aos_05d71f07f383373fe7777c8bcf8282cb6cd66f15ea7d45671d26279c7c5ef561",
      prompt: { text: "Hello OpenCode" },
      resume: true,
    })
    expect(native.sessions.events).toHaveBeenCalledWith(scope.sessionId, {
      after: "4",
    })
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

  it("rejects a wrong Agent owner before observation or prompt admission", async () => {
    const native = client({
      get: vi.fn(async () => ({
        data: { id: scope.sessionId, agent: "other-agent" },
      })),
    })

    await expect(
      new OpenCodeRunEngine(native).start(scope, input())
    ).rejects.toThrow("Session does not belong to this Agent")
    expect(native.sessions.events).not.toHaveBeenCalled()
    expect(native.sessions.prompt).not.toHaveBeenCalled()
  })

  it("preserves an uncertain prompt acknowledgement and never retries the mutation", async () => {
    const uncertain = new OpenCodeMutationUncertainError()
    const native = client({
      prompt: vi.fn(async () => Promise.reject(uncertain)),
    })

    await expect(
      new OpenCodeRunEngine(native).start(scope, input())
    ).rejects.toBe(uncertain)
    expect(native.sessions.prompt).toHaveBeenCalledOnce()
    expect(native.sessions.events).not.toHaveBeenCalled()
  })

  it("keeps Stop stopping until a native terminal event proves settlement", async () => {
    const observation = controlledStream()
    const native = client({
      events: vi.fn(async () => observation.source),
      active: vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({
          data: { [scope.sessionId]: { type: "running" } },
        }),
    })
    const handle = await new OpenCodeRunEngine(native).start(scope, input())

    await expect(handle.stop()).resolves.toBe("stopping")
    expect(native.sessions.interrupt).toHaveBeenCalledOnce()
    let settled = false
    void handle.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    observation.publish(event(5, "session.idle"))
    const events = await collect(handle)
    await expect(handle.settled).resolves.toBeUndefined()
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      result: { stopped: true },
    })
  })

  it("settles Stop immediately only when the authoritative active read is idle", async () => {
    const observation = controlledStream()
    const native = client({
      events: vi.fn(async () => observation.source),
      active: vi.fn(async () => ({ data: {} })),
    })
    const handle = await new OpenCodeRunEngine(native).start(scope, input())

    await expect(handle.stop()).resolves.toBe("idle")
    await expect(handle.settled).resolves.toBeUndefined()
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      result: { stopped: true },
    })
  })

  it("preserves an uncertain Stop acknowledgement without retrying or claiming idle", async () => {
    const observation = controlledStream()
    const uncertain = new OpenCodeMutationUncertainError()
    const native = client({
      events: vi.fn(async () => observation.source),
      interrupt: vi.fn(async () => Promise.reject(uncertain)),
    })
    const handle = await new OpenCodeRunEngine(native).start(scope, input())

    await expect(handle.stop()).rejects.toBe(uncertain)
    expect(native.sessions.interrupt).toHaveBeenCalledOnce()
    observation.publish(event(5, "session.idle"))
    const events = await collect(handle)
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(events.at(-1)).not.toHaveProperty("result.stopped")
  })

  it("recovers durable output and authoritative idle state without resending a prompt", async () => {
    const recovered = {
      id: "event-6",
      type: "session.next.text.ended",
      durable: { aggregateID: scope.sessionId, seq: 6, version: 1 },
      data: {
        sessionID: scope.sessionId,
        assistantMessageID: "assistant-recovered",
        textID: "text-recovered",
        text: "Recovered",
        timestamp: 6,
      },
    }
    const native = client({
      events: vi.fn(async () => stream([])),
      history: vi.fn(async () => ({ data: [recovered], hasMore: false })),
      active: vi.fn(async () => ({ data: {} })),
    })

    const handle = await new OpenCodeRunEngine(native).recover(scope, {
      threadId: scope.threadId,
      runId: "run-recovered",
      position: { epoch: `opencode:${scope.sessionId}`, lastSeen: 5 },
    })
    const events = await collect(handle)

    expect(native.sessions.events).toHaveBeenCalledWith(scope.sessionId, {
      after: "5",
    })
    expect(native.sessions.history).toHaveBeenCalledWith(scope.sessionId, {
      after: 5,
      limit: 100,
    })
    expect(native.sessions.prompt).not.toHaveBeenCalled()
    expect(events).toMatchObject([
      { type: EventType.RUN_STARTED, runId: "run-recovered" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-recovered" },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: "Recovered" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-recovered" },
      { type: EventType.RUN_FINISHED, runId: "run-recovered" },
    ])
  })

  it("aborts a newly opened recovery observation when authoritative history is malformed", async () => {
    const abort = vi.fn()
    const native = client({
      events: vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {},
        abort,
      })),
      history: vi.fn(async () => ({ data: "invalid", hasMore: false })),
    })

    await expect(
      new OpenCodeRunEngine(native).recover(scope, {
        threadId: scope.threadId,
        runId: "run-recovered",
        position: { epoch: `opencode:${scope.sessionId}`, lastSeen: 5 },
      })
    ).rejects.toMatchObject({ code: "invalid_response" })
    expect(abort).toHaveBeenCalledOnce()
    expect(native.sessions.prompt).not.toHaveBeenCalled()
  })

  it("uses a bound native resume operation without submitting the response as a prompt", async () => {
    const native = client({
      events: vi.fn(async () => stream([event(8, "session.idle")])),
    })
    const resume = vi.fn(async () => ({ admittedSeq: 7 }))
    const engine = new OpenCodeRunEngine(native, { resume })

    await collect(
      await engine.start(
        scope,
        input({
          runId: "run-resume",
          messages: [],
          resume: [
            { interruptId: "approval-1", status: "resolved", payload: "once" },
          ],
        })
      )
    )

    expect(resume).toHaveBeenCalledWith(scope, [
      { interruptId: "approval-1", status: "resolved", payload: "once" },
    ])
    expect(native.sessions.prompt).not.toHaveBeenCalled()
    expect(native.sessions.events).toHaveBeenCalledWith(scope.sessionId, {
      after: "7",
    })
  })
})
