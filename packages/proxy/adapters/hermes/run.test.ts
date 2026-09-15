import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import { HermesRunEngine, type HermesRunNative } from "./run"

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
    redirect: async () => "redirected",
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
  it("keeps one AOS run while redirecting into a distinct assistant generation", async () => {
    let publish: ((event: unknown) => void) | undefined
    const redirect = vi.fn(async () => "redirected" as const)
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        redirect,
      })
    )
    const handle = await engine.start(scope, input())
    publish?.({
      type: "message.start",
      session_id: "live-secret",
      seq: 1,
      payload: { message_id: "reply-before" },
    })
    publish?.({
      type: "message.delta",
      session_id: "live-secret",
      seq: 2,
      payload: { text: "Before" },
    })
    publish?.({
      type: "tool.start",
      session_id: "live-secret",
      seq: 3,
      payload: { tool_id: "tool-1", name: "read_file", args: {} },
    })

    await expect(
      handle.steer?.({ requestId: "queue-item-1", text: "Correction" })
    ).resolves.toBe("steered")
    publish?.({
      type: "message.complete",
      session_id: "live-secret",
      seq: 4,
      payload: { message_id: "reply-before", text: "Before" },
    })
    publish?.({
      type: "tool.complete",
      session_id: "live-secret",
      seq: 5,
      payload: {
        tool_id: "tool-1",
        name: "read_file",
        args: {},
        result: "contents",
      },
    })
    publish?.({
      type: "message.start",
      session_id: "live-secret",
      seq: 6,
      payload: { message_id: "reply-after" },
    })
    publish?.({
      type: "message.delta",
      session_id: "live-secret",
      seq: 7,
      payload: { text: "After" },
    })
    publish?.({
      type: "message.complete",
      session_id: "live-secret",
      seq: 8,
      payload: { message_id: "reply-after", text: "After" },
    })
    publish?.({
      type: "session.info",
      session_id: "live-secret",
      seq: 9,
      payload: { running: false },
    })

    const events = await collect(handle)
    expect(redirect).toHaveBeenCalledWith("live-secret", "Correction")
    expect(
      events.filter(
        (event) => (event as { type?: unknown }).type === EventType.RUN_STARTED
      )
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) => (event as { type?: unknown }).type === EventType.RUN_FINISHED
      )
    ).toHaveLength(1)
    expect(
      events
        .filter(
          (event) =>
            (event as { type?: unknown }).type === EventType.TEXT_MESSAGE_START
        )
        .map((event) => (event as { messageId: string }).messageId)
    ).toEqual(["reply-before", "reply-after"])
    expect(
      events.find(
        (event) =>
          (event as { type?: unknown }).type === EventType.TOOL_CALL_RESULT
      )
    ).toMatchObject({
      messageId: "reply-before:tool:tool-1",
      toolCallId: "tool-1",
    })
  })
  it("holds an early native idle boundary until redirect acknowledgement", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        redirect: async () => {
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 2,
            payload: { message_id: "reply-before", text: "Before" },
          })
          publish?.({
            type: "session.info",
            session_id: "live-secret",
            seq: 3,
            payload: { running: false },
          })
          return "redirected"
        },
      })
    )
    const handle = await engine.start(scope, input())
    publish?.({
      type: "message.delta",
      session_id: "live-secret",
      seq: 1,
      payload: { text: "Before" },
    })
    let settled = false
    void handle.settled.then(() => {
      settled = true
    })

    await expect(
      handle.steer?.({ requestId: "queue-item-race", text: "Correction" })
    ).resolves.toBe("steered")
    expect(settled).toBe(false)

    const events = await collect(handle)
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it("settles a run when its native turn later completes", async () => {
    let listener: ((event: unknown) => void) | undefined
    let observing = false
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, next) => {
          listener = next
          observing = true
          return () => {
            observing = false
          }
        },
      })
    )
    const publish = (event: unknown) => {
      if (observing) listener?.(event)
    }

    const first = await engine.start(scope, input())
    publish({
      type: "message.start",
      session_id: "live-secret",
      seq: 1,
      payload: { message_id: "reply" },
    })
    publish({
      type: "message.delta",
      session_id: "live-secret",
      seq: 2,
      payload: { text: "Done" },
    })
    publish({
      type: "message.complete",
      session_id: "live-secret",
      seq: 3,
      payload: {},
    })

    await first.settled
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it.each([false, true])(
    "uses authoritative completion text without duplicating a fully streamed answer (streamed: %s)",
    async (streamed) => {
      let publish: ((event: unknown) => void) | undefined
      const engine = new HermesRunEngine(
        native({
          observe: async (_liveSessionId, listener) => {
            publish = listener
            return () => undefined
          },
          submit: async () => {
            let seq = 1
            publish?.({
              type: "message.start",
              session_id: "live-secret",
              seq: seq++,
              payload: { message_id: "reply" },
            })
            publish?.({
              type: "reasoning.delta",
              session_id: "live-secret",
              seq: seq++,
              payload: { text: "Thinking" },
            })
            if (streamed)
              publish?.({
                type: "message.delta",
                session_id: "live-secret",
                seq: seq++,
                payload: { text: "Final answer" },
              })
            publish?.({
              type: "message.complete",
              session_id: "live-secret",
              seq,
              payload: { text: "Final answer" },
            })
            return { acknowledgement: "accepted" }
          },
        })
      )

      const events = await collect(await engine.start(scope, input()))

      expect(
        events
          .filter(
            (event): event is { type: string; delta: string } =>
              !!event &&
              typeof event === "object" &&
              (event as { type?: unknown }).type ===
                EventType.TEXT_MESSAGE_CONTENT
          )
          .map(({ delta }) => delta)
      ).toEqual(["Final answer"])
      const types = events.map((event) =>
        event && typeof event === "object"
          ? (event as { type?: unknown }).type
          : undefined
      )
      expect(types.indexOf(EventType.REASONING_MESSAGE_END)).toBeLessThan(
        types.indexOf(EventType.TEXT_MESSAGE_CONTENT)
      )
      expect(types.indexOf(EventType.TEXT_MESSAGE_CONTENT)).toBeLessThan(
        types.indexOf(EventType.TEXT_MESSAGE_END)
      )
      expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
        types.indexOf(EventType.RUN_FINISHED)
      )
    }
  )

  it("keeps transient Hermes thinking status out of reasoning", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, text] of [
            [1, "message.start", undefined],
            [2, "thinking.delta", "deliberating..."],
            [3, "thinking.delta", ""],
            [4, "message.delta", "Final"],
            [5, "message.delta", " answer"],
            [6, "thinking.delta", ""],
            [7, "message.complete", "Final answer"],
          ] as const)
            publish?.({
              type,
              session_id: "live-secret",
              seq,
              payload: text === undefined ? {} : { text },
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
        messageId: "run-1:assistant",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "run-1:assistant",
        delta: "Final",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "run-1:assistant",
        delta: " answer",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "run-1:assistant",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("streams Hermes' authoritative reasoning fallback when no deltas arrived", async () => {
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
            [2, "reasoning.available", { text: "Checked the evidence." }],
            [3, "message.complete", {}],
          ] as const)
            publish?.({ type, session_id: "live-secret", seq, payload })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "message-42:reasoning",
        role: "reasoning",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "message-42:reasoning",
        delta: "Checked the evidence.",
      },
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId: "message-42:reasoning",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("prefers streamed reasoning without mixing in status or fallback text", async () => {
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
            [2, "thinking.delta", { text: "Musing…" }],
            [3, "reasoning.delta", { text: "Checked the evidence." }],
            [4, "reasoning.available", { text: "Fallback snapshot." }],
            [5, "message.delta", { text: "Draft" }],
            [6, "message.complete", { text: "Draft" }],
          ] as const)
            publish?.({ type, session_id: "live-secret", seq, payload })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(
      events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === EventType.REASONING_MESSAGE_CONTENT
      )
    ).toEqual([
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "message-42:reasoning",
        delta: "Checked the evidence.",
      },
    ])
    const types = events.map((event) =>
      event && typeof event === "object" && "type" in event
        ? event.type
        : undefined
    )
    expect(types.indexOf(EventType.REASONING_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.TEXT_MESSAGE_CONTENT)
    )
    expect(events.at(-2)).toEqual({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "message-42",
    })
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

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

  it("rejects browser-owned forwarded properties", async () => {
    const engine = new HermesRunEngine(native())

    await expect(
      engine.start(scope, input({ forwardedProps: { provider: "hermes" } }))
    ).rejects.toThrow("forwarded properties")
    await expect(
      engine.start(scope, input({ forwardedProps: "native override" }))
    ).rejects.toThrow("forwarded properties")
  })

  it("finishes with a native AG-UI interrupt and resumes it without submitting a prompt", async () => {
    let publish: ((event: unknown) => void) | undefined
    let submits = 0
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          submits += 1
          publish?.({
            type: "approval.request",
            session_id: "live-secret",
            seq: 1,
            payload: { request_id: "approval-1" },
          })
          return { acknowledgement: "accepted" }
        },
        acceptInteraction: (_scope, _liveSessionId, event) =>
          (event as { type?: string }).type === "approval.request"
            ? {
                type: "interrupt",
                interrupts: [
                  {
                    id: "approval-1",
                    reason: "approval",
                    message: "Continue?",
                    responseSchema: {
                      type: "string",
                      enum: ["once", "deny"],
                    },
                  },
                ],
              }
            : undefined,
        respondInteractions: async (_scope, resume) => {
          expect(resume).toEqual([
            {
              interruptId: "approval-1",
              status: "resolved",
              payload: "once",
            },
          ])
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 2,
            payload: { message_id: "continued" },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 3,
            payload: { text: "Done" },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 4,
            payload: {},
          })
          return [{ status: "resolved" }]
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "approval-1",
              reason: "approval",
              message: "Continue?",
              responseSchema: { type: "string", enum: ["once", "deny"] },
            },
          ],
        },
      },
    ])

    await expect(
      collect(
        await engine.start(
          scope,
          input({
            runId: "run-2",
            messages: [],
            resume: [
              {
                interruptId: "approval-1",
                status: "resolved",
                payload: "once",
              },
            ],
          })
        )
      )
    ).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-2" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "continued",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "continued",
        delta: "Done",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "continued" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-2",
        outcome: { type: "success" },
      },
    ])
    expect(submits).toBe(1)
  })

  it("streams a resumed interaction when Hermes continues without another message start", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "clarify.request",
            session_id: "live-secret",
            seq: 1,
            payload: { request_id: "question-1" },
          })
          return { acknowledgement: "accepted" }
        },
        acceptInteraction: (_scope, _liveSessionId, event) =>
          (event as { type?: string }).type === "clarify.request"
            ? {
                type: "interrupt",
                interrupts: [
                  {
                    id: "question-1",
                    reason: "question",
                    message: "Answer whichever apply.",
                  },
                ],
              }
            : undefined,
        respondInteractions: async () => {
          publish?.({
            type: "tool.complete",
            session_id: "live-secret",
            seq: 2,
            payload: {
              tool_id: "clarify-call",
              name: "clarify",
              args: {
                questions: [
                  {
                    question: "Answer whichever apply.",
                    choices: ["One", "Two"],
                    multi_select: true,
                  },
                ],
              },
              result: {
                responses: [
                  {
                    question: "Answer whichever apply.",
                    choices_offered: ["One", "Two"],
                    user_response: "",
                  },
                ],
              },
            },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 3,
            payload: { text: "No answers selected." },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 4,
            payload: { text: "No answers selected." },
          })
          return [{ status: "resolved" }]
        },
      })
    )

    await collect(await engine.start(scope, input()))
    const resumed = await collect(
      await engine.start(
        scope,
        input({
          runId: "run-2",
          messages: [],
          resume: [{ interruptId: "question-1", status: "cancelled" }],
        })
      )
    )

    expect(resumed).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-2" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "clarify-call",
        toolCallName: "question",
        parentMessageId: "run-2:assistant",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "clarify-call",
        delta: JSON.stringify({
          question: "1 question",
          questions: [
            {
              question: "Answer whichever apply.",
              options: ["One", "Two"],
              allowFreeform: false,
              multiple: true,
            },
          ],
          allowFreeform: true,
        }),
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "clarify-call" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "run-2:assistant:tool:clarify-call",
        toolCallId: "clarify-call",
        content: JSON.stringify({
          status: "cancelled",
          responses: [{ question: "Answer whichever apply.", answers: [] }],
        }),
        role: "tool",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "run-2:assistant",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "run-2:assistant",
        delta: "No answers selected.",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "run-2:assistant" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-2",
        outcome: { type: "success" },
      },
    ])
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

  it("terminalizes a definitive command rejection without marking delivery uncertain", async () => {
    const engine = new HermesRunEngine(
      native({
        submit: async () => ({ acknowledgement: "rejected" }),
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message: "Hermes rejected this command.",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
    await expect(
      engine.start(scope, input({ runId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("explains why a recognized slash command with attachments was rejected", async () => {
    const engine = new HermesRunEngine(
      native({
        submit: async () => ({
          acknowledgement: "rejected",
          rejection: "command-with-attachments",
        }),
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message: "Slash commands cannot be sent with attachments.",
        code: "AOS_COMMAND_WITH_ATTACHMENTS",
      },
    ])
  })

  it("returns a composer prefill from a synchronous native command", async () => {
    const engine = new HermesRunEngine(
      native({
        submit: async () => ({
          acknowledgement: "accepted",
          completion: {
            output: "Undid 1 turn.",
            composerPrefill: "Earlier question",
          },
        }),
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      result: { "aos.composerPrefill": "Earlier question" },
      outcome: { type: "success" },
    })
    expect(events).toContainEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "aos-command:run-1",
      delta: "Undid 1 turn.",
    })
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
        delta: '{"goal":"Inspect"}',
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
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-42",
        role: "assistant",
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

  it("streams authoritative Hermes Todos as one PLAN snapshot followed by deltas", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-plan" }],
            [
              2,
              "tool.start",
              { tool_id: "todo-1", name: "todo_list", args: {} },
            ],
            [
              3,
              "tool.complete",
              {
                tool_id: "todo-1",
                name: "todo_list",
                result: {
                  todos: [{ id: "ship", content: "Ship", status: "active" }],
                },
              },
            ],
            [
              4,
              "tool.start",
              { tool_id: "todo-2", name: "todo_list", args: {} },
            ],
            [
              5,
              "tool.complete",
              {
                tool_id: "todo-2",
                name: "todo_list",
                result: {
                  todos: [{ id: "ship", content: "Ship", status: "completed" }],
                },
              },
            ],
            [6, "message.complete", {}],
          ] as const)
            publish?.({ type, session_id: "live-secret", seq, payload })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const activities = events.filter(
      (event) =>
        !!event &&
        typeof event === "object" &&
        "type" in event &&
        (event.type === EventType.ACTIVITY_SNAPSHOT ||
          event.type === EventType.ACTIVITY_DELTA)
    )

    expect(activities).toEqual([
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `aos-plan:${scope.threadId}`,
        activityType: "PLAN",
        content: {
          todos: [{ id: "ship", label: "Ship", status: "active" }],
        },
        replace: true,
      },
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: `aos-plan:${scope.threadId}`,
        activityType: "PLAN",
        patch: [
          {
            op: "replace",
            path: "/todos",
            value: [{ id: "ship", label: "Ship", status: "completed" }],
          },
        ],
      },
    ])
    for (const event of activities)
      expect(EventSchemas.safeParse(event).success).toBe(true)
  })

  it("streams a published artifact as the same safe AOS data part used by history", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-artifact" }],
            [
              2,
              "tool.start",
              {
                tool_id: "artifact-call",
                name: "present_artifact",
                args: { path: "/srv/hermes/private/report.md" },
              },
            ],
            [
              3,
              "tool.complete",
              {
                tool_id: "artifact-call",
                name: "present_artifact",
                result: {
                  ok: true,
                  type: "aos.artifact",
                  artifact: {
                    id: "report-1",
                    filename: "report.md",
                    path: "/srv/hermes/private/report.md",
                    mimeType: "text/markdown",
                    sizeBytes: 42,
                  },
                },
              },
            ],
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
      messageId: "message-artifact:tool:artifact-call",
      toolCallId: "artifact-call",
      content: JSON.stringify({
        ok: true,
        type: "aos.artifact",
        artifact: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
        },
      }),
      role: "tool",
    })
    expect(events).toContainEqual({
      type: EventType.CUSTOM,
      name: "aos.artifact",
      value: {
        id: "report-1",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
        source: { type: "provider", reference: "report-1" },
      },
    })
    expect(JSON.stringify(events)).not.toContain("/srv/hermes/private")
  })

  it("streams trusted TTS media and suppresses a redundant copied marker", async () => {
    const audioPath = "/home/alice/voice-memos/out/quick-brief.mp3"
    const copiedPath = "/home/alice/voice-memos/out/copied-brief.mp3"
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-media" }],
            [
              2,
              "tool.start",
              {
                tool_id: "tts-call",
                name: "text_to_speech",
                args: { text: "Quarterly update" },
              },
            ],
            [
              3,
              "tool.complete",
              {
                tool_id: "tts-call",
                name: "text_to_speech",
                result: {
                  success: true,
                  file_path: audioPath,
                  file_paths: [audioPath],
                  media_tag: `MEDIA:${audioPath}`,
                  provider: "edge",
                },
              },
            ],
            [4, "message.delta", { text: "Your brief is ready.\nME" }],
            [5, "message.delta", { text: "DIA:" }],
            [6, "message.delta", { text: copiedPath }],
            [7, "message.complete", {}],
          ] as const)
            publish?.({ type, session_id: "live-secret", seq, payload })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const artifact = events.find(
      (event) =>
        !!event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === EventType.CUSTOM &&
        "name" in event &&
        event.name === "aos.artifact"
    )

    expect(artifact).toMatchObject({
      type: EventType.CUSTOM,
      name: "aos.artifact",
      value: {
        filename: "quick-brief.mp3",
        mimeType: "audio/mpeg",
      },
    })
    expect(events).toContainEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "message-media",
      delta: "Your brief is ready.\n",
    })
    expect(JSON.stringify(events)).not.toContain("MEDIA:")
    expect(JSON.stringify(events)).not.toContain(audioPath)
    expect(JSON.stringify(events)).not.toContain(copiedPath)
    expect(JSON.stringify(events)).not.toContain("Media unavailable")
  })

  it("settles a tool before the run when Hermes loses its completion event", async () => {
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
                tool_id: "call-lost-complete",
                name: "search",
                args: { query: "evidence" },
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

    expect(events.slice(-3)).toEqual([
      { type: EventType.TOOL_CALL_END, toolCallId: "call-lost-complete" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "message-42:tool:call-lost-complete",
        toolCallId: "call-lost-complete",
        content: '{"status":"completed"}',
        role: "tool",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
    await expect(
      engine.start(scope, input({ runId: "run-after-tool-recovery" }))
    ).resolves.toBeDefined()
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

  it("rechecks an acknowledged Stop without interrupting Hermes twice", async () => {
    let interrupted = 0
    let statusChecks = 0
    const engine = new HermesRunEngine(
      native({
        interrupt: async () => {
          interrupted += 1
        },
        status: async () =>
          interrupted === 0 || ++statusChecks > 1 ? "idle" : "running",
      })
    )
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("stopping")
    await expect(handle.stop()).resolves.toBe("idle")
    expect(interrupted).toBe(1)
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

  it("starts a new run without downloading Hermes retained replay", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        recover: async (_liveSessionId, lastSeen) => {
          if (lastSeen !== Number.MAX_SAFE_INTEGER)
            throw new Error("retained replay exceeds the transport limit")
          return { epoch: "epoch-1", lastSeen: 328, events: [] }
        },
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 329,
            payload: { message_id: "message-43" },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 330,
            payload: { text: "Current" },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 331,
            payload: { text: "Current", status: "complete" },
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-43",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-43",
        delta: "Current",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-43" },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "run-1",
        outcome: { type: "success" },
      },
    ])
  })

  it("uses completed baseline events only as the cursor for a new turn", async () => {
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        recover: async () => ({
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
              payload: { text: "Previous" },
            },
            {
              type: "message.complete",
              session_id: "live-secret",
              seq: 3,
              payload: { text: "Previous", status: "complete" },
            },
          ],
        }),
        submit: async () => {
          publish?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 4,
            payload: { message_id: "message-43" },
          })
          publish?.({
            type: "message.delta",
            session_id: "live-secret",
            seq: 5,
            payload: { text: "Current" },
          })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 6,
            payload: { text: "Current", status: "complete" },
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-43",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-43",
        delta: "Current",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-43" },
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

    const handle = await engine.recover(scope, {
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

    const resumed = await engine.recover(scope, {
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

  it("reconstructs an active run from authoritative Hermes recovery after proxy restart", async () => {
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        recover: async (_liveSessionId, lastSeen) => {
          expect(lastSeen).toBeUndefined()
          return {
            epoch: "epoch-after-restart",
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

    const resumed = await engine.recover(scope, {
      threadId: scope.threadId,
      runId: "restored-run",
    })

    await expect(collect(resumed)).resolves.toMatchObject([
      { type: EventType.RUN_STARTED, runId: "restored-run" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "message-42" },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: "Recovered" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-42" },
      { type: EventType.RUN_FINISHED, runId: "restored-run" },
    ])
    expect(submissions).toBe(0)
  })

  it("does not expose browser transport disconnect controls", async () => {
    let interrupts = 0
    const engine = new HermesRunEngine(
      native({
        interrupt: async () => {
          interrupts += 1
        },
      })
    )
    const handle = await engine.start(scope, input())

    expect("disconnect" in handle).toBe(false)
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
      content: '"contents"',
      role: "tool",
    })
  })

  it("projects bounded inspectable tool data while redacting credentials and provider metadata", async () => {
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
                  query: "OPENAI_API_KEY=sk-query-secret",
                  pattern:
                    "(/srv/private/a),../relative/b,~/home/c,C:\\Users\\private\\d,\\\\server\\share\\e",
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
                    "TOKEN=summary-secret; see:https://provider.invalid,(/srv/private/result.txt),./relative,~/home,C:\\private\\x,\\\\host\\share",
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
      delta: JSON.stringify({
        query: "[REDACTED]",
        pattern:
          "(/srv/private/a),../relative/b,~/home/c,C:\\Users\\private\\d,\\\\server\\share\\e",
        path: "/srv/private/workspace",
        apiToken: "[REDACTED]",
      }),
    })
    expect(events).toContainEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "message-42:tool:call-7",
      toolCallId: "call-7",
      content: JSON.stringify({
        status: "ok",
        sourceUrl: "https://provider.invalid/private",
        filesystem_path: "/srv/private/result.txt",
        access_token: "[REDACTED]",
        summary: "[REDACTED]",
      }),
      role: "tool",
    })
    expect(JSON.stringify(events)).not.toContain("live-secret")
    expect(JSON.stringify(events)).not.toContain("bearer-secret")
    expect(JSON.stringify(events)).not.toContain("sk-query-secret")
    expect(JSON.stringify(events)).not.toContain("summary-secret")
    expect(JSON.stringify(events)).toContain("[REDACTED]")
  })

  it("redacts credential environment assignments without hiding safe lookalike keys", async () => {
    const credentials = [
      "OPENAI_API_KEY=ordinary-value",
      "SERVICE_API_KEY=ordinary-value",
      "AWS_ACCESS_KEY_ID=ordinary-value",
      "CLIENT_SECRET_KEY=ordinary-value",
      "SESSION_TOKEN=ordinary-value",
      "NPM_CONFIG_USERCONFIG=ordinary-value",
      "NPM_CONFIG__AUTH=ordinary-value",
      "MYSQL_PWD=ordinary-value",
      "PASSWORD_HASH=ordinary-value",
      "SSH_PRIVATE_KEY_B64=ordinary-value",
    ]
    const safe =
      "type x:string; variant A:control; ratio x:y; C:drive-relative; TOKEN_COUNT=12 SECRETARY=Jo AUTHORIZATION_MODE=oidc OAUTH=enabled PATHOLOGY=stable ACCESS_KEY_ROTATION=weekly"
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
          for (const [index, query] of [...credentials, safe].entries())
            publish?.({
              type: "tool.start",
              session_id: "live-secret",
              seq: index + 2,
              payload: {
                tool_id: `call-${index}`,
                name: "search",
                args: { query },
              },
            })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: credentials.length + 3,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const argumentDeltas = events.flatMap((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === EventType.TOOL_CALL_ARGS &&
      "delta" in event &&
      typeof event.delta === "string"
        ? [event.delta]
        : []
    )

    expect(argumentDeltas).toEqual([
      ...credentials.map(() => '{"query":"[REDACTED]"}'),
      JSON.stringify({ query: safe }),
    ])
    for (const credential of credentials)
      expect(JSON.stringify(events)).not.toContain(credential)
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
    expect(args.delta).toContain("[Truncated]")
    expect(args.delta).not.toContain("\\ud83d")
    expect(result).toMatchObject({
      content: expect.stringContaining("[Truncated]"),
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

  it("discovers and reattaches a running Hermes Session after proxy restart", async () => {
    let observations = 0
    const engine = new HermesRunEngine(
      native({
        inspectExecution: async () => ({ status: "running" }),
        observe: async () => {
          observations += 1
          return () => undefined
        },
      })
    )

    const discovered = await engine.discover(scope, "recovered-run")

    expect(discovered?.state).toBe("running")
    expect(observations).toBe(1)
  })

  it("discovers a pending Hermes interaction as a standard AG-UI interrupt", async () => {
    const interrupt = {
      id: "question-1",
      reason: "question",
      message: "Choose",
      responseSchema: { type: "string", enum: ["yes", "no"] },
    }
    const engine = new HermesRunEngine(
      native({
        inspectExecution: async () => ({
          status: "waiting-for-input",
          outcome: { type: "interrupt", interrupts: [interrupt] },
        }),
      })
    )

    const discovered = await engine.discover(scope, "recovered-question")

    expect(discovered?.state).toBe("waiting-for-input")
    expect(discovered?.interrupts).toEqual([interrupt])
    await expect(collect(discovered!.handle)).resolves.toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "recovered-question",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId: "recovered-question",
        outcome: { type: "interrupt", interrupts: [interrupt] },
      },
    ])
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

    const handle = await engine.recover(scope, {
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
      delta: '{"path":"report.txt"}',
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

    await expect(engine.recover(scope, request)).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })
    await expect(engine.recover(scope, request)).resolves.toBeDefined()
    expect(unsubscribes).toBe(1)
  })

  it("does not detach an active run when browser ownership changes", async () => {
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
    expect("disconnect" in first).toBe(false)
    expect(resumes).toBe(1)
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
    const handle = await engine.recover(scope, {
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
      reconnect.recover(scope, {
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

  it("counts lone-surrogate JSON escaping in recovery and pre-active budgets", async () => {
    const chunk = "\ud800".repeat(340_000)
    const recovered = new HermesRunEngine(
      native({
        recover: async () => ({
          epoch: "epoch-1",
          lastSeen: 5,
          events: [
            {
              type: "message.start",
              session_id: "live-secret",
              seq: 1,
              payload: { message_id: "message-42" },
            },
            ...Array.from({ length: 4 }, (_, index) => ({
              type: "message.delta",
              session_id: "live-secret",
              seq: index + 2,
              payload: { text: chunk },
            })),
          ],
        }),
      })
    )

    expect(await collect(await recovered.start(scope, input()))).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes history must be reconciled before this run can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])

    let submissions = 0
    const preActive = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          for (let seq = 1; seq <= 4; seq += 1)
            listener({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: chunk },
            })
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          return { acknowledgement: "uncertain" }
        },
      })
    )

    expect(await collect(await preActive.start(scope, input()))).toEqual([
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

  it("accepts one bounded lone-surrogate native frame but limits unread serialized events cumulatively", async () => {
    const chunk = "\ud800".repeat(340_000)
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
      })
    )
    const handle = await engine.start(scope, input())
    const iterator = handle.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: EventType.RUN_STARTED },
    })
    const messageStart = iterator.next()
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
      payload: { text: chunk },
    })
    await expect(messageStart).resolves.toMatchObject({
      value: { type: EventType.TEXT_MESSAGE_START },
    })
    const content = iterator.next()
    await expect(content).resolves.toMatchObject({
      value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: chunk },
    })
    let publishUnread: ((event: unknown) => void) | undefined
    const unread = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publishUnread = listener
          return () => undefined
        },
        submit: async () => {
          publishUnread?.({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          for (let seq = 2; seq <= 5; seq += 1)
            publishUnread?.({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: chunk },
            })
          publishUnread?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 6,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    expect(await collect(await unread.start(scope, input()))).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message: "Hermes produced more events than AOS can safely buffer.",
        code: "AOS_STREAM_OVERFLOW",
      },
    ])
  })

  it("ignores unrelated live events before traversing their provider payloads", async () => {
    let payloadReads = 0
    let publish: ((event: unknown) => void) | undefined
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          return () => undefined
        },
        submit: async () => {
          publish?.({
            type: "message.delta",
            session_id: "another-live-session",
            seq: 1,
            payload: { text: "\ud800".repeat(800_000) },
          })
          const unrelated = {
            type: "message.delta",
            session_id: "another-live-session",
            seq: 1,
          } as Record<string, unknown>
          Object.defineProperty(unrelated, "payload", {
            enumerable: true,
            get() {
              payloadReads += 1
              throw new Error("must not traverse unrelated payload")
            },
          })
          publish?.(unrelated)
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 1,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(payloadReads).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it("ignores unrelated pre-active events without consuming the Session buffer", async () => {
    let payloadReads = 0
    let publish: ((event: unknown) => void) | undefined
    let submissions = 0
    const engine = new HermesRunEngine(
      native({
        observe: async (_liveSessionId, listener) => {
          publish = listener
          listener({
            type: "message.delta",
            session_id: "another-live-session",
            seq: 1,
            payload: { text: "\ud800".repeat(800_000) },
          })
          const unrelated = {
            type: 42,
            session_id: "another-live-session",
            seq: 1,
          } as Record<string, unknown>
          Object.defineProperty(unrelated, "payload", {
            enumerable: true,
            get() {
              payloadReads += 1
              throw new Error("must not traverse unrelated payload")
            },
          })
          for (let count = 0; count < 4_100; count += 1) listener(unrelated)
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 1,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(payloadReads).toBe(0)
    expect(submissions).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
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

  it("never submits a stale first start after its terminal event admits a second run", async () => {
    const listeners = new Map<string, (event: unknown) => void>()
    const submitted: string[] = []
    let resumes = 0
    let releaseFirstStatus: (() => void) | undefined
    let markFirstStatusEntered: (() => void) | undefined
    const firstStatusEntered = new Promise<void>((resolve) => {
      markFirstStatusEntered = resolve
    })
    const engine = new HermesRunEngine(
      native({
        resume: async () => ({ liveSessionId: `live-${++resumes}` }),
        observe: async (liveSessionId, listener) => {
          listeners.set(liveSessionId, listener)
          return () => listeners.delete(liveSessionId)
        },
        recover: async () => ({ epoch: "epoch-1", lastSeen: 0, events: [] }),
        status: async (liveSessionId) => {
          if (liveSessionId !== "live-1") return "idle"
          markFirstStatusEntered?.()
          await new Promise<void>((resolve) => {
            releaseFirstStatus = resolve
          })
          return "idle"
        },
        submit: async (liveSessionId) => {
          submitted.push(liveSessionId)
          return { acknowledgement: "accepted" }
        },
      })
    )

    const firstStart = engine.start(scope, input())
    await firstStatusEntered
    listeners.get("live-1")?.({
      type: "message.complete",
      session_id: "live-1",
      seq: 1,
      payload: {},
    })
    const second = await engine.start(scope, input({ runId: "run-2" }))
    releaseFirstStatus?.()
    const first = await firstStart

    expect(submitted).toEqual(["live-2"])
    await expect(collect(first)).resolves.toContainEqual({
      type: EventType.RUN_FINISHED,
      threadId: scope.threadId,
      runId: "run-1",
      outcome: { type: "success" },
    })
    listeners.get("live-2")?.({
      type: "message.complete",
      session_id: "live-2",
      seq: 1,
      payload: {},
    })
    await collect(second)
  })

  it.each(["interrupted", "overflow"] as const)(
    "does not submit when the active run becomes %s during the status read",
    async (mode) => {
      let publish: ((event: unknown) => void) | undefined
      let disconnect: (() => void) | undefined
      let submissions = 0
      let releaseStatus: (() => void) | undefined
      let markStatusEntered: (() => void) | undefined
      const statusEntered = new Promise<void>((resolve) => {
        markStatusEntered = resolve
      })
      const engine = new HermesRunEngine(
        native({
          observe: async (_liveSessionId, listener, onDisconnected) => {
            publish = listener
            disconnect = onDisconnected
            return () => undefined
          },
          status: async () => {
            markStatusEntered?.()
            await new Promise<void>((resolve) => {
              releaseStatus = resolve
            })
            return "idle"
          },
          submit: async () => {
            submissions += 1
            return { acknowledgement: "accepted" }
          },
        })
      )

      const started = engine.start(scope, input())
      await statusEntered
      if (mode === "interrupted") disconnect?.()
      else {
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
      }
      releaseStatus?.()
      await started

      expect(submissions).toBe(0)
    }
  )

  it("enforces cumulative byte budgets for recovery and unread AG-UI events", async () => {
    const chunk = "🙂".repeat(250_000)
    const recovery = new HermesRunEngine(
      native({
        recover: async () => ({
          epoch: "epoch-1",
          lastSeen: 6,
          events: [
            {
              type: "message.start",
              session_id: "live-secret",
              seq: 1,
              payload: { message_id: "message-42" },
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              type: "message.delta",
              session_id: "live-secret",
              seq: index + 2,
              payload: { text: chunk },
            })),
          ],
        }),
      })
    )
    const recovered = await collect(await recovery.start(scope, input()))
    expect(recovered).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message:
          "Hermes history must be reconciled before this run can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])

    let publish: ((event: unknown) => void) | undefined
    const live = new HermesRunEngine(
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
          for (let seq = 2; seq <= 6; seq += 1)
            publish?.({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: chunk },
            })
          publish?.({
            type: "message.complete",
            session_id: "live-secret",
            seq: 7,
            payload: {},
          })
          return { acknowledgement: "accepted" }
        },
      })
    )
    const streamed = await collect(await live.start(scope, input()))
    expect(streamed).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message: "Hermes produced more events than AOS can safely buffer.",
        code: "AOS_STREAM_OVERFLOW",
      },
    ])
  })

  it("stops walking provider tool graphs when the traversal budget is exhausted", async () => {
    let reads = 0
    const wide: Record<string, string> = {}
    for (let index = 0; index < 10_000; index += 1)
      Object.defineProperty(wide, `field${index}`, {
        enumerable: true,
        get() {
          reads += 1
          return "safe"
        },
      })
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
              result: { results: [wide] },
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

    await collect(await engine.start(scope, input()))

    expect(reads).toBeLessThanOrEqual(1_024)
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
