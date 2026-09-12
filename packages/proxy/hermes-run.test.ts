import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, it } from "vitest"

import { HermesRunEngine, type HermesRunNative } from "./hermes-run"

const scope = {
  agentId: "research",
  sessionId: "stored-session",
  threadId: "hermes:research:stored-session",
}

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: scope.threadId,
    runId: "run-1",
    state: {},
    messages: [{ id: "user-1", role: "user", content: "Hello Hermes" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  }
}

function native(overrides: Partial<HermesRunNative> = {}): HermesRunNative {
  return {
    resume: async () => ({ liveSessionId: "live-secret" }),
    observe: async () => () => undefined,
    recover: async () => ({ epoch: "epoch-1", lastSeen: 0, events: [] }),
    submit: async () => ({ acknowledgement: "accepted" }),
    interrupt: async () => undefined,
    status: async () => "idle",
    ...overrides,
  }
}

async function collect(handle: { events: AsyncIterable<unknown> }) {
  const events: unknown[] = []
  for await (const event of handle.events) events.push(event)
  return events
}

describe("HermesRunEngine", () => {
  it("streams one authorized user turn as standard AG-UI lifecycle and text events", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "native-message-secret" },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 2,
            payload: { text: "Hi" },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const handle = await engine.start(scope, input())

    const events = await collect(handle)
    for (const event of events)
      expect(EventSchemas.safeParse(event).success).toBe(true)
    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "native-message-secret",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "native-message-secret",
        delta: "Hi",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "native-message-secret",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("rejects browser-owned state instead of forwarding it to Hermes", async () => {
    const engine = new HermesRunEngine(native())

    await expect(
      engine.start(scope, input({ state: { hiddenInstruction: "trust me" } }))
    ).rejects.toThrow("browser state")
    await expect(
      engine.start(scope, input({ state: "hidden instruction" }))
    ).rejects.toThrow("browser state")
  })

  it("rejects browser-supplied tools and context", async () => {
    const engine = new HermesRunEngine(native())
    const tool = {
      name: "unsafe",
      description: "browser-selected tool",
      parameters: { type: "object", properties: {} },
    }

    await expect(engine.start(scope, input({ tools: [tool] }))).rejects.toThrow(
      "browser tools"
    )
    await expect(
      engine.start(
        scope,
        input({ context: [{ description: "role", value: "admin" }] })
      )
    ).rejects.toThrow("browser context")
  })

  it("rejects forwarded properties and interrupt resumes on a new turn", async () => {
    const engine = new HermesRunEngine(native())

    await expect(
      engine.start(scope, input({ forwardedProps: { provider: "hermes" } }))
    ).rejects.toThrow("forwarded properties")
    await expect(
      engine.start(scope, input({ forwardedProps: "native override" }))
    ).rejects.toThrow("forwarded properties")
    await expect(
      engine.start(
        scope,
        input({
          resume: [
            {
              interruptId: "approval-1",
              status: "resolved",
              payload: { choice: "always" },
            },
          ],
        })
      )
    ).rejects.toThrow("interrupt response")
  })

  it("rejects non-standard top-level run fields instead of accepting provider payloads", async () => {
    const engine = new HermesRunEngine(native())

    await expect(
      engine.start(scope, { ...input(), native: { method: "prompt.submit" } })
    ).rejects.toThrow("unsupported run fields")
  })

  it("terminalizes an uncertain acknowledgement without retrying or releasing admission", async () => {
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        submit: async () => {
          submissions += 1
          return { acknowledgement: "uncertain" }
        },
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes may have accepted this turn; reconcile before sending again.",
        code: "AOS_SEND_UNCERTAIN",
      },
    ])
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).rejects.toThrow("already active")
    expect(submissions).toBe(1)
  })

  it("normalizes reasoning and complete tool calls as standard AG-UI events", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-42" }],
            [2, "reasoning.delta", { text: "Consider" }],
            [
              3,
              "tool.start",
              {
                tool_id: "call-7",
                name: "delegate_task",
                args: { goal: "Inspect" },
              },
            ],
            [
              4,
              "tool.complete",
              {
                tool_id: "call-7",
                name: "delegate_task",
                result: { ok: true },
              },
            ],
            [5, "message.delta", { text: "Done" }],
            [6, "message.complete", {}],
          ] as const)
            publish?.({
              type,
              session_id: "live-secret",
              seq,
              payload,
            })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
      },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "message-42:reasoning",
        role: "reasoning",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "message-42:reasoning",
        delta: "Consider",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-7",
        toolCallName: "delegate_subagent",
        parentMessageId: "message-42",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-7",
        delta: '{"goal":"Inspect","description":"Inspect"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-7" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "message-42:tool:call-7",
        toolCallId: "call-7",
        content: '{"ok":true}',
        role: "tool",
      },
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId: "message-42:reasoning",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-42",
        delta: "Done",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("keeps Stop pending until Hermes authoritatively reports idle", async () => {
    let interrupted = 0
    const engine = new HermesRunEngine(
      native({
        interrupt: async () => {
          interrupted += 1
        },
        status: async () => "idle",
      })
    )
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("idle")
    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        result: { stopped: true },
        outcome: { type: "success" },
      },
    ])
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).resolves.toBeDefined()
    expect(interrupted).toBe(1)
  })

  it("settles a stopping run only when a later native idle event arrives", async () => {
    let publish: ((event: unknown) => void) | undefined
    let interrupted = false
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        interrupt: async () => {
          interrupted = true
        },
        status: async () => (interrupted ? "running" : "idle"),
      })
    )
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("stopping")
    publish?.({
      type: "session.info",
      session_id: "live-secret",
      seq: 1,
      payload: { running: false },
    })

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        result: { stopped: true },
        outcome: { type: "success" },
      },
    ])
  })

  it("terminalizes native failures without disclosing provider error bodies", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          publish?.({
            type: "error",
            session_id: "live-secret",
            seq: 2,
            payload: {
              message: "token abc123 failed at /private/provider/path",
            },
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      {
        type: EventType.RUN_ERROR,
        message: "Hermes could not complete this run.",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("requires authoritative reconciliation when the native baseline is truncated", async () => {
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        recover: async () => ({
          epoch: "epoch-1",
          lastSeen: 24,
          truncated: true,
          events: [],
        }),
        submit: async () => {
          submissions += 1
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes history must be reconciled before this run can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
    expect(submissions).toBe(0)
  })

  it("applies validated baseline recovery before buffered post-submit events", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        recover: async () => ({
          epoch: "epoch-1",
          lastSeen: 2,
          events: [
            {
              type: "message.start",
              session_id: "live-secret",
              seq: 1,
              payload: { message_id: "message-42" },
            },
            {
              type: "message.delta",
              session_id: "live-secret",
              seq: 2,
              payload: { text: "Recovered " },
            },
          ],
        }),
        submit: async () => {
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 3,
            payload: { text: "live" },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 4,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-42",
        delta: "Recovered ",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-42",
        delta: "live",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("requires reconciliation when baseline recovery ordering is ambiguous", async () => {
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        recover: async () => ({
          epoch: "epoch-1",
          lastSeen: 2,
          events: [
            {
              type: "message.delta",
              session_id: "live-secret",
              seq: 2,
              payload: { text: "later" },
            },
            {
              type: "message.delta",
              session_id: "live-secret",
              seq: 1,
              payload: { text: "earlier" },
            },
          ],
        }),
        submit: async () => {
          submissions += 1
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events.at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message:
        "Hermes history must be reconciled before this run can continue.",
      code: "AOS_RESET_REQUIRED",
    })
    expect(submissions).toBe(0)
  })

  it("replays missed events from the same Hermes epoch before buffered live events", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        recover: async (_liveSessionId, lastSeen) => {
          expect(lastSeen).toBe(10)
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 13,
            payload: {},
          })
          return {
            epoch: "epoch-1",
            lastSeen: 12,
            events: [
              {
                type: "message.start",
                session_id: "live-secret",
                seq: 11,
                payload: { message_id: "message-42" },
              },
              {
                type: "message.delta",
                session_id: "live-secret",
                seq: 12,
                payload: { text: "Recovered" },
              },
            ],
          }
        },
      })
    )

    const handle = await engine.reconnect(scope, {
      threadId: scope.threadId,
      runId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 10 },
    })

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-42",
        delta: "Recovered",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("drops oversized native stream deltas at the provider boundary", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 2,
            payload: { text: "x".repeat(1_048_577) },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("rejects an oversized user turn before opening a native Session", async () => {
    const engine = new HermesRunEngine(native())

    await expect(
      engine.start(
        scope,
        input({
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "x".repeat(1_048_577),
            },
          ],
        })
      )
    ).rejects.toThrow("user turn is too large")
  })

  it("admits at most one concurrent run for an Agent and Session scope", async () => {
    let releaseResume: (() => void) | undefined
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve
    })
    const engine = new HermesRunEngine(
      native({
        resume: async () => {
          await resumeGate
          return { liveSessionId: "live-secret" }
        },
      })
    )

    const first = engine.start(scope, input())
    const second = engine.start(scope, input({ runId: "run-2" }))
    releaseResume?.()

    await expect(first).resolves.toBeDefined()
    await expect(second).rejects.toThrow("already active")
  })

  it("releases admission when native setup fails before the run is attached", async () => {
    let attempts = 0
    const engine = new HermesRunEngine(
      native({
        resume: async () => {
          attempts += 1
          if (attempts === 1) throw new Error("temporary outage")
          return { liveSessionId: "live-secret" }
        },
      })
    )

    await expect(engine.start(scope, input())).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("classifies a lost submit response as uncertain without exposing or retrying it", async () => {
    let attempts = 0
    const engine = new HermesRunEngine(
      native({
        submit: async () => {
          attempts += 1
          throw new Error("native socket closed after writing bearer secret")
        },
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes may have accepted this turn; reconcile before sending again.",
        code: "AOS_SEND_UNCERTAIN",
      },
    ])
    expect(attempts).toBe(1)
  })

  it("reports a native connection interruption without stopping the Hermes run", async () => {
    let disconnected: ((error?: Error) => void) | undefined
    let interrupts = 0
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, _listener, onDisconnected) => {
          disconnected = onDisconnected
          return () => undefined
        },
        interrupt: async () => {
          interrupts += 1
        },
      })
    )
    const handle = await engine.start(scope, input())

    disconnected?.(new Error("upstream leaked bearer secret"))

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "The Hermes connection was interrupted; reconnect to reconcile this run.",
        code: "AOS_CONNECTION_INTERRUPTED",
      },
    ])
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).rejects.toThrow("already active")
    expect(interrupts).toBe(0)
  })

  it("exposes only the server-side epoch and sequence needed to seal a reconnect cursor", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        recover: async () => ({
          epoch: "epoch-7",
          lastSeen: 40,
          events: [],
        }),
      })
    )
    const handle = await engine.start(scope, input())
    publish?.({
      type: "message.start",
      session_id: "live-secret",
      seq: 41,
      payload: { message_id: "message-42" },
    })

    expect(handle.recoveryPosition()).toEqual({
      epoch: "epoch-7",
      lastSeen: 41,
    })
  })

  it("reattaches an interrupted active run and replays without resubmitting the prompt", async () => {
    let disconnected: ((error?: Error) => void) | undefined
    let submissions = 0
    let recoveries = 0
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, _listener, onDisconnected) => {
          disconnected = onDisconnected
          return () => undefined
        },
        recover: async (_liveSessionId, lastSeen) => {
          recoveries += 1
          if (recoveries === 1)
            return { epoch: "epoch-1", lastSeen: 0, events: [] }
          expect(lastSeen).toBe(0)
          return {
            epoch: "epoch-1",
            lastSeen: 3,
            events: [
              {
                type: "message.start",
                session_id: "live-secret",
                seq: 1,
                payload: { message_id: "message-42" },
              },
              {
                type: "message.delta",
                session_id: "live-secret",
                seq: 2,
                payload: { text: "Recovered" },
              },
              {
                type: "message.complete",
                session_id: "live-secret",
                seq: 3,
                payload: {},
              },
            ],
          }
        },
        submit: async () => {
          submissions += 1
          return { acknowledgement: "accepted" }
        },
      })
    )
    const first = await engine.start(scope, input())
    const position = first.recoveryPosition()
    disconnected?.()

    const resumed = await engine.reconnect(scope, {
      threadId: scope.threadId,
      runId: "run-1",
      position,
    })

    await expect(collect(resumed)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-42",
        delta: "Recovered",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
    expect(submissions).toBe(1)
  })

  it("detaches browser transport without interrupting the native run", async () => {
    let interrupts = 0
    const engine = new HermesRunEngine(
      native({
        interrupt: async () => {
          interrupts += 1
        },
      })
    )
    const handle = await engine.start(scope, input())

    handle.disconnect()

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
    ])
    await expect(
      engine.reconnect(scope, {
        threadId: scope.threadId,
        runId: "run-1",
        position: handle.recoveryPosition(),
      })
    ).resolves.toBeDefined()
    expect(interrupts).toBe(0)
  })

  it("completes a known tool when Hermes omits its repeated name", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-42" }],
            [
              2,
              "tool.start",
              {
                tool_id: "call-7",
                name: "read_file",
                args: { path: "report.txt" },
              },
            ],
            [3, "tool.complete", { tool_id: "call-7", result: "contents" }],
            [4, "message.complete", {}],
          ] as const)
            publish?.({ type, session_id: "live-secret", seq, payload })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "message-42:tool:call-7",
      toolCallId: "call-7",
      content: "contents",
      role: "tool",
    })
  })

  it("projects bounded useful tool data without provider paths, URLs, tokens, or metadata", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-42" }],
            [
              2,
              "tool.complete",
              {
                tool_id: "call-7",
                name: "search",
                args: {
                  query: "status",
                  path: "/srv/private/workspace",
                  apiToken: "secret-token",
                  native_metadata: { live_session_id: "live-secret" },
                },
                result: {
                  status: "ok",
                  sourceUrl: "https://provider.invalid/private",
                  filesystem_path: "/srv/private/result.txt",
                  access_token: "bearer-secret",
                  summary:
                    "See https://provider.invalid and /srv/private/result.txt",
                },
              },
            ],
            [3, "message.complete", {}],
          ] as const)
            publish?.({ type, session_id: "live-secret", seq, payload })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-7",
      delta: '{"query":"status","filename":"workspace"}',
    })
    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "message-42:tool:call-7",
      toolCallId: "call-7",
      content:
        '{"status":"ok","summary":"See [redacted-url] and [redacted-path]"}',
      role: "tool",
    })
    expect(JSON.stringify(events)).not.toContain("live-secret")
    expect(JSON.stringify(events)).not.toContain("bearer-secret")
    expect(JSON.stringify(events)).not.toContain("provider.invalid")
    expect(JSON.stringify(events)).not.toContain("/srv/private")
  })

  it("bounds multibyte and deeply nested tool output", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          publish?.({
            type: "tool.complete",
            session_id: "live-secret",
            seq: 2,
            payload: {
              tool_id: "call-7",
              name: "search",
              args: { query: "🙂".repeat(10_000) },
              result: {
                results: [
                  { a: { b: { c: { d: { e: { f: { g: "hidden" } } } } } } },
                ],
              },
            },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const args = events.find((event) => event.type === EventType.TOOL_CALL_ARGS)
    const result = events.find(
      (event) => event.type === EventType.TOOL_CALL_RESULT
    )

    expect(args?.type).toBe(EventType.TOOL_CALL_ARGS)
    if (args?.type !== EventType.TOOL_CALL_ARGS) throw new Error("missing args")
    expect(new TextEncoder().encode(args.delta).byteLength).toBeLessThanOrEqual(
      16_410
    )
    expect(result).toMatchObject({
      content: expect.stringContaining("[truncated]"),
    })
  })

  it("treats a failed message completion as a safe run error", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 1,
            payload: { status: "error", error: "secret native body" },
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message: "Hermes could not complete this run.",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("rejects unstaged multimodal content instead of silently dropping it", async () => {
    const engine = new HermesRunEngine(native())

    await expect(
      engine.start(
        scope,
        input({
          messages: [
            {
              id: "user-1",
              role: "user",
              content: [
                { type: "text", text: "Look" },
                {
                  type: "image",
                  source: {
                    type: "data",
                    mimeType: "image/png",
                    value: "aGVsbG8=",
                  },
                },
              ],
            },
          ],
        })
      )
    ).rejects.toThrow("multimodal content must be staged")
  })

  it("does not submit when Hermes authoritatively reports the Session busy", async () => {
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        status: async () => "running",
        submit: async () => {
          submissions += 1
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message: "Hermes is already running this Session.",
        code: "AOS_SESSION_BUSY",
      },
    ])
    expect(submissions).toBe(0)
  })

  it("classifies a changed Hermes replay epoch as reset-required", async () => {
    const engine = new HermesRunEngine(
      native({
        recover: async () => ({
          epoch: "epoch-2",
          lastSeen: 11,
          events: [],
        }),
      })
    )

    const handle = await engine.reconnect(scope, {
      threadId: scope.threadId,
      runId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 10 },
    })

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes history must be reconciled before this run can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
  })

  it("ignores malformed, cross-Session, and duplicate native events", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "other-live-session",
            seq: 1,
            payload: { message_id: "wrong" },
          })
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: "2",
            payload: { message_id: "invalid-sequence" },
          })
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 3,
            payload: { message_id: "message-42" },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 3,
            payload: { text: "duplicate" },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 4,
            payload: { text: { native: "payload" } },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 5,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("unwraps Hermes tool-search bridge calls into the selected tool", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-42" }],
            [
              2,
              "tool.complete",
              {
                tool_id: "call-7",
                name: "tool_call",
                args: {
                  name: "read_file",
                  arguments: '{"path":"report.txt"}',
                },
                result: "contents",
              },
            ],
            [3, "message.complete", {}],
          ] as const)
            publish?.({ type, session_id: "live-secret", seq, payload })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-7",
      toolCallName: "read_file",
      parentMessageId: "message-42",
    })
    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-7",
      delta: '{"filename":"report.txt"}',
    })
  })

  it("releases reconnect admission and observation when native recovery setup fails", async () => {
    let attempts = 0
    let unsubscribes = 0
    const engine = new HermesRunEngine(
      native({
        observe: async () => () => {
          unsubscribes += 1
        },
        recover: async () => {
          attempts += 1
          if (attempts === 1) throw new Error("recovery unavailable")
          return { epoch: "epoch-1", lastSeen: 0, events: [] }
        },
      })
    )
    const request = {
      threadId: scope.threadId,
      runId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 0 },
    }

    await expect(engine.reconnect(scope, request)).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })
    await expect(engine.reconnect(scope, request)).resolves.toBeDefined()
    expect(unsubscribes).toBe(1)
  })

  it("keeps an active run reconnectable when reattachment setup fails", async () => {
    let resumes = 0
    const engine = new HermesRunEngine(
      native({
        resume: async () => {
          resumes += 1
          if (resumes === 2) throw new Error("reattach unavailable")
          return { liveSessionId: "live-secret" }
        },
      })
    )
    const first = await engine.start(scope, input())
    first.disconnect()
    const request = {
      threadId: scope.threadId,
      runId: "run-1",
      position: first.recoveryPosition(),
    }

    await expect(engine.reconnect(scope, request)).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })
    await expect(engine.reconnect(scope, request)).resolves.toBeDefined()
  })

  it("releases an uncertain-send fence only after authoritative native idle", async () => {
    let publish: ((event: unknown) => void) | undefined
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          return {
            acknowledgement: submissions === 1 ? "uncertain" : "accepted",
          }
        },
      })
    )
    await engine.start(scope, input())

    publish?.({
      type: "session.info",
      session_id: "live-secret",
      seq: 1,
      payload: { running: false },
    })

    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("rejects an oversized native recovery batch as reset-required", async () => {
    const engine = new HermesRunEngine(
      native({
        recover: async () => ({
          epoch: "epoch-1",
          lastSeen: 5_000,
          events: Array.from({ length: 4_097 }, () => ({
            type: "message.delta",
            session_id: "live-secret",
            payload: { text: "x" },
          })),
        }),
      })
    )
    const handle = await engine.reconnect(scope, {
      threadId: scope.threadId,
      runId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 0 },
    })

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes history must be reconciled before this run can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
  })

  it("releases an attached admission when the authoritative idle check fails", async () => {
    let statuses = 0
    let unsubscribes = 0
    const engine = new HermesRunEngine(
      native({
        observe: async () => () => {
          unsubscribes += 1
        },
        status: async () => {
          statuses += 1
          if (statuses === 1) throw new Error("status unavailable")
          return "idle"
        },
      })
    )

    await expect(engine.start(scope, input())).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).resolves.toBeDefined()
    expect(unsubscribes).toBe(1)
  })

  it("does not disclose native setup, reconnect, or Stop failures", async () => {
    const setup = new HermesRunEngine(
      native({
        resume: async () => {
          throw new Error("bearer setup-secret")
        },
      })
    )
    await expect(setup.start(scope, input())).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })

    const reconnect = new HermesRunEngine(
      native({
        recover: async () => {
          throw new Error("cookie reconnect-secret")
        },
      })
    )
    await expect(
      reconnect.reconnect(scope, {
        threadId: scope.threadId,
        runId: "run-1",
        position: { epoch: "epoch-1", lastSeen: 0 },
      })
    ).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })

    const stopping = new HermesRunEngine(
      native({
        interrupt: async () => {
          throw new Error("native stop-secret")
        },
      })
    )
    const handle = await stopping.start(scope, input())
    await expect(handle.stop()).rejects.toMatchObject({
      code: "AOS_STOP_UNCERTAIN",
      message: "Hermes could not confirm Stop; reconcile before sending again.",
    })
  })

  it("bounds native events buffered before the active run is established", async () => {
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          for (let seq = 1; seq <= 4_097; seq += 1)
            listener({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: "x" },
            })
          return () => undefined
        },
        recover: async () => ({ epoch: "epoch-1", lastSeen: 0, events: [] }),
        submit: async () => {
          submissions += 1
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes history must be reconciled before this run can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
    expect(submissions).toBe(0)
  })

  it("bounds bytes buffered before the active run is established", async () => {
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          listener({
            type: "message.delta",
            session_id: "live-secret",
            seq: 1,
            payload: { text: "x".repeat(4_194_305) },
          })
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "AOS_RESET_REQUIRED",
    })
    expect(submissions).toBe(0)
  })

  it("bounds unread AG-UI events and terminalizes overflow", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          for (let seq = 2; seq <= 4_100; seq += 1)
            publish?.({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: "x" },
            })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events[0]).toEqual({
      type: EventType.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    })
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })
    expect(events).toHaveLength(2)
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).rejects.toThrow("already active")
  })

  it("projects validated Hermes usage onto the standard terminal event", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "session.usage",
            session_id: "live-secret",
            seq: 1,
            payload: {
              usage: {
                model: "claude-safe",
                input: 12,
                output: 7,
                reasoning: 3,
                total: 22,
                native_metadata: "private",
              },
            },
          })
          publish?.({
            type: "session.info",
            session_id: "live-secret",
            seq: 2,
            payload: { usage: { model: "invalid", input: -1, output: 99 } },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    for (const event of events)
      expect(EventSchemas.safeParse(event).success).toBe(true)
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
      usage: [
        {
          model: "claude-safe",
          inputTokens: 12,
          outputTokens: 7,
          reasoningTokens: 3,
          totalTokens: 22,
        },
      ],
    })
    expect(JSON.stringify(events)).not.toContain("native_metadata")
  })

  it("accepts session info usage and gives final message usage precedence", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "session.info",
            session_id: "live-secret",
            seq: 1,
            payload: {
              usage: { model: "live-model", input: 3, output: 2, total: 5 },
            },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 2,
            payload: {
              usage: {
                model: "final-model",
                input: 8,
                output: 5,
                reasoning: 1,
                total: 14,
              },
            },
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      usage: [
        {
          model: "final-model",
          inputTokens: 8,
          outputTokens: 5,
          reasoningTokens: 1,
          totalTokens: 14,
        },
      ],
    })
  })
})
