import { EventType, type RunAgentInput } from "@ag-ui/core"
import { OpenClawClientRequestError } from "./client"
import { describe, expect, it } from "vitest"

import { OpenClawRunEngine, type OpenClawRunRequestClient } from "./run"
import { OpenClawSessionSubscriptions } from "./subscriptions"

class ControlledNative implements OpenClawRunRequestClient {
  readonly calls: Array<{
    method: string
    params: Record<string, unknown>
    options?: Parameters<OpenClawRunRequestClient["request"]>[2]
  }> = []
  history: unknown = {
    messages: [],
    sessionInfo: { hasActiveRun: false, activeRunIds: [] },
  }
  abortResult: unknown = {
    ok: true,
    status: "aborted",
    abortedRunId: "run-a",
  }
  abortError?: unknown
  sendError?: unknown

  async request<T>(
    method: string,
    params: Record<string, unknown>,
    options?: Parameters<OpenClawRunRequestClient["request"]>[2]
  ): Promise<T> {
    this.calls.push({ method, params, options })
    if (method === "sessions.messages.subscribe")
      return { key: params.key } as T
    if (method === "sessions.messages.unsubscribe") return {} as T
    if (method === "chat.history") return structuredClone(this.history) as T
    if (method === "sessions.abort") {
      options?.onSent?.()
      if (this.abortError) throw this.abortError
      return structuredClone(this.abortResult) as T
    }
    if (method === "chat.send") {
      options?.onSent?.()
      if (this.sendError) throw this.sendError
      options?.onAccepted?.({
        status: "accepted",
        runId: params.idempotencyKey,
      })
      return new Promise<T>(() => {})
    }
    throw new Error(`Unexpected method ${method}`)
  }
}

const scope = {
  agentId: "research",
  sessionId: "agent:research:main",
  threadId: "thread-public",
}

function input(runId = "run-a"): RunAgentInput {
  return {
    threadId: scope.threadId,
    runId,
    state: {},
    messages: [{ id: "user-a", role: "user", content: "Investigate this" }],
    tools: [],
    context: [],
    forwardedProps: {},
  }
}

describe("OpenClaw run engine", () => {
  it("submits one exact Agent-bound native-idempotent text turn after authoritative idle", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })

    const handle = await engine.start(scope, input())
    const iterator = handle.events[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-a",
      },
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toMatchObject([
      {
        method: "chat.send",
        params: {
          sessionKey: "agent:research:main",
          agentId: "research",
          message: "Investigate this",
          idempotencyKey: "run-a",
        },
        options: { expectFinal: true },
      },
    ])
  })

  it("maps validated native reasoning, text, progress, usage, tools, and lifecycle in order", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({
      client: native,
      subscriptions,
      toolEvents: true,
    })
    const handle = await engine.start(scope, input())
    let outerSeq = 10
    let nativeSeq = 0
    const emit = (stream: string, data: Record<string, unknown>) => {
      subscriptions.accept(
        {
          type: "event",
          event: "agent",
          seq: outerSeq++,
          payload: {
            runId: "run-a",
            sessionKey: scope.sessionId,
            agentId: scope.agentId,
            seq: nativeSeq++,
            stream,
            ts: 1_000 + nativeSeq,
            data,
          },
        },
        subscriptions.generation
      )
    }

    emit("thinking", { text: "checking", delta: "checking" })
    emit("run_status", { phase: "preparing_context" })
    emit("assistant", { text: "Answer", delta: "Answer" })
    emit("tool", {
      phase: "start",
      name: "search",
      toolCallId: "tool-1",
      args: { query: "public" },
    })
    emit("tool", {
      phase: "update",
      name: "search",
      toolCallId: "tool-1",
      partialResult: { matches: 1 },
    })
    emit("tool", {
      phase: "result",
      name: "search",
      toolCallId: "tool-1",
      result: { matches: 2 },
      isError: false,
    })
    emit("usage", { outputTokens: 17 })
    emit("lifecycle", { phase: "end" })

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-a" },
      { type: EventType.REASONING_START, messageId: "run-a:reasoning" },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "run-a:reasoning",
        role: "reasoning",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "run-a:reasoning",
        delta: "checking",
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "run-a:progress",
        activityType: "OPENCLAW_PROGRESS",
        content: { phase: "preparing_context" },
        replace: true,
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "run-a:reasoning" },
      { type: EventType.REASONING_END, messageId: "run-a:reasoning" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "run-a:assistant",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "run-a:assistant",
        delta: "Answer",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "search",
        parentMessageId: "run-a:assistant",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"query":"public"}',
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "run-a:tool-progress:tool-1",
        activityType: "OPENCLAW_TOOL_PROGRESS",
        content: {
          phase: "update",
          toolCallId: "tool-1",
          name: "search",
          detail: { matches: 1 },
        },
        replace: true,
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "tool-1" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "run-a:tool:tool-1",
        toolCallId: "tool-1",
        content: '{"matches":2}',
        role: "tool",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "run-a:assistant" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-a",
        outcome: { type: "success" },
        usage: [{ outputTokens: 17 }],
      },
    ])
  })

  it("aborts only the exact run and remains stopping until native terminal evidence", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())
    const iterator = handle.events[Symbol.asyncIterator]()
    await iterator.next()

    await expect(handle.stop()).resolves.toBe("stopping")
    expect(
      native.calls.filter(({ method }) => method === "sessions.abort")
    ).toMatchObject([
      {
        method: "sessions.abort",
        params: {
          key: scope.sessionId,
          agentId: scope.agentId,
          runId: "run-a",
        },
      },
    ])

    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 12,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "aborted",
        },
      },
      subscriptions.generation
    )
    await expect(handle.settled).resolves.toBeUndefined()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: EventType.RUN_FINISHED, runId: "run-a" },
    })
    await expect(handle.stop()).resolves.toBe("idle")
  })

  it("does not retry an abort whose dispatch outcome is uncertain", async () => {
    const native = new ControlledNative()
    native.abortError = new OpenClawClientRequestError(
      "unavailable",
      true,
      false
    )
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).rejects.toMatchObject({
      name: "OpenClawRunPublicError",
      code: "AOS_STOP_UNCERTAIN",
    })
    expect(
      native.calls.filter(({ method }) => method === "sessions.abort")
    ).toHaveLength(1)
  })

  it("does not retry a turn whose native dispatch may have been accepted", async () => {
    const native = new ControlledNative()
    native.sendError = new OpenClawClientRequestError(
      "unavailable",
      true,
      false
    )
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })

    const handle = await engine.start(scope, input())
    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toMatchObject([
      { type: EventType.RUN_STARTED, runId: "run-a" },
      { type: EventType.RUN_ERROR, code: "AOS_SEND_UNCERTAIN" },
    ])
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)

    native.history = {
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-a"] },
      inFlightRun: { runId: "run-a", text: "Accepted remotely" },
    }
    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      runId: "run-a",
    })
    await expect(
      recovered.events[Symbol.asyncIterator]().next()
    ).resolves.toMatchObject({
      value: { type: EventType.RUN_STARTED, runId: "run-a" },
    })
    expect(
      native.calls.filter(
        ({ method }) => method === "sessions.messages.subscribe"
      )
    ).toHaveLength(1)
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
  })

  it("rejects foreign runs and reduces tool detail when tool events were not negotiated", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())
    const emit = (runId: string, seq: number, data: Record<string, unknown>) =>
      subscriptions.accept(
        {
          type: "event",
          event: "agent",
          seq,
          payload: {
            runId,
            sessionKey: scope.sessionId,
            agentId: scope.agentId,
            seq,
            stream: "tool",
            ts: 1_000 + seq,
            data,
          },
        },
        subscriptions.generation
      )
    emit("foreign-run", 0, {
      phase: "start",
      name: "secret-tool",
      toolCallId: "foreign-tool",
      args: { secret: "must-not-cross" },
    })
    emit("run-a", 0, {
      phase: "start",
      name: "search",
      toolCallId: "tool-1",
      args: { secret: "must-not-cross" },
    })
    emit("run-a", 1, {
      phase: "result",
      name: "search",
      toolCallId: "tool-1",
      result: { secret: "must-not-cross" },
      isError: false,
    })
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 20,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(JSON.stringify(events)).not.toContain("must-not-cross")
    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: "{}",
    })
    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "run-a:tool:tool-1",
      toolCallId: "tool-1",
      content: '{"status":"completed","isError":false}',
      role: "tool",
    })
    expect(JSON.stringify(events)).not.toContain("foreign-tool")
  })

  it("flushes validated final-only chat text before terminal lifecycle", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })
    const handle = await engine.start(scope, input())

    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 30,
        payload: {
          runId: "run-a",
          sessionKey: scope.sessionId,
          agentId: scope.agentId,
          seq: 0,
          state: "final",
          message: { content: [{ type: "text", text: "Final only" }] },
        },
      },
      subscriptions.generation
    )

    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toContainEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "run-a:assistant",
      delta: "Final only",
    })
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it("resubscribes and reconciles active-run identity without resending the prompt", async () => {
    const native = new ControlledNative()
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })
    const original = await engine.start(scope, input())
    native.history = {
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-a"] },
      inFlightRun: { runId: "run-a", text: "Recovered" },
    }

    const recovered = await engine.recover(scope, {
      threadId: scope.threadId,
      runId: "run-a",
      position: original.recoveryPosition(),
    })
    const iterator = recovered.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-a",
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "run-a:assistant",
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Recovered",
      },
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)

    native.history = {
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    await subscriptions.replaceGeneration("reconnect")
    await expect(recovered.settled).resolves.toBeUndefined()
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(1)
    expect(
      native.calls.filter(
        ({ method }) => method === "sessions.messages.subscribe"
      )
    ).toHaveLength(2)
  })

  it("recovers exact completed assistant text from authoritative history", async () => {
    const native = new ControlledNative()
    native.history = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Already completed" }],
          __openclaw: { runId: "run-a", id: "message-a", seq: 8 },
        },
      ],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }
    const subscriptions = new OpenClawSessionSubscriptions(native)
    const engine = new OpenClawRunEngine({ client: native, subscriptions })

    const handle = await engine.recover(scope, {
      threadId: scope.threadId,
      runId: "run-a",
    })
    const events: unknown[] = []
    for await (const event of handle.events) events.push(event)
    expect(events).toContainEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "run-a:assistant",
      delta: "Already completed",
    })
    expect(
      native.calls.filter(({ method }) => method === "chat.send")
    ).toHaveLength(0)
  })
})
