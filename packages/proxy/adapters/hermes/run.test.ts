import {
  PendingRequestKind,
  ReplyStatus,
  StopReason,
  ToolKind,
  TurnEventKind,
  TurnEventSchema,
  type PendingRequest,
  type PromptTurnInput,
  type RepliesTurnInput,
  type RequestReply,
} from "../../core/events"
import { describe, expect, it, vi } from "vitest"

import type {
  AttachmentObserver,
  AttachmentSignal,
} from "./attachment-registry"
import {
  HermesTurnEngine,
  type HermesRecovery,
  type HermesTurnScope,
} from "./run"
import { HermesUnavailableError, type HermesLog } from "./gateway"
import type {
  HermesNativeStatus,
  HermesTurnNative,
  HermesSubmitPrompt,
} from "./run-native"
import { projectHermesHistory } from "./history"
import { hermesInflightTurn, restoredHermesFailedTurn } from "./inflight"
import {
  advisoryErrorThenComplete,
  failedToolThenRecovery,
  nativeTurn,
  terminalErrorThenIdle,
} from "./test-utils/native-events"
import { assistantToolCall, toolRow } from "./test-utils/history-rows"

const scope = {
  agentId: "research",
  sessionId: "stored-session",
  threadId: "hermes:research:stored-session",
}

function input(overrides: Partial<PromptTurnInput> = {}): PromptTurnInput {
  return {
    turnId: "run-1",
    messageId: "user-1",
    prompt: "Hello Hermes",
    ...overrides,
  }
}

/** A turn that only answers pending requests. */
function replies(
  turnId: string,
  ...answers: [RequestReply, ...RequestReply[]]
): RepliesTurnInput {
  return { turnId, replies: answers }
}

/**
 * The typed native boundary the engine consumes. Every method has a default so
 * a test states only the native behaviour it is about.
 */
function runtime(overrides: Partial<HermesTurnNative> = {}): HermesTurnNative {
  const replay =
    overrides.replay ??
    (async () => ({ epoch: "epoch-1", lastSeen: 0, events: [] }))
  return {
    resume: async () => ({ liveSessionId: "live-secret", running: false }),
    observe: async () => () => undefined,
    cursor: async () => ({ epoch: "epoch-1", latestSeq: 0 }),
    submit: async () => ({ acknowledgement: "accepted", status: "streaming" }),
    redirect: async () => "redirected",
    interrupt: async () => "interrupted",
    status: async () => "idle",
    retain: async () => () => undefined,
    inspectExecution: async () => ({ running: false, status: "idle" }),
    onPendingRequest: () => () => undefined,
    respondInteractions: async () => [],
    ...overrides,
    // Hermes answers `session.events.since` with -32602 unless the cursor is an
    // integer, so no replay may ever be issued without one.
    replay: async (liveSessionId: string, after: number) => {
      expect(Number.isSafeInteger(after)).toBe(true)
      expect(after).toBeGreaterThanOrEqual(0)
      return replay(liveSessionId, after)
    },
  }
}

/**
 * One native observation stream shared by every live Session, like the
 * registry's: a test publishes frames and connection signals per live id and
 * an unsubscribed observer stops receiving both.
 */
function observation() {
  const observers = new Map<string, AttachmentObserver>()
  return {
    observe: async (liveSessionId: string, observer: AttachmentObserver) => {
      observers.set(liveSessionId, observer)
      return () => {
        if (observers.get(liveSessionId) === observer)
          observers.delete(liveSessionId)
      }
    },
    attached(liveSessionId: string) {
      return observers.has(liveSessionId)
    },
    publish(liveSessionId: string, event: unknown) {
      observers.get(liveSessionId)?.({ kind: "event", event })
    },
    signal(liveSessionId: string, signal: AttachmentSignal) {
      observers.get(liveSessionId)?.(signal)
    },
  }
}

/**
 * The pending request stream `interactions.ts` owns: Hermes asks the user
 * through a server→client request, so a test raises one directly instead of
 * publishing a native event.
 */
function pendingRequests() {
  const listeners = new Set<(request: PendingRequest) => void>()
  return {
    onPendingRequest: (
      _scope: HermesTurnScope,
      listener: (request: PendingRequest) => void
    ) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribed() {
      return listeners.size
    },
    raise(request: PendingRequest) {
      for (const listener of [...listeners]) listener(request)
    },
  }
}

function ofKind(events: readonly unknown[], kind: TurnEventKind) {
  return events.filter((event) => (event as { kind?: unknown }).kind === kind)
}

function eventKinds(events: readonly unknown[]) {
  return events.map((event) => (event as { kind?: unknown }).kind)
}

/** The assistant messages a turn streamed text into, in order. */
function messageIds(events: readonly unknown[]) {
  return [
    ...new Set(
      ofKind(events, TurnEventKind.MessageChunk).map(
        (event) => (event as { messageId: string }).messageId
      )
    ),
  ]
}

async function collect(handle: { events: AsyncIterable<unknown> }) {
  const events: unknown[] = []
  for await (const event of handle.events) events.push(event)
  return events
}

/**
 * Whether the run settled within `ms`, without waiting on a stream that an
 * unsettled run never ends.
 */
async function settledWithin(handle: { settled: Promise<void> }, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const answer = await Promise.race([
    handle.settled.then(() => "settled" as const),
    new Promise<"open">((resolve) => {
      timer = setTimeout(() => resolve("open"), ms)
    }),
  ])
  clearTimeout(timer)
  return answer
}

describe("HermesRunEngine", () => {
  it("keeps one AOS turn while redirecting into a distinct assistant generation", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const redirect = vi.fn(async () => "redirected" as const)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        redirect,
      })
    )
    const handle = await engine.start(scope, input())
    const t = nativeTurn("live-secret", 1)
    publish(t.messageStart("reply-before"))
    publish(t.delta("Before"))
    publish(t.toolStart("tool-1", "read_file", {}))

    await expect(
      handle.steer?.({ requestId: "queue-item-1", text: "Correction" })
    ).resolves.toBe("steered")
    publish(t.complete("reply-before", "Before"))
    publish(t.toolComplete("tool-1", "read_file", "contents"))
    publish(t.messageStart("reply-after"))
    publish(t.delta("After"))
    publish(t.complete("reply-after", "After"))
    publish(t.idle())

    const events = await collect(handle)
    expect(redirect).toHaveBeenCalledWith("live-secret", "Correction")
    expect(ofKind(events, TurnEventKind.TurnStarted)).toHaveLength(1)
    expect(ofKind(events, TurnEventKind.TurnEnded)).toHaveLength(1)
    expect(messageIds(events)).toEqual(["reply-before", "reply-after"])
    expect(ofKind(events, TurnEventKind.ToolCallStarted)).toMatchObject([
      { toolCallId: "tool-1", parentMessageId: "reply-before" },
    ])
    expect(ofKind(events, TurnEventKind.ToolCallFinished)).toMatchObject([
      { toolCallId: "tool-1" },
    ])
  })
  it("holds an early native idle boundary until redirect acknowledgement", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        redirect: async () => {
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 2,
            payload: { message_id: "reply-before", text: "Before" },
          })
          publish({
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
    publish({
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
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("settles an AOS turn when its native turn later completes", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({ observe: attachment.observe })
    )

    const first = await engine.start(scope, input())
    const t = nativeTurn("live-secret", 1)
    publish(t.messageStart("reply"))
    publish(t.delta("Done"))
    publish(t.complete("reply", "Done"))

    await first.settled
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("settles a run on a payload-less message.complete frame", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({ observe: attachment.observe })
    )

    const first = await engine.start(scope, input())
    const t = nativeTurn("live-secret", 1)
    publish(t.messageStart("reply"))
    publish(t.delta("Done"))
    // Empty-payload completion: message_id, text, status all absent
    publish(t.frame("message.complete"))

    await first.settled
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it.each([false, true])(
    "uses authoritative completion text without duplicating a fully streamed answer (streamed: %s)",
    async (streamed) => {
      const attachment = observation()
      const publish = (event: unknown) =>
        attachment.publish("live-secret", event)
      const engine = new HermesTurnEngine(
        runtime({
          observe: attachment.observe,
          submit: async () => {
            let seq = 1
            publish({
              type: "message.start",
              session_id: "live-secret",
              seq: seq++,
              payload: { message_id: "reply" },
            })
            publish({
              type: "reasoning.delta",
              session_id: "live-secret",
              seq: seq++,
              payload: { text: "Thinking" },
            })
            if (streamed)
              publish({
                type: "message.delta",
                session_id: "live-secret",
                seq: seq++,
                payload: { text: "Final answer" },
              })
            publish({
              type: "message.complete",
              session_id: "live-secret",
              seq,
              payload: { text: "Final answer" },
            })
            return {
              acknowledgement: "accepted" as const,
              status: "streaming" as const,
            }
          },
        })
      )

      const events = await collect(await engine.start(scope, input()))

      expect(
        ofKind(events, TurnEventKind.MessageChunk).map(
          (event) => (event as { text: string }).text
        )
      ).toEqual(["Final answer"])
      const kinds = eventKinds(events)
      expect(kinds.lastIndexOf(TurnEventKind.ThoughtChunk)).toBeLessThan(
        kinds.indexOf(TurnEventKind.MessageChunk)
      )
      expect(kinds.lastIndexOf(TurnEventKind.MessageChunk)).toBeLessThan(
        kinds.indexOf(TurnEventKind.TurnEnded)
      )
    }
  )

  it("keeps transient Hermes thinking status out of reasoning", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({
              type,
              session_id: "live-secret",
              seq,
              payload: text === undefined ? {} : { text },
            })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-1:assistant",
        text: "Final",
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-1:assistant",
        text: " answer",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("streams Hermes' authoritative reasoning fallback when no deltas arrived", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-42" }],
            [2, "reasoning.available", { text: "Checked the evidence." }],
            [3, "message.complete", {}],
          ] as const)
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.ThoughtChunk,
        messageId: "message-42",
        text: "Checked the evidence.",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("prefers streamed reasoning without mixing in status or fallback text", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          for (const [seq, type, payload] of [
            [1, "message.start", { message_id: "message-42" }],
            [2, "thinking.delta", { text: "Musing…" }],
            [3, "reasoning.delta", { text: "Checked the evidence." }],
            [4, "reasoning.available", { text: "Fallback snapshot." }],
            [5, "message.delta", { text: "Draft" }],
            [6, "message.complete", { text: "Draft" }],
          ] as const)
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(ofKind(events, TurnEventKind.ThoughtChunk)).toEqual([
      {
        kind: TurnEventKind.ThoughtChunk,
        messageId: "message-42",
        text: "Checked the evidence.",
      },
    ])
    const kinds = eventKinds(events)
    expect(kinds.lastIndexOf(TurnEventKind.ThoughtChunk)).toBeLessThan(
      kinds.indexOf(TurnEventKind.MessageChunk)
    )
    expect(events.at(-2)).toMatchObject({ kind: TurnEventKind.MessageChunk })
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("streams one authorized user turn as turn lifecycle and text events", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "native-message-secret" },
          })
          publish({
            type: "message.delta",
            session_id: "live-secret",
            seq: 2,
            payload: { text: "Hi" },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const handle = await engine.start(scope, input())

    const events = await collect(handle)
    for (const event of events)
      expect(TurnEventSchema.safeParse(event).success).toBe(true)
    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "native-message-secret",
        text: "Hi",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("rejects browser-owned state, tools, context, and forwarded properties instead of forwarding them to Hermes", async () => {
    const submit = vi.fn(async () => ({
      acknowledgement: "accepted" as const,
      status: "streaming" as const,
    }))
    const engine = new HermesTurnEngine(runtime({ submit }))
    const tool = {
      name: "unsafe",
      description: "browser-selected tool",
      parameters: { type: "object", properties: {} },
    }

    for (const field of [
      { state: { hiddenInstruction: "trust me" } },
      { state: "hidden instruction" },
      { tools: [tool] },
      { context: [{ description: "role", value: "admin" }] },
      { forwardedProps: { provider: "hermes" } },
      { forwardedProps: "native override" },
    ])
      await expect(
        engine.start(scope, { ...input(), ...field })
      ).rejects.toThrow()
    expect(submit).not.toHaveBeenCalled()
  })

  it("pauses on a native Hermes request and resumes it without submitting a prompt", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const interrupt = pendingRequests()
    let submits = 0
    // Hermes' own watermark: the resumed run attaches after the first turn's
    // frames and continues their sequence.
    let watermark = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        onPendingRequest: interrupt.onPendingRequest,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: watermark }),
        submit: async () => {
          submits += 1
          interrupt.raise({
            requestId: "approval-1",
            kind: PendingRequestKind.Permission,
            message: "Continue?",
            responseSchema: { type: "string", enum: ["once", "deny"] },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
        respondInteractions: async (_scope, replies) => {
          expect(replies).toEqual([
            {
              requestId: "approval-1",
              status: "resolved",
              payload: "once",
            },
          ])
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 2,
            payload: { message_id: "continued" },
          })
          publish({
            type: "message.delta",
            session_id: "live-secret",
            seq: 3,
            payload: { text: "Done" },
          })
          publish({
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
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          {
            requestId: "approval-1",
            kind: PendingRequestKind.Permission,
            message: "Continue?",
            responseSchema: { type: "string", enum: ["once", "deny"] },
          },
        ],
      },
    ])

    watermark = 1
    await expect(
      collect(
        await engine.start(
          scope,
          replies("run-2", {
            requestId: "approval-1",
            status: ReplyStatus.Resolved,
            payload: "once",
          })
        )
      )
    ).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "continued",
        text: "Done",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
    expect(submits).toBe(1)
  })

  it("observes interrupts only while the run is attached to its Session", async () => {
    const attachment = observation()
    const interrupt = pendingRequests()
    const turn = nativeTurn()
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        onPendingRequest: interrupt.onPendingRequest,
      })
    )

    const handle = await engine.start(scope, input())
    expect(interrupt.subscribed()).toBe(1)

    attachment.publish("live-secret", turn.messageStart("msg-1"))
    attachment.publish("live-secret", turn.complete("msg-1", "Done"))
    attachment.publish("live-secret", turn.idle())
    await collect(handle)

    // The settling watcher keeps the native observation until Hermes reports
    // the Session idle; the interrupt subscription is released with it.
    await vi.waitFor(() => expect(interrupt.subscribed()).toBe(0))
  })

  it("streams a resumed interaction when Hermes continues without another message start", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const interrupt = pendingRequests()
    // Hermes' own watermark: the resumed run attaches after the first turn's
    // frames and continues their sequence.
    let watermark = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: watermark }),
        onPendingRequest: interrupt.onPendingRequest,
        submit: async () => {
          interrupt.raise({
            requestId: "question-1",
            kind: PendingRequestKind.Elicitation,
            message: "Answer whichever apply.",
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
        respondInteractions: async () => {
          publish({
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
          publish({
            type: "message.delta",
            session_id: "live-secret",
            seq: 3,
            payload: { text: "No answers selected." },
          })
          publish({
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
    watermark = 1
    const resumed = await collect(
      await engine.start(
        scope,
        replies("run-2", {
          requestId: "question-1",
          status: ReplyStatus.Cancelled,
        })
      )
    )

    expect(resumed).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "clarify-call",
        title: "question",
        name: "question",
        toolKind: ToolKind.Other,
        parentMessageId: "run-2:assistant",
      },
      {
        kind: TurnEventKind.ToolCallInputChunk,
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
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "clarify-call" },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "clarify-call",
        output: JSON.stringify({
          status: "cancelled",
          responses: [{ question: "Answer whichever apply.", answers: [] }],
        }),
        failed: false,
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-2:assistant",
        text: "No answers selected.",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  /**
   * A Session that asked one native question, then the run that answers it. The
   * resumed run attaches past the first turn's frames, so a test publishes
   * whatever Hermes does next through the returned `publish`.
   */
  async function resumedRun(
    overrides: Partial<HermesTurnNative> = {},
    options: { log?: HermesLog } = {}
  ) {
    const attachment = observation()
    const interrupt = pendingRequests()
    let watermark = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        onPendingRequest: interrupt.onPendingRequest,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: watermark }),
        submit: async () => {
          interrupt.raise({
            requestId: "question-1",
            kind: PendingRequestKind.Elicitation,
            message: "Which screenshot?",
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
        respondInteractions: async () => [{ status: "resolved" as const }],
        ...overrides,
      }),
      options
    )
    await collect(await engine.start(scope, input()))
    watermark = 1
    const handle = await engine.start(
      scope,
      replies("run-2", {
        requestId: "question-1",
        status: ReplyStatus.Resolved,
        payload: { answers: [["the first one"]] },
      })
    )
    return {
      handle,
      publish: (frame: unknown) => attachment.publish("live-secret", frame),
    }
  }

  it("ends a resumed interaction on Hermes' idle frame when its generation never completes", async () => {
    const { handle, publish } = await resumedRun()
    const turn = nativeTurn("live-secret", 2)

    // Hermes ran the answered tool and streamed the answer, then went idle
    // without a `message.complete` for the generation the answer resumed.
    publish(turn.toolStart("vision-1", "vision_analyze", { path: "shot.png" }))
    publish(turn.toolComplete("vision-1", "vision_analyze", "a bar chart"))
    publish(turn.delta("It is a bar chart."))
    publish(turn.idle())

    await expect(settledWithin(handle, 250)).resolves.toBe("settled")
    const events = await collect(handle)
    expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([])
    expect(ofKind(events, TurnEventKind.MessageChunk)).toEqual([
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-2:assistant",
        text: "It is a bar chart.",
      },
    ])
    expect(ofKind(events, TurnEventKind.TurnEnded)).toEqual([
      { kind: TurnEventKind.TurnEnded },
    ])
  })

  it("keeps a resumed interaction open when Hermes idles before the answer resumes its turn", async () => {
    const { handle, publish } = await resumedRun()
    const turn = nativeTurn("live-secret", 2)

    // The idle frame belongs to the wait the answer just ended, so the turn
    // Hermes then runs is still this run's.
    publish(turn.idle())
    publish(turn.messageStart("continued"))
    publish(turn.delta("The first one is a bar chart."))
    publish(turn.complete("continued", "The first one is a bar chart."))
    publish(turn.idle())

    await expect(settledWithin(handle, 250)).resolves.toBe("settled")
    const events = await collect(handle)
    expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([])
    expect(ofKind(events, TurnEventKind.TurnEnded)).toEqual([
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("reports a resumed interaction Hermes never ran as a failed run", async () => {
    const warn = vi.fn()
    const { handle, publish } = await resumedRun({}, { log: { warn } })

    // Nothing was published since the answer, and Hermes still reports itself
    // idle when the bounded re-read asks: no assistant turn ever ran.
    publish(nativeTurn("live-secret", 2).idle())

    // The verdict waits for the bounded re-read, not for the next Send.
    await expect(settledWithin(handle, 2_000)).resolves.toBe("settled")
    const events = await collect(handle)
    expect(ofKind(events, TurnEventKind.TurnEnded)).toEqual([])
    expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_RUN_FAILED",
        message: "Hermes could not complete this turn.",
      },
    ])
    expect(warn).toHaveBeenCalledWith(
      "hermes.turn.failed",
      expect.objectContaining({ failureReason: "resumed-turn-not-started" })
    )
  })

  it("reports an answer to a request Hermes no longer holds open as expired", async () => {
    const { handle } = await resumedRun({
      respondInteractions: async () => [{ status: "expired" as const }],
    })

    const events = await collect(handle)
    expect(ofKind(events, TurnEventKind.TurnEnded)).toEqual([])
    expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_INTERACTION_EXPIRED",
        message: "This Hermes interaction is no longer pending.",
      },
    ])
  })

  it("rejects non-standard top-level run fields instead of accepting provider payloads", async () => {
    const engine = new HermesTurnEngine(runtime())

    await expect(
      engine.start(scope, { ...input(), native: { method: "prompt.submit" } })
    ).rejects.toThrow()
  })

  it("terminalizes an uncertain acknowledgement without retrying or releasing admission", async () => {
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        // Hermes keeps working on the turn it may have accepted.
        status: async () => (submissions === 0 ? "idle" : "working"),
        submit: async () => {
          submissions += 1
          return { acknowledgement: "uncertain" as const }
        },
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes may have accepted this turn; reconcile before sending again.",
        code: "AOS_SEND_UNCERTAIN",
      },
    ])
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).rejects.toThrow("already active")
    expect(submissions).toBe(1)
  })

  it("terminalizes a definitive command rejection without marking delivery uncertain", async () => {
    const engine = new HermesTurnEngine(
      runtime({
        submit: async () => ({
          acknowledgement: "rejected" as const,
          reason: "unknown" as const,
        }),
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes rejected this command.",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("explains why a recognized slash command with attachments was rejected", async () => {
    const engine = new HermesTurnEngine(
      runtime({
        submit: async () => ({
          acknowledgement: "rejected" as const,
          reason: "command-with-attachments" as const,
        }),
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Slash commands cannot be sent with attachments.",
        code: "AOS_COMMAND_WITH_ATTACHMENTS",
      },
    ])
  })

  it("returns a composer prefill from a synchronous native command", async () => {
    const engine = new HermesTurnEngine(
      runtime({
        submit: async () => ({
          acknowledgement: "accepted" as const,
          status: "streaming" as const,
          completion: {
            output: "Undid 1 turn.",
            composerPrefill: "Earlier question",
          },
        }),
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      kind: TurnEventKind.TurnEnded,
      composerPrefill: "Earlier question",
    })
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "aos-command:run-1",
      text: "Undid 1 turn.",
    })
  })

  it("normalizes reasoning and complete tool calls as turn events", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({
              type,
              session_id: "live-secret",
              seq,
              payload,
            })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.ThoughtChunk,
        messageId: "message-42",
        text: "Consider",
      },
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "call-7",
        title: "delegate_subagent",
        name: "delegate_subagent",
        toolKind: ToolKind.Other,
        parentMessageId: "message-42",
      },
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "call-7",
        // A delegated subagent always carries a description, exactly as the
        // authoritative history projection records it.
        delta: '{"goal":"Inspect","description":"Inspect"}',
      },
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "call-7" },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "call-7",
        output: '{"ok":true}',
        failed: false,
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Done",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("streams authoritative Hermes Todos as one PLAN snapshot followed by deltas", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
                  todos: [
                    { id: "ship", content: "Ship", status: "in_progress" },
                  ],
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
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const activities = ofKind(events, TurnEventKind.PlanUpdated)

    expect(activities).toEqual([
      {
        kind: TurnEventKind.PlanUpdated,
        todos: [{ id: "ship", label: "Ship", status: "active" }],
      },
      {
        kind: TurnEventKind.PlanUpdated,
        todos: [{ id: "ship", label: "Ship", status: "completed" }],
      },
    ])
    for (const event of activities)
      expect(TurnEventSchema.safeParse(event).success).toBe(true)
  })

  it("streams a published artifact as the same safe AOS data part used by history", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "artifact-call",
      output: JSON.stringify({
        ok: true,
        type: "aos.artifact",
        artifact: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
        },
      }),
      failed: false,
    })
    expect(events).toContainEqual({
      kind: TurnEventKind.ArtifactPublished,
      artifact: {
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
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const [artifact] = ofKind(events, TurnEventKind.ArtifactPublished)

    expect(artifact).toMatchObject({
      kind: TurnEventKind.ArtifactPublished,
      artifact: {
        filename: "quick-brief.mp3",
        mimeType: "audio/mpeg",
      },
    })
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "message-media",
      text: "Your brief is ready.\n",
    })
    expect(JSON.stringify(events)).not.toContain("MEDIA:")
    expect(JSON.stringify(events)).not.toContain(audioPath)
    expect(JSON.stringify(events)).not.toContain(copiedPath)
    expect(JSON.stringify(events)).not.toContain("Media unavailable")
  })

  it("settles a tool before the run when Hermes loses its completion event", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events.slice(-3)).toEqual([
      {
        kind: TurnEventKind.ToolCallInputEnded,
        toolCallId: "call-lost-complete",
      },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "call-lost-complete",
        output: '{"status":"completed"}',
        failed: false,
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
    await expect(
      engine.start(scope, input({ turnId: "run-after-tool-recovery" }))
    ).resolves.toBeDefined()
  })

  it("keeps Stop pending until Hermes authoritatively reports idle", async () => {
    let interrupted = 0
    const engine = new HermesTurnEngine(
      runtime({
        interrupt: async () => {
          interrupted += 1
          return "interrupted" as const
        },
        status: async () => "idle",
      })
    )
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("idle")
    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.Cancelled },
    ])
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
    expect(interrupted).toBe(1)
  })

  it("settles a stopping run only when a later native idle event arrives", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    let interrupted = false
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        interrupt: async () => {
          interrupted = true
          return "interrupted" as const
        },
        status: async () => (interrupted ? "working" : "idle"),
      })
    )
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("stopping")
    publish({
      type: "session.info",
      session_id: "live-secret",
      seq: 1,
      payload: { running: false },
    })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.Cancelled },
    ])
  })

  it("rechecks an acknowledged Stop without interrupting Hermes twice", async () => {
    let interrupted = 0
    let statusChecks = 0
    const engine = new HermesTurnEngine(
      runtime({
        interrupt: async () => {
          interrupted += 1
          return "interrupted" as const
        },
        status: async () =>
          interrupted === 0 || ++statusChecks > 1 ? "idle" : "working",
      })
    )
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("stopping")
    await expect(handle.stop()).resolves.toBe("idle")
    expect(interrupted).toBe(1)
  })

  it("keeps the turn open after an advisory native error while Hermes is running", async () => {
    const log = { warn: vi.fn() }
    // The gate, then the one status read the advisory `error` frame triggers.
    const { engine, status, publish } = settlement(
      ["idle", "working"],
      {},
      {
        log,
      }
    )
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("message-42"))
    publish(turn.error("Could not switch model"))
    // Hermes answers the reconciling read before the turn continues.
    await new Promise((resolve) => setTimeout(resolve, 0))
    publish(turn.toolComplete("recovery-tool", "inspect", { success: true }))
    publish(turn.complete("message-42", "Recovered response"))
    publish(turn.idle())

    const events = await collect(handle)

    expect(status).toHaveBeenCalledTimes(2)
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: TurnEventKind.TurnFailed })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "recovery-tool",
      })
    )
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "message-42",
      text: "Recovered response",
    })
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
    expect(log.warn.mock.calls).toEqual([
      [
        "hermes.turn.native_error",
        expect.objectContaining({ verdict: "advisory", status: "working" }),
      ],
    ])
  })

  it("logs the native cause of the error frame that settled the turn", async () => {
    const log = { warn: vi.fn() }
    // The gate, then the advisory read that finds Hermes still working, then the
    // terminal one that finds it idle.
    const { engine, publish } = settlement(
      ["idle", "working", "idle"],
      {},
      { log }
    )
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("message-7"))
    publish(turn.error("advisory model switch rejected"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    publish(turn.error("terminal provider crash"))

    const events = await collect(handle)
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes could not complete this turn.\nterminal provider crash",
      code: "AOS_PROVIDER_RUN_FAILED",
    })
    expect(
      log.warn.mock.calls.filter(([event]) => event === "hermes.turn.failed")
    ).toEqual([
      [
        "hermes.turn.failed",
        expect.objectContaining({ nativeMessage: "terminal provider crash" }),
      ],
    ])
  })

  it("terminalizes a confirmed idle native failure with its bounded cause", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        status: async () => "idle",
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          publish({
            type: "error",
            session_id: "live-secret",
            seq: 2,
            payload: {
              message: "provider stream closed before the first token",
            },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes could not complete this turn.\nprovider stream closed before the first token",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("requires authoritative reconciliation when a replayed ring is truncated", async () => {
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        replay: async () => ({
          epoch: "epoch-1",
          lastSeen: 24,
          truncated: true,
          events: [],
        }),
        submit: async () => {
          submissions += 1
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const handle = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 20 },
    })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
    expect(submissions).toBe(0)
  })

  it("starts a new run without downloading Hermes retained replay", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: 328 }),
        replay: async () => {
          throw new Error("retained replay exceeds the transport limit")
        },
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 329,
            payload: { message_id: "message-43" },
          })
          publish({
            type: "message.delta",
            session_id: "live-secret",
            seq: 330,
            payload: { text: "Current" },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 331,
            payload: { text: "Current", status: "complete" },
          })
          return { acknowledgement: "accepted", status: "streaming" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-43",
        text: "Current",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("uses completed baseline events only as the cursor for a new turn", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: 3 }),
        replay: async () => ({
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
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 4,
            payload: { message_id: "message-43" },
          })
          publish({
            type: "message.delta",
            session_id: "live-secret",
            seq: 5,
            payload: { text: "Current" },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 6,
            payload: { text: "Current", status: "complete" },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-43",
        text: "Current",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("requires reconciliation when replayed recovery ordering is ambiguous", async () => {
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        replay: async () => ({
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
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(
      await engine.recover(scope, {
        threadId: scope.threadId,
        turnId: "run-1",
        position: { epoch: "epoch-1", lastSeen: 0 },
      })
    )

    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message:
        "Hermes history must be reconciled before this turn can continue.",
      code: "AOS_RESET_REQUIRED",
    })
    expect(submissions).toBe(0)
  })

  it("replays missed events from the same Hermes epoch before buffered live events", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId: string, after: number) => {
          expect(after).toBe(10)
          publish({
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
      turnId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 10 },
    })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Recovered",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("drops oversized native stream deltas at the provider boundary", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          publish({
            type: "message.delta",
            session_id: "live-secret",
            seq: 2,
            payload: { text: "x".repeat(1_048_577) },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("rejects an oversized user turn before opening a native Session", async () => {
    const engine = new HermesTurnEngine(runtime())

    await expect(
      engine.start(scope, input({ prompt: "x".repeat(1_048_577) }))
    ).rejects.toThrow("user turn is too large")
  })

  it("admits at most one concurrent run for an Agent and Session scope", async () => {
    let releaseResume: (() => void) | undefined
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve
    })
    const engine = new HermesTurnEngine(
      runtime({
        resume: async () => {
          await resumeGate
          return { liveSessionId: "live-secret", running: false }
        },
      })
    )

    const first = engine.start(scope, input())
    const second = engine.start(scope, input({ turnId: "run-2" }))
    releaseResume?.()

    await expect(first).resolves.toBeDefined()
    await expect(second).rejects.toThrow("already active")
  })

  it("releases admission when native setup fails before the run is attached", async () => {
    let attempts = 0
    const engine = new HermesTurnEngine(
      runtime({
        resume: async () => {
          attempts += 1
          if (attempts === 1) throw new Error("temporary outage")
          return { liveSessionId: "live-secret", running: false }
        },
      })
    )

    await expect(engine.start(scope, input())).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("classifies a lost submit response as uncertain without exposing or retrying it", async () => {
    let attempts = 0
    const engine = new HermesTurnEngine(
      runtime({
        submit: async () => {
          attempts += 1
          return { acknowledgement: "uncertain" as const }
        },
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes may have accepted this turn; reconcile before sending again.",
        code: "AOS_SEND_UNCERTAIN",
      },
    ])
    expect(attempts).toBe(1)
  })

  it("reports a native connection interruption without stopping the Hermes run", async () => {
    const attachment = observation()
    let interrupts = 0
    let submitted = false
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        // The interrupted run is still Hermes' current turn.
        status: async () => (submitted ? "working" : "idle"),
        submit: async () => {
          submitted = true
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
        interrupt: async () => {
          interrupts += 1
          return "interrupted" as const
        },
      })
    )
    const handle = await engine.start(scope, input())

    attachment.signal("live-secret", { kind: "lost", reason: "disconnected" })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "The Hermes connection was interrupted; reconnect to reconcile this turn.",
        code: "AOS_CONNECTION_INTERRUPTED",
      },
    ])
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).rejects.toThrow("already active")
    expect(interrupts).toBe(0)
  })

  it("exposes only the server-side epoch and sequence needed to seal a reconnect cursor", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        cursor: async () => ({ epoch: "epoch-7", latestSeq: 40 }),
      })
    )
    const handle = await engine.start(scope, input())
    publish({
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

  it("reattaches an interrupted active turn and replays without resubmitting the prompt", async () => {
    const attachment = observation()
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId: string, after: number) => {
          expect(after).toBe(0)
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
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )
    const first = await engine.start(scope, input())
    const position = first.recoveryPosition()
    attachment.signal("live-secret", { kind: "lost", reason: "disconnected" })

    const resumed = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-1",
      position,
    })

    await expect(collect(resumed)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Recovered",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
    expect(submissions).toBe(1)
  })

  it("reconstructs an active run from authoritative Hermes recovery after proxy restart", async () => {
    const attachment = observation()
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        status: async () => "working",
        replay: async (_liveSessionId, after) => {
          expect(after).toBe(0)
          return {
            epoch: "epoch-after-restart",
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
                payload: { text: "Recovered" },
              },
            ],
          }
        },
        submit: async () => {
          submissions += 1
          return { acknowledgement: "accepted", status: "streaming" }
        },
      })
    )

    const resumed = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "restored-run",
    })
    attachment.publish("live-secret", {
      type: "message.complete",
      session_id: "live-secret",
      seq: 3,
      payload: {},
    })

    await expect(collect(resumed)).resolves.toMatchObject([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.MessageChunk, text: "Recovered" },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
    expect(submissions).toBe(0)
  })

  it("does not expose browser transport disconnect controls", async () => {
    let interrupts = 0
    const engine = new HermesTurnEngine(
      runtime({
        interrupt: async () => {
          interrupts += 1
          return "interrupted" as const
        },
      })
    )
    const handle = await engine.start(scope, input())

    expect("disconnect" in handle).toBe(false)
    expect(interrupts).toBe(0)
  })

  it("completes a known tool when Hermes omits its repeated name", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "call-7",
      output: '"contents"',
      failed: false,
    })
  })

  it("projects bounded inspectable tool data while redacting credentials and provider metadata", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallInputChunk,
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
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "call-7",
      output: JSON.stringify({
        status: "ok",
        sourceUrl: "https://provider.invalid/private",
        filesystem_path: "/srv/private/result.txt",
        access_token: "[REDACTED]",
        summary: "[REDACTED]",
      }),
      failed: false,
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
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          for (const [index, query] of [...credentials, safe].entries())
            publish({
              type: "tool.start",
              session_id: "live-secret",
              seq: index + 2,
              payload: {
                tool_id: `call-${index}`,
                name: "search",
                args: { query },
              },
            })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: credentials.length + 3,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const argumentDeltas = ofKind(events, TurnEventKind.ToolCallInputChunk).map(
      (event) => (event as { delta: string }).delta
    )

    expect(argumentDeltas).toEqual([
      ...credentials.map(() => '{"query":"[REDACTED]"}'),
      JSON.stringify({ query: safe }),
    ])
    for (const credential of credentials)
      expect(JSON.stringify(events)).not.toContain(credential)
  })

  it("bounds multibyte and deeply nested tool output", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          publish({
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
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    const args = events.find(
      (event) => event.kind === TurnEventKind.ToolCallInputChunk
    )
    const result = events.find(
      (event) => event.kind === TurnEventKind.ToolCallFinished
    )

    expect(args?.kind).toBe(TurnEventKind.ToolCallInputChunk)
    if (args?.kind !== TurnEventKind.ToolCallInputChunk)
      throw new Error("missing args")
    expect(args.delta).toContain("[Truncated]")
    expect(args.delta).not.toContain("\\ud83d")
    expect(result).toMatchObject({
      output: expect.stringContaining("[Truncated]"),
    })
  })

  it("treats a failed message completion as a turn error with its cause", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 1,
            payload: {
              status: "error",
              error: "provider rejected the request",
            },
          })
          publish({
            type: "session.info",
            session_id: "live-secret",
            seq: 2,
            payload: { running: false },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes could not complete this turn.\nprovider rejected the request",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("keeps Hermes partial output visible when message completion fails", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 1,
            payload: {
              message_id: "partial-reply",
              text: "The completed response retained by Hermes",
              status: "error",
              error: "provider rejected the request",
              partial: true,
              recoverable: true,
            },
          })
          publish({
            type: "session.info",
            session_id: "live-secret",
            seq: 2,
            payload: { running: false },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "partial-reply",
        text: "The completed response retained by Hermes",
      },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes could not complete this turn.\nprovider rejected the request",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("appends Hermes terminal output after a streamed partial failure", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "partial-reply" },
          })
          publish({
            type: "message.delta",
            session_id: "live-secret",
            seq: 2,
            payload: { text: "Retained while streaming" },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {
              message_id: "partial-reply",
              text: "Retained while streaming and at completion",
              status: "error",
              error: "provider rejected the request",
              partial: true,
            },
          })
          publish({
            type: "session.info",
            session_id: "live-secret",
            seq: 4,
            payload: { running: false },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "partial-reply",
        text: "Retained while streaming",
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "partial-reply",
        text: " and at completion",
      },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes could not complete this turn.\nprovider rejected the request",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("keeps the turn open across a failed tool, interim text, and recovered tools", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "failed-attempt" },
          })
          publish({
            type: "tool.complete",
            session_id: "live-secret",
            seq: 2,
            payload: {
              tool_id: "failed-tool",
              name: "use_skill",
              args: { name: "missing" },
              result: { success: false, error: "Skill not found" },
              is_error: true,
            },
          })
          publish({
            type: "message.interim",
            session_id: "live-secret",
            seq: 3,
            payload: {
              text: "The first call failed. I will split the work.",
              already_streamed: false,
            },
          })
          publish({
            type: "tool.complete",
            session_id: "live-secret",
            seq: 4,
            payload: {
              tool_id: "recovery-tool-1",
              name: "web_extract",
              args: { url: "https://example.com" },
              result: { success: true },
            },
          })
          publish({
            type: "tool.complete",
            session_id: "live-secret",
            seq: 5,
            payload: {
              tool_id: "recovery-tool-2",
              name: "execute_code",
              args: { code: "return true" },
              result: { success: true },
            },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 6,
            payload: {
              text: "Recovered after splitting the work.",
              status: "complete",
            },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(
      events.filter((event) => event.kind === TurnEventKind.ToolCallFinished)
    ).toHaveLength(3)
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: TurnEventKind.TurnFailed })
    )
    const failedTool = events.findIndex(
      (event) =>
        event.kind === TurnEventKind.ToolCallFinished &&
        event.toolCallId === "failed-tool"
    )
    const interim = events.findIndex(
      (event) =>
        event.kind === TurnEventKind.MessageChunk &&
        event.text === "The first call failed. I will split the work."
    )
    const recoveredTool = events.findIndex(
      (event) =>
        event.kind === TurnEventKind.ToolCallStarted &&
        event.toolCallId === "recovery-tool-1"
    )
    const finalText = events.findIndex(
      (event) =>
        event.kind === TurnEventKind.MessageChunk &&
        event.text === "Recovered after splitting the work."
    )
    const finished = events.findIndex(
      (event) => event.kind === TurnEventKind.TurnEnded
    )

    expect(failedTool).toBeGreaterThan(-1)
    expect(interim).toBeGreaterThan(failedTool)
    expect(recoveredTool).toBeGreaterThan(interim)
    expect(finalText).toBeGreaterThan(recoveredTool)
    expect(finished).toBeGreaterThan(finalText)
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
    expect(
      events.filter((event) => event.kind === TurnEventKind.TurnEnded)
    ).toHaveLength(1)
  })

  it("seals already-streamed interim text without duplicating it", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
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
            payload: { text: "Checking the next boundary." },
          })
          publish({
            type: "message.interim",
            session_id: "live-secret",
            seq: 3,
            payload: {
              text: "Checking the next boundary.",
              already_streamed: true,
            },
          })
          publish({
            type: "tool.complete",
            session_id: "live-secret",
            seq: 4,
            payload: {
              tool_id: "tool-after-interim",
              name: "verify",
              args: {},
              result: { success: true },
            },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 5,
            payload: { text: "Final answer", status: "complete" },
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    expect(
      events.filter((event) => event.kind === TurnEventKind.MessageChunk)
    ).toEqual([
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "reply",
        text: "Checking the next boundary.",
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "run-1:assistant:2",
        text: "Final answer",
      },
    ])
    expect(
      events.findIndex(
        (event) =>
          event.kind === TurnEventKind.MessageChunk &&
          event.text === "Checking the next boundary."
      )
    ).toBeLessThan(
      events.findIndex(
        (event) =>
          event.kind === TurnEventKind.ToolCallStarted &&
          event.toolCallId === "tool-after-interim"
      )
    )
  })

  it("rejects unstaged multimodal content instead of silently dropping it", async () => {
    const engine = new HermesTurnEngine(runtime())

    // The turn input schema admits text parts only, so the engine refuses the
    // turn before any native submission: staged media arrives as text instead.
    await expect(
      engine.start(scope, {
        ...input(),
        prompt: [
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
      })
    ).rejects.toThrow()
  })

  it("does not submit when Hermes authoritatively reports the Session busy", async () => {
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        status: async () => "working",
        submit: async () => {
          submissions += 1
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes is already running this Session.",
        code: "AOS_SESSION_BUSY",
      },
    ])
    expect(submissions).toBe(0)
  })

  it("submits the authorized turn while Hermes reports the Session starting or absent", async () => {
    // Only `working` and `waiting` are authoritatively busy: a Session that is
    // still building its Agent, or that Hermes has not materialized yet, still
    // accepts the turn.
    for (const status of ["starting", "absent"] as const) {
      const prompts: string[] = []
      const engine = new HermesTurnEngine(
        runtime({
          status: async () => status,
          submit: async (_liveSessionId, prompt) => {
            prompts.push(prompt.text)
            return { acknowledgement: "accepted", status: "streaming" }
          },
        })
      )

      const handle = await engine.start(scope, input())

      expect(prompts).toEqual(["Hello Hermes"])
      expect(handle.recoveryPosition()).toEqual({
        epoch: "epoch-1",
        lastSeen: 0,
      })
    }
  })

  it("discovers and reattaches a running Hermes Session after proxy restart", async () => {
    let observations = 0
    const engine = new HermesTurnEngine(
      runtime({
        inspectExecution: async () => ({
          running: true,
          status: "running" as const,
        }),
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

  it("discovers a pending Hermes interaction as a pending request", async () => {
    const interrupt = {
      requestId: "question-1",
      kind: PendingRequestKind.Elicitation,
      message: "Choose",
      responseSchema: { type: "string", enum: ["yes", "no"] },
    }
    const engine = new HermesTurnEngine(
      runtime({
        inspectExecution: async () => ({
          running: false,
          status: "waiting-for-input" as const,
          requests: [interrupt],
        }),
      })
    )

    const discovered = await engine.discover(scope, "recovered-question")

    expect(discovered?.state).toBe("waiting-for-input")
    expect(discovered?.requests).toEqual([interrupt])
    // A restored wait was never streamed, so it names no position: a fabricated
    // one would force the next recovery to reset.
    expect(discovered?.handle.recoveryPosition()).toBeUndefined()
    await expect(collect(discovered!.handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnRequiresAction, requests: [interrupt] },
    ])
  })

  /** A discovered turn Hermes holds `waiting` on a question it asked AOS. */
  function waitingOnQuestion(
    overrides: Partial<HermesTurnNative> = {},
    options: { lostInteractionGraceMs?: number } = {}
  ) {
    const ring = nativeTurn("live-secret", 1)
    const retained = [
      ring.messageStart("question-turn"),
      ring.delta("Before I continue, I need one answer."),
      ring.toolStart("clarify-1", "clarify", { question: "Which branch?" }),
    ]
    const native: { status: HermesNativeStatus } = { status: "waiting" }
    const interrupted: string[] = []
    const submitted: string[] = []
    const questions = pendingRequests()
    const engine = new HermesTurnEngine(
      runtime({
        inspectExecution: async () => ({ running: true, status: "running" }),
        replay: async () => ({
          epoch: "epoch-1",
          lastSeen: 3,
          events: retained,
        }),
        cursor: async () => ({ epoch: "epoch-1", latestSeq: 3 }),
        status: async () => native.status,
        interrupt: async (liveSessionId) => {
          interrupted.push(liveSessionId)
          native.status = "idle"
          return "interrupted"
        },
        submit: async (_liveSessionId, prompt) => {
          submitted.push(prompt.text)
          return { acknowledgement: "accepted", status: "streaming" }
        },
        onPendingRequest: questions.onPendingRequest,
        ...overrides,
      }),
      options
    )
    return { engine, interrupted, submitted, questions }
  }

  it("reports a question Hermes no longer re-delivers and keeps the turn stoppable", async () => {
    vi.useFakeTimers()
    try {
      const { engine, interrupted, submitted } = waitingOnQuestion()
      const discovered = await engine.discover(scope, "recovered-run")
      expect(discovered?.state).toBe("running")
      const events: unknown[] = []
      const reading = (async () => {
        for await (const event of discovered!.handle.events) events.push(event)
      })()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([
        {
          kind: TurnEventKind.TurnFailed,
          code: "AOS_INTERACTION_LOST",
          message:
            "This Session is waiting on a question that can no longer be answered here. Stop the turn to continue.",
          awaitingStop: true,
        },
      ])
      expect(ofKind(events, TurnEventKind.TurnEnded)).toEqual([])

      await expect(discovered!.handle.stop()).resolves.toBe("idle")
      await reading
      expect(interrupted).toEqual(["live-secret"])
      expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })

      // Stop settled the native turn, so the Session takes the next prompt.
      await engine.start(scope, input({ turnId: "run-2" }))
      expect(submitted).toEqual(["Hello Hermes"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports no lost question when Hermes re-delivers it within the grace", async () => {
    vi.useFakeTimers()
    try {
      const { engine, questions } = waitingOnQuestion()
      const discovered = await engine.discover(scope, "recovered-run")
      const events: unknown[] = []
      const reading = (async () => {
        for await (const event of discovered!.handle.events) events.push(event)
      })()
      const question = {
        requestId: "question-1",
        kind: PendingRequestKind.Elicitation,
        message: "Which branch?",
        responseSchema: { type: "string" },
      }

      await vi.advanceTimersByTimeAsync(1_000)
      questions.raise(question)
      await vi.advanceTimersByTimeAsync(2_000)
      await reading

      expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([])
      expect(events.at(-1)).toEqual({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [question],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports no lost question for a discovered turn Hermes is still working on", async () => {
    vi.useFakeTimers()
    try {
      const { engine } = waitingOnQuestion({ status: async () => "working" })
      const discovered = await engine.discover(scope, "recovered-run")
      const events: unknown[] = []
      void (async () => {
        for await (const event of discovered!.handle.events) events.push(event)
      })()

      await vi.advanceTimersByTimeAsync(2_000)

      expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("classifies a changed Hermes replay epoch as reset-required", async () => {
    const engine = new HermesTurnEngine(
      runtime({
        replay: async () => ({
          epoch: "epoch-2",
          lastSeen: 11,
          events: [],
        }),
      })
    )

    const handle = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 10 },
    })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
  })

  it("ignores malformed, cross-Session, and duplicate native events", async () => {
    const attachment = observation()
    const cursors: number[] = []
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-42")
    const delta = turn.delta("Hello")
    const unreadableText = turn.frame("message.delta", {
      text: { native: "payload" },
    })
    const complete = turn.complete("message-42", "Hello")
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId, after) => {
          cursors.push(after)
          return { epoch: "epoch-1", lastSeen: 2, events: [start, delta] }
        },
      })
    )

    const handle = await engine.start(scope, input())
    // Another live Session's frame never belongs to this run.
    attachment.publish("live-secret", {
      ...start,
      session_id: "other-live-session",
    })
    // An unreadable sequence is dropped, so the stream skips frame 1 and the
    // run must read Hermes' ring once instead of accepting frame 2 as the next.
    attachment.publish("live-secret", { ...start, seq: "1" })
    attachment.publish("live-secret", delta)
    attachment.publish("live-secret", delta)
    attachment.publish("live-secret", unreadableText)
    attachment.publish("live-secret", complete)

    const events = await collect(handle)
    expect(cursors).toEqual([0])
    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Hello",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("unwraps Hermes tool-search bridge calls into the selected tool", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
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
            publish({ type, session_id: "live-secret", seq, payload })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: "call-7",
      title: "read_file",
      name: "read_file",
      toolKind: ToolKind.Read,
      parentMessageId: "message-42",
    })
    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallInputChunk,
      toolCallId: "call-7",
      delta: '{"path":"report.txt"}',
    })
  })

  it("releases reconnect admission and observation when native recovery setup fails", async () => {
    let attempts = 0
    let unsubscribes = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: async () => () => {
          unsubscribes += 1
        },
        replay: async () => {
          attempts += 1
          if (attempts === 1) throw new Error("recovery unavailable")
          return { epoch: "epoch-1", lastSeen: 0, events: [] }
        },
      })
    )
    const request = {
      threadId: scope.threadId,
      turnId: "run-1",
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
    const engine = new HermesTurnEngine(
      runtime({
        resume: async () => {
          resumes += 1
          if (resumes === 2) throw new Error("reattach unavailable")
          return { liveSessionId: "live-secret", running: false }
        },
      })
    )
    const first = await engine.start(scope, input())
    expect("disconnect" in first).toBe(false)
    expect(resumes).toBe(1)
  })

  it("releases an uncertain-send fence only after authoritative native idle", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          submissions += 1
          return submissions === 1
            ? { acknowledgement: "uncertain" as const }
            : {
                acknowledgement: "accepted" as const,
                status: "streaming" as const,
              }
        },
      })
    )
    await engine.start(scope, input())

    publish({
      type: "session.info",
      session_id: "live-secret",
      seq: 1,
      payload: { running: false },
    })

    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("rejects an oversized native recovery batch as reset-required", async () => {
    const engine = new HermesTurnEngine(
      runtime({
        replay: async () => ({
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
      turnId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 0 },
    })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
  })

  it("releases an attached admission when the authoritative idle check fails", async () => {
    let statuses = 0
    let unsubscribes = 0
    const engine = new HermesTurnEngine(
      runtime({
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
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
    expect(unsubscribes).toBe(1)
  })

  it("does not disclose native setup, reconnect, or Stop failures", async () => {
    const setup = new HermesTurnEngine(
      runtime({
        resume: async () => {
          throw new Error("bearer setup-secret")
        },
      })
    )
    await expect(setup.start(scope, input())).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })

    const reconnect = new HermesTurnEngine(
      runtime({
        replay: async () => {
          throw new Error("cookie reconnect-secret")
        },
      })
    )
    await expect(
      reconnect.recover(scope, {
        threadId: scope.threadId,
        turnId: "run-1",
        position: { epoch: "epoch-1", lastSeen: 0 },
      })
    ).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })

    const stopping = new HermesTurnEngine(
      runtime({
        interrupt: async () => {
          throw new Error("native stop-secret")
          return "interrupted" as const
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
    const engine = new HermesTurnEngine(
      runtime({
        observe: async (_liveSessionId, observer) => {
          for (let seq = 1; seq <= 4_097; seq += 1)
            observer({
              kind: "event",
              event: {
                type: "message.delta",
                session_id: "live-secret",
                seq,
                payload: { text: "x" },
              },
            })
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
    expect(submissions).toBe(0)
  })

  it("bounds bytes buffered before the active run is established", async () => {
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: async (_liveSessionId, observer) => {
          observer({
            kind: "event",
            event: {
              type: "message.delta",
              session_id: "live-secret",
              seq: 1,
              payload: { text: "x".repeat(4_194_305) },
            },
          })
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events.at(-1)).toMatchObject({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_RESET_REQUIRED",
    })
    expect(submissions).toBe(0)
  })

  it("counts lone-surrogate JSON escaping in recovery and pre-active budgets", async () => {
    const chunk = "\ud800".repeat(340_000)
    const recovered = new HermesTurnEngine(
      runtime({
        replay: async () => ({
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

    expect(
      await collect(
        await recovered.recover(scope, {
          threadId: scope.threadId,
          turnId: "run-1",
          position: { epoch: "epoch-1", lastSeen: 0 },
        })
      )
    ).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])

    let submissions = 0
    const preActive = new HermesTurnEngine(
      runtime({
        observe: async (_liveSessionId, observer) => {
          for (let seq = 1; seq <= 4; seq += 1)
            observer({
              kind: "event",
              event: {
                type: "message.delta",
                session_id: "live-secret",
                seq,
                payload: { text: chunk },
              },
            })
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          return { acknowledgement: "uncertain" as const }
        },
      })
    )

    expect(await collect(await preActive.start(scope, input()))).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
    expect(submissions).toBe(0)
  })

  it("accepts one bounded lone-surrogate native frame but limits unread serialized events cumulatively", async () => {
    const chunk = "\ud800".repeat(340_000)
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
      })
    )
    const handle = await engine.start(scope, input())
    const iterator = handle.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: TurnEventKind.TurnStarted },
    })
    publish({
      type: "message.start",
      session_id: "live-secret",
      seq: 1,
      payload: { message_id: "message-42" },
    })
    publish({
      type: "message.delta",
      session_id: "live-secret",
      seq: 2,
      payload: { text: chunk },
    })
    const content = iterator.next()
    await expect(content).resolves.toMatchObject({
      value: { kind: TurnEventKind.MessageChunk, text: chunk },
    })
    const unreadAttachment = observation()
    const publishUnread = (event: unknown) =>
      unreadAttachment.publish("live-secret", event)
    const unread = new HermesTurnEngine(
      runtime({
        observe: unreadAttachment.observe,
        submit: async () => {
          publishUnread({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          for (let seq = 2; seq <= 5; seq += 1)
            publishUnread({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: chunk },
            })
          publishUnread({
            type: "message.complete",
            session_id: "live-secret",
            seq: 6,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    expect(await collect(await unread.start(scope, input()))).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes produced more events than AOS can safely buffer.",
        code: "AOS_STREAM_OVERFLOW",
      },
    ])
  })

  it("ignores unrelated live events before traversing their provider payloads", async () => {
    let payloadReads = 0
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
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
          publish(unrelated)
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 1,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(payloadReads).toBe(0)
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("ignores unrelated pre-active events without consuming the Session buffer", async () => {
    let payloadReads = 0
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: async (liveSessionId: string, observer) => {
          await attachment.observe(liveSessionId, observer)
          observer({
            kind: "event",
            event: {
              type: "message.delta",
              session_id: "another-live-session",
              seq: 1,
              payload: { text: "\ud800".repeat(800_000) },
            },
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
          for (let count = 0; count < 4_100; count += 1)
            observer({ kind: "event", event: unrelated })
          return () => undefined
        },
        submit: async () => {
          submissions += 1
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 1,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(payloadReads).toBe(0)
    expect(submissions).toBe(1)
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("bounds unread turn events and terminalizes overflow", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          for (let seq = 2; seq <= 4_100; seq += 1)
            publish({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: "x" },
            })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events[0]).toEqual({ kind: TurnEventKind.TurnStarted })
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })
    expect(events).toHaveLength(2)
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
  })

  it("never submits a stale first start after its terminal event admits a second run", async () => {
    const attachment = observation()
    const submitted: string[] = []
    let resumes = 0
    let releaseFirstStatus: (() => void) | undefined
    let markFirstStatusEntered: (() => void) | undefined
    const firstStatusEntered = new Promise<void>((resolve) => {
      markFirstStatusEntered = resolve
    })
    const engine = new HermesTurnEngine(
      runtime({
        resume: async () => ({
          liveSessionId: `live-${++resumes}`,
          running: false,
        }),
        observe: attachment.observe,
        status: async (liveSessionId) => {
          // Only the first run's own gate is held open; later reads (the
          // settling watcher, the second run's gate) answer immediately.
          if (
            liveSessionId !== "live-1" ||
            markFirstStatusEntered === undefined
          )
            return "idle"
          markFirstStatusEntered()
          markFirstStatusEntered = undefined
          await new Promise<void>((resolve) => {
            releaseFirstStatus = resolve
          })
          return "idle"
        },
        submit: async (liveSessionId) => {
          submitted.push(liveSessionId)
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const firstStart = engine.start(scope, input())
    await firstStatusEntered
    attachment.publish("live-1", {
      type: "message.complete",
      session_id: "live-1",
      seq: 1,
      payload: {},
    })
    const second = await engine.start(scope, input({ turnId: "run-2" }))
    releaseFirstStatus?.()
    const first = await firstStart

    expect(submitted).toEqual(["live-2"])
    await expect(collect(first)).resolves.toContainEqual({
      kind: TurnEventKind.TurnEnded,
      stopReason: StopReason.EndTurn,
    })
    attachment.publish("live-2", {
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
      const attachment = observation()
      const publish = (event: unknown) =>
        attachment.publish("live-secret", event)
      const disconnect = () =>
        attachment.signal("live-secret", {
          kind: "lost",
          reason: "disconnected",
        })
      let submissions = 0
      let releaseStatus: (() => void) | undefined
      let markStatusEntered: (() => void) | undefined
      const statusEntered = new Promise<void>((resolve) => {
        markStatusEntered = resolve
      })
      const engine = new HermesTurnEngine(
        runtime({
          observe: attachment.observe,
          status: async () => {
            markStatusEntered?.()
            await new Promise<void>((resolve) => {
              releaseStatus = resolve
            })
            return "idle"
          },
          submit: async () => {
            submissions += 1
            return {
              acknowledgement: "accepted" as const,
              status: "streaming" as const,
            }
          },
        })
      )

      const started = engine.start(scope, input())
      await statusEntered
      if (mode === "interrupted") disconnect()
      else {
        publish({
          type: "message.start",
          session_id: "live-secret",
          seq: 1,
          payload: { message_id: "message-42" },
        })
        for (let seq = 2; seq <= 4_100; seq += 1)
          publish({
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

  it("enforces cumulative byte budgets for recovery and unread turn events", async () => {
    const chunk = "🙂".repeat(250_000)
    const recovery = new HermesTurnEngine(
      runtime({
        replay: async () => ({
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
    const recovered = await collect(
      await recovery.recover(scope, {
        threadId: scope.threadId,
        turnId: "run-1",
        position: { epoch: "epoch-1", lastSeen: 0 },
      })
    )
    expect(recovered).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])

    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const live = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "message.start",
            session_id: "live-secret",
            seq: 1,
            payload: { message_id: "message-42" },
          })
          for (let seq = 2; seq <= 6; seq += 1)
            publish({
              type: "message.delta",
              session_id: "live-secret",
              seq,
              payload: { text: chunk },
            })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 7,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )
    const streamed = await collect(await live.start(scope, input()))
    expect(streamed).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes produced more events than AOS can safely buffer.",
        code: "AOS_STREAM_OVERFLOW",
      },
    ])
  })

  it("projects a wide provider tool result instead of refusing it for its item count", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          const turn = nativeTurn("live-secret", 1)
          publish(turn.messageStart("message-42"))
          publish(
            turn.toolComplete("call-7", "search", {
              items: Array.from(
                { length: 3_000 },
                (_, index) => `row-${index}`
              ),
              text: "x".repeat(1_024),
            })
          )
          publish(turn.complete("message-42", "Done"))
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    // An ordinary wide result is far below the 4 MiB frame bound: the run
    // projects it (the projection truncates for public output) and finishes.
    expect(ofKind(events, TurnEventKind.ToolCallFinished)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("refuses a native frame past the frame byte bound", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          const turn = nativeTurn("live-secret", 1)
          publish(turn.messageStart("message-42"))
          publish(turn.delta("x".repeat(4_194_305)))
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    expect(await collect(await engine.start(scope, input()))).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes produced more events than AOS can safely buffer.",
        code: "AOS_STREAM_OVERFLOW",
      },
    ])
  })

  it("terminalizes an overflow that arrives while the reader is parked", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({ observe: attachment.observe })
    )
    const handle = await engine.start(scope, input())
    const iterator = handle.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: TurnEventKind.TurnStarted },
    })
    // The coordinator's normal state: parked in `next()` with nothing queued.
    const parked = iterator.next()

    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("message-42"))
    publish(turn.delta("x".repeat(4_194_305)))

    await expect(parked).resolves.toEqual({
      done: false,
      value: {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes produced more events than AOS can safely buffer.",
        code: "AOS_STREAM_OVERFLOW",
      },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it("projects validated Hermes usage onto the standard terminal event", async () => {
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
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
          publish({
            type: "session.info",
            session_id: "live-secret",
            seq: 2,
            payload: { usage: { model: "invalid", input: -1, output: 99 } },
          })
          publish({
            type: "message.complete",
            session_id: "live-secret",
            seq: 3,
            payload: {},
          })
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))
    for (const event of events)
      expect(TurnEventSchema.safeParse(event).success).toBe(true)
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnEnded,
      stopReason: StopReason.EndTurn,
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
    const attachment = observation()
    const publish = (event: unknown) => attachment.publish("live-secret", event)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          publish({
            type: "session.info",
            session_id: "live-secret",
            seq: 1,
            payload: {
              usage: { model: "live-model", input: 3, output: 2, total: 5 },
            },
          })
          publish({
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
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )

    const events = await collect(await engine.start(scope, input()))

    expect(events.at(-1)).toMatchObject({
      kind: TurnEventKind.TurnEnded,
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

  it("replays only the open native turn when a running Session is discovered", async () => {
    const attachment = observation()
    const ring = nativeTurn("live-secret", 1)
    const retained = [
      ring.messageStart("old-message"),
      ring.delta("old"),
      ring.complete("old-message", "old", "error"),
      ring.idle(),
      ring.messageStart("new-message"),
      ring.delta("new"),
    ]
    const cursors: number[] = []
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        inspectExecution: async () => ({ running: true, status: "running" }),
        status: async () => "working",
        replay: async (_liveSessionId, after) => {
          cursors.push(after)
          return { epoch: "epoch-1", lastSeen: 6, events: retained }
        },
      })
    )

    const discovered = await engine.discover(scope, "recovered-run")
    expect(discovered?.state).toBe("running")
    attachment.publish(
      "live-secret",
      ring.complete("new-message", "new", "complete")
    )
    attachment.publish("live-secret", ring.idle())

    await expect(collect(discovered!.handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "new-message",
        text: "new",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
    expect(cursors).toEqual([0])
  })

  it("requires reconciliation when a discovered idle Session has no open turn", async () => {
    const closed = nativeTurn("live-secret", 1)
    const engine = new HermesTurnEngine(
      runtime({
        inspectExecution: async () => ({ running: true, status: "running" }),
        status: async () => "idle",
        replay: async () => ({
          epoch: "epoch-1",
          lastSeen: 3,
          events: [
            closed.messageStart("old-message"),
            closed.delta("old"),
            closed.complete("old-message", "old", "complete"),
          ],
        }),
      })
    )

    const discovered = await engine.discover(scope, "recovered-run")

    await expect(collect(discovered!.handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
  })

  it("observes from the live cursor when a running discovered ring closed its last turn", async () => {
    const attachment = observation()
    const closed = nativeTurn("live-secret", 1)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        inspectExecution: async () => ({ running: true, status: "running" }),
        status: async () => "working",
        cursor: async () => ({ epoch: "epoch-1", latestSeq: 42 }),
        replay: async () => ({
          epoch: "epoch-1",
          lastSeen: 3,
          events: [
            closed.messageStart("old-message"),
            closed.delta("old"),
            closed.complete("old-message", "old", "complete"),
          ],
        }),
      })
    )

    const discovered = await engine.discover(scope, "recovered-run")
    const live = nativeTurn("live-secret", 43)
    attachment.publish("live-secret", live.messageStart("new-message"))
    attachment.publish("live-secret", live.delta("new"))
    attachment.publish("live-secret", live.complete("new-message", "new"))

    const events = await collect(discovered!.handle)
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "new-message",
      text: "new",
    })
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
    expect(JSON.stringify(events)).not.toContain("old")
  })

  it("catches up once from the run cursor when the socket reattaches", async () => {
    const attachment = observation()
    const cursors: number[] = []
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-42")
    const toolStart = turn.toolStart("call-1", "read_file", { path: "a.md" })
    const toolComplete = turn.toolComplete("call-1", "read_file", "contents")
    const delta = turn.delta("Hello")
    const complete = turn.complete("message-42", "Hello")
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId, after) => {
          cursors.push(after)
          return {
            epoch: "epoch-1",
            lastSeen: 4,
            events: [toolComplete, delta],
          }
        },
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", start)
    attachment.publish("live-secret", toolStart)
    attachment.signal("live-secret", { kind: "reattached" })
    attachment.publish("live-secret", complete)

    const events = await collect(handle)
    expect(cursors).toEqual([2])
    expect(
      events.filter(
        (event) =>
          (event as { kind?: unknown }).kind ===
          TurnEventKind.ToolCallInputEnded
      )
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          (event as { kind?: unknown }).kind === TurnEventKind.ToolCallStarted
      )
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          (event as { kind?: unknown }).kind === TurnEventKind.MessageChunk
      )
    ).toEqual([
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Hello",
      },
    ])
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("keeps a run streaming when the healed socket missed no frame", async () => {
    const attachment = observation()
    const cursors: number[] = []
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-42")
    const delta = turn.delta("Hello")
    const complete = turn.complete("message-42", "Hello")
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        // Hermes emitted nothing while the socket was down, so its page for the
        // run's own cursor is empty.
        replay: async (_liveSessionId, after) => {
          cursors.push(after)
          return { epoch: "epoch-1", lastSeen: after, events: [] }
        },
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", start)
    attachment.publish("live-secret", delta)
    attachment.signal("live-secret", { kind: "reattached" })
    attachment.publish("live-secret", complete)

    const events = await collect(handle)
    expect(cursors).toEqual([2])
    expect(events).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Hello",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("fills a live sequence hole with one catch-up and delivers the held frame once", async () => {
    const attachment = observation()
    const cursors: number[] = []
    const turn = nativeTurn("live-secret", 5)
    const start = turn.messageStart("message-42")
    const missed = [turn.delta("one"), turn.delta("two")]
    const held = turn.delta("three")
    const complete = turn.complete("message-42", "onetwothree")
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: 4 }),
        replay: async (_liveSessionId, after) => {
          cursors.push(after)
          return { epoch: "epoch-1", lastSeen: 7, events: missed }
        },
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", start)
    attachment.publish("live-secret", held)
    await Promise.resolve()
    attachment.publish("live-secret", complete)

    const events = await collect(handle)
    expect(cursors).toEqual([5])
    expect(
      ofKind(events, TurnEventKind.MessageChunk).map(
        (event) => (event as { text: string }).text
      )
    ).toEqual(["one", "two", "three"])
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("requires reconciliation when a catch-up page is truncated", async () => {
    const attachment = observation()
    const turn = nativeTurn("live-secret", 5)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: 4 }),
        replay: async () => ({
          epoch: "epoch-1",
          lastSeen: 7,
          truncated: true,
          events: [],
        }),
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", turn.messageStart("message-42"))
    attachment.publish(
      "live-secret",
      nativeTurn("live-secret", 8).delta("held")
    )

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
  })

  it("requires reconciliation when Hermes restarts a live sequence inside one epoch", async () => {
    const attachment = observation()
    const turn = nativeTurn("live-secret", 301)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        cursor: async () => ({ epoch: "epoch-1", latestSeq: 300 }),
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", turn.messageStart("message-42"))
    attachment.publish("live-secret", turn.delta("one"))
    attachment.publish("live-secret", turn.delta("two"))
    attachment.publish("live-secret", turn.delta("three"))
    attachment.publish("live-secret", turn.delta("four"))
    attachment.publish(
      "live-secret",
      nativeTurn("live-secret", 1).delta("evicted")
    )

    const events = await collect(handle)
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message:
        "Hermes history must be reconciled before this turn can continue.",
      code: "AOS_RESET_REQUIRED",
    })
    expect(JSON.stringify(events)).not.toContain("evicted")
  })

  it("detaches once on a lost connection and continues from the browser cursor", async () => {
    const attachment = observation()
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-42")
    const first = turn.delta("Hello")
    const second = turn.delta(" world")
    const complete = turn.complete("message-42", "Hello world")
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId, after) => {
          expect(after).toBe(2)
          return { epoch: "epoch-1", lastSeen: 4, events: [second, complete] }
        },
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", start)
    attachment.publish("live-secret", first)
    attachment.signal("live-secret", { kind: "lost", reason: "disconnected" })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Hello",
      },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "The Hermes connection was interrupted; reconnect to reconcile this turn.",
        code: "AOS_CONNECTION_INTERRUPTED",
      },
    ])
    expect(handle.recoveryPosition()).toEqual({ epoch: "epoch-1", lastSeen: 2 })

    const resumed = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-1",
      position: handle.recoveryPosition(),
    })

    await expect(collect(resumed)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: " world",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("requires reconciliation when the live Session is rebound", async () => {
    const attachment = observation()
    const engine = new HermesTurnEngine(
      runtime({ observe: attachment.observe })
    )

    const handle = await engine.start(scope, input())
    attachment.signal("live-secret", { kind: "lost", reason: "rebound" })

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
  })

  it("publishes one trusted TTS artifact when the socket reattaches mid tool", async () => {
    const audioPath = "/home/alice/voice-memos/out/quick-brief.mp3"
    const attachment = observation()
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-media")
    const toolStart = turn.toolStart("tts-call", "text_to_speech", {
      text: "Quarterly update",
    })
    const toolComplete = turn.toolComplete("tts-call", "text_to_speech", {
      success: true,
      file_path: audioPath,
      file_paths: [audioPath],
      media_tag: `MEDIA:${audioPath}`,
      provider: "edge",
    })
    const spoken = turn.delta(`Your brief is ready.\nMEDIA:${audioPath}`)
    const complete = turn.complete("message-media", "")
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId, after) => {
          expect(after).toBe(2)
          return {
            epoch: "epoch-1",
            lastSeen: 5,
            events: [toolComplete, spoken, complete],
          }
        },
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", start)
    attachment.publish("live-secret", toolStart)
    attachment.signal("live-secret", { kind: "reattached" })

    const events = await collect(handle)
    expect(ofKind(events, TurnEventKind.ArtifactPublished)).toMatchObject([
      { artifact: { filename: "quick-brief.mp3", mimeType: "audio/mpeg" } },
    ])
    expect(
      events.filter(
        (event) =>
          (event as { kind?: unknown }).kind ===
          TurnEventKind.ToolCallInputEnded
      )
    ).toHaveLength(1)
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "message-media",
      text: "Your brief is ready.\n",
    })
    expect(JSON.stringify(events)).not.toContain("Media unavailable")
    expect(JSON.stringify(events)).not.toContain(audioPath)
  })

  it("catches up two interleaved live Sessions independently", async () => {
    const attachment = observation()
    const other = {
      agentId: "research",
      sessionId: "stored-other",
      threadId: "hermes:research:stored-other",
    }
    const first = nativeTurn("live-a", 1)
    const second = nativeTurn("live-b", 1)
    const firstStart = first.messageStart("message-a")
    const firstMissed = first.delta("alpha")
    const firstHeld = first.complete("message-a", "alpha")
    const secondStart = second.messageStart("message-b")
    const secondMissed = second.delta("beta")
    const secondHeld = second.complete("message-b", "beta")
    const cursors: { liveSessionId: string; after: number }[] = []
    const engine = new HermesTurnEngine(
      runtime({
        resume: async (candidate) => ({
          liveSessionId:
            candidate.sessionId === scope.sessionId ? "live-a" : "live-b",
          running: false,
        }),
        observe: attachment.observe,
        replay: async (liveSessionId, after) => {
          cursors.push({ liveSessionId, after })
          return {
            epoch: "epoch-1",
            lastSeen: 2,
            events: [liveSessionId === "live-a" ? firstMissed : secondMissed],
          }
        },
      })
    )

    const runA = await engine.start(scope, input({ turnId: "run-a" }))
    const runB = await engine.start(other, input({ turnId: "run-b" }))
    attachment.publish("live-a", firstStart)
    attachment.publish("live-b", secondStart)
    attachment.publish("live-a", firstHeld)
    attachment.publish("live-b", secondHeld)

    await expect(collect(runA)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-a",
        text: "alpha",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
    await expect(collect(runB)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-b",
        text: "beta",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
    expect(cursors).toEqual([
      { liveSessionId: "live-a", after: 1 },
      { liveSessionId: "live-b", after: 1 },
    ])
  })

  it("freezes an uncertain run at the last delivered frame and replays it on reconnect", async () => {
    const attachment = observation()
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-42")
    const delta = turn.delta("Hello")
    const complete = turn.complete("message-42", "Hello")
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          submissions += 1
          return { acknowledgement: "uncertain" as const }
        },
        replay: async (_liveSessionId, after) => {
          expect(after).toBe(0)
          return {
            epoch: "epoch-1",
            lastSeen: 3,
            events: [start, delta, complete],
          }
        },
      })
    )

    const handle = await engine.start(scope, input())
    attachment.publish("live-secret", start)
    attachment.publish("live-secret", delta)

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes may have accepted this turn; reconcile before sending again.",
        code: "AOS_SEND_UNCERTAIN",
      },
    ])
    expect(submissions).toBe(1)
    expect(handle.recoveryPosition()).toEqual({ epoch: "epoch-1", lastSeen: 0 })

    const resumed = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-1",
      position: handle.recoveryPosition(),
    })

    await expect(collect(resumed)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "Hello",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("abandons a catch-up in flight when the run detaches", async () => {
    const attachment = observation()
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-42")
    const missed = turn.delta("missed ")
    const held = turn.delta("held")
    const cursors: number[] = []
    let releasePage: (page: HermesRecovery) => void = () => undefined
    let pageIssued: () => void = () => undefined
    const issued = new Promise<void>((resolve) => {
      pageIssued = resolve
    })
    let releaseSubmit: () => void = () => undefined
    const submitting = new Promise<void>((resolve) => {
      releaseSubmit = resolve
    })
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId, after) => {
          cursors.push(after)
          pageIssued()
          return new Promise<HermesRecovery>((resolve) => {
            releasePage = resolve
          })
        },
        submit: async () => {
          // The hole opens while the prompt is still in flight, so a catch-up is
          // running when the uncertain acknowledgement detaches the run.
          attachment.publish("live-secret", held)
          await submitting
          return { acknowledgement: "uncertain" as const }
        },
      })
    )

    const starting = engine.start(scope, input())
    await issued
    releaseSubmit()
    const handle = await starting
    expect(handle.recoveryPosition()).toEqual({ epoch: "epoch-1", lastSeen: 0 })

    releasePage({
      epoch: "epoch-1",
      lastSeen: 3,
      events: [start, missed, held],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes may have accepted this turn; reconcile before sending again.",
        code: "AOS_SEND_UNCERTAIN",
      },
    ])
    expect(handle.recoveryPosition()).toEqual({ epoch: "epoch-1", lastSeen: 0 })
    expect(cursors).toEqual([0])
  })

  it("ignores a stale catch-up page after the run reattaches from the browser cursor", async () => {
    const attachment = observation()
    const turn = nativeTurn("live-secret", 1)
    const start = turn.messageStart("message-42")
    const missed = turn.delta("missed ")
    const held = turn.delta("held")
    const complete = turn.complete("message-42", "missed held")
    let pages = 0
    let releaseStale: (page: HermesRecovery) => void = () => undefined
    let staleIssued: () => void = () => undefined
    const issued = new Promise<void>((resolve) => {
      staleIssued = resolve
    })
    let releaseSubmit: () => void = () => undefined
    const submitting = new Promise<void>((resolve) => {
      releaseSubmit = resolve
    })
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async () => {
          pages += 1
          if (pages > 1)
            return {
              epoch: "epoch-1",
              lastSeen: 3,
              events: [start, missed, held],
            }
          staleIssued()
          return new Promise<HermesRecovery>((resolve) => {
            releaseStale = resolve
          })
        },
        submit: async () => {
          attachment.publish("live-secret", held)
          await submitting
          return { acknowledgement: "uncertain" as const }
        },
      })
    )

    const starting = engine.start(scope, input())
    await issued
    releaseSubmit()
    const handle = await starting
    const resumed = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-1",
      position: handle.recoveryPosition(),
    })

    // The page the detached attachment asked for arrives after the reattach, so
    // it can no longer speak for this run's cursor.
    releaseStale({ epoch: "epoch-1", lastSeen: 2, events: [start, missed] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    attachment.publish("live-secret", complete)

    await expect(collect(resumed)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "missed ",
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "message-42",
        text: "held",
      },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("settles a busy rejection as busy and admits the next run", async () => {
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        submit: async () => {
          submissions += 1
          return { acknowledgement: "rejected", reason: "busy" }
        },
      })
    )

    const handle = await engine.start(scope, input())

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes is already running this Session.",
        code: "AOS_SESSION_BUSY",
      },
    ])
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
    expect(submissions).toBe(2)
  })

  it.each([
    [
      "busy",
      "AOS_SESSION_BUSY",
      "Hermes is already running this Session.",
      "session busy — Hermes is still replying. Stop the current reply first (Stop button, or Ctrl+C in a terminal), then run /undo.",
    ],
    [
      "in-use",
      "AOS_SESSION_IN_USE",
      "This Session is open in another app. Use it there, or start a new Session.",
      "This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.",
    ],
    [
      "session-limit",
      "AOS_SESSION_LIMIT",
      "Hermes has reached its limit of active Sessions.",
      "Hermes is at the active session limit (4/4). Try again when another session finishes.",
    ],
    [
      "unknown",
      "AOS_PROVIDER_RUN_FAILED",
      "Hermes rejected this command.",
      "Hermes refused this prompt.",
    ],
  ] as const)(
    "reports a %s refusal as %s followed by Hermes' own words",
    async (reason, code, headline, detail) => {
      const engine = new HermesTurnEngine(
        runtime({
          submit: async () => ({
            acknowledgement: "rejected",
            reason,
            detail,
          }),
        })
      )

      const events = await collect(await engine.start(scope, input()))

      expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([
        {
          kind: TurnEventKind.TurnFailed,
          code,
          message: `${headline}\n${detail}`,
        },
      ])
    }
  )

  it("rebinds the durable Session once and resubmits when Hermes reports it gone", async () => {
    const attachment = observation()
    let resumes = 0
    const submitted: string[] = []
    const engine = new HermesTurnEngine(
      runtime({
        resume: async () => ({
          liveSessionId: `live-${++resumes}`,
          running: false,
        }),
        observe: attachment.observe,
        submit: async (liveSessionId) => {
          submitted.push(liveSessionId)
          return liveSessionId === "live-1"
            ? { acknowledgement: "rejected", reason: "session-gone" }
            : { acknowledgement: "accepted", status: "streaming" }
        },
      })
    )

    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-2", 1)
    attachment.publish("live-2", turn.messageStart("message-42"))
    attachment.publish("live-2", turn.complete("message-42", ""))

    expect(submitted).toEqual(["live-1", "live-2"])
    expect(resumes).toBe(2)
    expect(attachment.attached("live-1")).toBe(false)
    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("requires reconciliation when a rebound Session rejects the prompt again", async () => {
    const submitted: string[] = []
    let resumes = 0
    const engine = new HermesTurnEngine(
      runtime({
        resume: async () => ({
          liveSessionId: `live-${++resumes}`,
          running: false,
        }),
        submit: async (liveSessionId) => {
          submitted.push(liveSessionId)
          return { acknowledgement: "rejected", reason: "session-gone" }
        },
      })
    )

    await expect(collect(await engine.start(scope, input()))).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message:
          "Hermes history must be reconciled before this turn can continue.",
        code: "AOS_RESET_REQUIRED",
      },
    ])
    expect(submitted).toEqual(["live-1", "live-2"])
  })

  it("admits a new run over an uncertain one only when Hermes reports it settled", async () => {
    let status: "working" | "idle" = "idle"
    const engine = new HermesTurnEngine(
      runtime({
        submit: async () => ({ acknowledgement: "uncertain" }),
        status: async () => status,
      })
    )

    await engine.start(scope, input())
    status = "working"

    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).rejects.toThrow("already active")
    status = "idle"
    await expect(
      engine.start(scope, input({ turnId: "run-3" }))
    ).resolves.toBeDefined()
  })

  it("settles the run and reports an outage when nothing was submitted", async () => {
    let submissions = 0
    const engine = new HermesTurnEngine(
      runtime({
        submit: async () => {
          submissions += 1
          if (submissions === 1) throw new Error("bearer submit-secret")
          return { acknowledgement: "accepted", status: "streaming" }
        },
      })
    )

    await expect(engine.start(scope, input())).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable.",
    })
    await expect(
      engine.start(scope, input({ turnId: "run-2" }))
    ).resolves.toBeDefined()
    expect(submissions).toBe(2)
  })

  /**
   * The settlement rules: one live Session, a scripted native status ladder and
   * the native calls a turn outcome makes. `statuses` is consumed in order, so a
   * test states only the reads it is about; every later read answers idle.
   */
  function settlement(
    statuses: HermesNativeStatus[] = [],
    overrides: Partial<HermesTurnNative> = {},
    options: { log?: HermesLog } = {}
  ) {
    const attachment = observation()
    const status = vi.fn(async () => statuses.shift() ?? ("idle" as const))
    const retained: string[] = []
    const submitted: string[] = []
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        status,
        retain: async (_scope: HermesTurnScope, reason: string) => {
          retained.push(reason)
          return () => undefined
        },
        submit: async (_liveSessionId: string, prompt: HermesSubmitPrompt) => {
          submitted.push(prompt.turnId)
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
        ...overrides,
      }),
      options
    )
    return {
      engine,
      status,
      retained,
      submitted,
      publish: (frame: unknown) => attachment.publish("live-secret", frame),
    }
  }

  /** One turn Hermes ends with a terminal native failure payload. */
  async function failedTurn(
    payload: Record<string, unknown>,
    options: { log?: HermesLog } = {}
  ) {
    const { engine, publish } = settlement([], {}, options)
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("reply"))
    publish(turn.frame("message.complete", { status: "error", ...payload }))
    publish(turn.idle())
    return collect(handle)
  }

  it("waits for Hermes to settle before admitting the next Send after a completion", async () => {
    vi.useFakeTimers()
    try {
      // The gate for run-1, then the settling watcher's own reads while Hermes
      // finishes the first turn, then the gate for run-2.
      const { engine, status, submitted, publish } = settlement([
        "idle",
        "working",
        "idle",
        "idle",
      ])
      const first = await engine.start(scope, input())
      const turn = nativeTurn("live-secret", 1)
      publish(turn.messageStart("reply"))
      publish(turn.complete("reply", "Done"))
      await first.settled

      const second = engine.start(scope, input({ turnId: "run-2" }))
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(second).resolves.toBeDefined()
      expect(submitted).toEqual(["run-1", "run-2"])
      expect(status).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never waits past the settling window for a slow native retainer", async () => {
    vi.useFakeTimers()
    try {
      const { engine, submitted, publish } = settlement(["idle", "idle"], {
        // Hermes is slow to resume the binding the retainer needs.
        retain: () => new Promise<() => void>(() => {}),
      })
      const first = await engine.start(scope, input())
      const turn = nativeTurn("live-secret", 1)
      publish(turn.messageStart("reply"))
      publish(turn.complete("reply", "Done"))
      await first.settled

      const second = engine.start(scope, input({ turnId: "run-2" }))
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(second).resolves.toBeDefined()
      expect(submitted).toEqual(["run-1", "run-2"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("never holds the next Send past the settling window for a slow status read", async () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      const { engine, submitted, publish } = settlement([], {
        status: async () => {
          reads += 1
          // The settling watcher's own read never comes back; the gate reads
          // around it answer normally.
          if (reads === 2) return new Promise<HermesNativeStatus>(() => {})
          return "idle"
        },
      })
      const first = await engine.start(scope, input())
      const turn = nativeTurn("live-secret", 1)
      publish(turn.messageStart("reply"))
      publish(turn.complete("reply", "Done"))
      await first.settled

      const second = engine.start(scope, input({ turnId: "run-2" }))
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(second).resolves.toBeDefined()
      expect(submitted).toEqual(["run-1", "run-2"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds a settling retainer and admits back-to-back turns", async () => {
    const { engine, retained, submitted, publish } = settlement()
    const first = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("reply"))
    publish(turn.complete("reply", "Done"))
    await first.settled

    const second = await engine.start(scope, input({ turnId: "run-2" }))
    const drained = nativeTurn("live-secret", 1)
    publish(drained.messageStart("reply-again"))
    publish(drained.complete("reply-again", "Done again"))

    expect(retained).toContain("settling")
    expect(submitted).toEqual(["run-1", "run-2"])
    await expect(collect(second)).resolves.not.toContainEqual(
      expect.objectContaining({ kind: TurnEventKind.TurnFailed })
    )
  })

  it("reports an interrupted native completion as stopped with stopped tools", async () => {
    const { engine, publish } = settlement(["idle", "working"])
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("reply"))
    publish(turn.toolStart("tool-1", "terminal", { command: "sleep 60" }))

    await expect(handle.stop()).resolves.toBe("stopping")
    publish(turn.complete("reply", "", "interrupted"))
    publish(turn.idle())

    const events = await collect(handle)
    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "tool-1",
      output: '{"status":"stopped"}',
      failed: false,
    })
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("reports a native interruption AOS never requested as stopped", async () => {
    // Another client stopped the turn: AOS asked for nothing, so only Hermes'
    // own `interrupted` outcome says the open tools were cut short.
    const { engine, publish } = settlement()
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("reply"))
    publish(turn.toolStart("tool-1", "terminal", { command: "sleep 60" }))
    publish(turn.complete("reply", "", "interrupted"))
    publish(turn.idle())

    const events = await collect(handle)
    expect(events).toContainEqual({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "tool-1",
      output: '{"status":"stopped"}',
      failed: false,
    })
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
  })

  it("keeps Stop pending while Hermes is starting and settles the cancelled build as stopped", async () => {
    // Hermes latches the cancel while the agent is still building: it answers
    // `starting`, then cancels the turn with a bare error and goes idle.
    const { engine, publish } = settlement(["idle", "starting", "idle"])
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)

    await expect(handle.stop()).resolves.toBe("stopping")
    publish(turn.error("Turn cancelled before the agent was ready"))

    await expect(collect(handle)).resolves.toEqual([
      { kind: TurnEventKind.TurnStarted },
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.Cancelled },
    ])
  })

  it("finishes stopped when Hermes reports the live Session already gone", async () => {
    // Only Hermes' own "there is no live turn left" answer can confirm this
    // Stop: its status read still reports the Session working.
    const { engine } = settlement(["idle", "working"], {
      interrupt: async () => "gone",
    })
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).resolves.toBe("idle")
    await expect(collect(handle)).resolves.toContainEqual({
      kind: TurnEventKind.TurnEnded,
      stopReason: StopReason.Cancelled,
    })
  })

  it("fails a steered turn that Hermes ended with a native error", async () => {
    const { engine, publish } = settlement()
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("reply-before"))
    publish(turn.delta("Before"))

    await expect(
      handle.steer?.({ requestId: "queue-item-1", text: "Correction" })
    ).resolves.toBe("steered")
    publish(
      turn.frame("message.complete", {
        status: "error",
        error: "provider rejected the request",
        text: "Before",
      })
    )
    publish(turn.idle())

    const events = await collect(handle)
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message:
        "Hermes could not complete this turn.\nprovider rejected the request",
      code: "AOS_PROVIDER_RUN_FAILED",
    })
  })

  it("fails the running turn Hermes merged an in-place prompt into", async () => {
    // A `steered` admission means Hermes folded the prompt into the turn that is
    // already running, so that turn's completion is this run's own outcome and
    // no further `message.start` arrives.
    const log = { warn: vi.fn() }
    const { engine, publish } = settlement(
      [],
      {
        submit: async () => ({
          acknowledgement: "accepted" as const,
          status: "steered" as const,
        }),
      },
      { log }
    )
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(
      turn.frame("message.complete", {
        status: "error",
        error: "agent build timed out",
        error_surface: { layer: "agent", code: "agent_init_failed" },
      })
    )
    publish(turn.idle())

    const events = await collect(handle)
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message:
        "Hermes could not start the agent for this Session.\nagent build timed out",
      code: "AOS_PROVIDER_AGENT_UNAVAILABLE",
    })
    expect(
      log.warn.mock.calls.filter(([event]) => event === "hermes.turn.failed")
    ).toHaveLength(1)
  })

  it("keeps a queued steer running until Hermes starts the drained turn", async () => {
    vi.useFakeTimers()
    try {
      const { engine, publish } = settlement(["idle", "working"], {
        redirect: async () => "queued",
      })
      const handle = await engine.start(scope, input())
      const turn = nativeTurn("live-secret", 1)
      publish(turn.messageStart("reply-before"))
      publish(turn.delta("Before"))

      await expect(
        handle.steer?.({ requestId: "queue-item-1", text: "Correction" })
      ).resolves.toBe("queued")
      publish(turn.complete("reply-before", "Before"))
      publish(turn.idle())
      // Hermes drains the queued correction after the first turn's idle edge.
      publish(turn.messageStart("reply-after"))
      await vi.advanceTimersByTimeAsync(1_000)
      publish(turn.delta("After"))
      publish(turn.complete("reply-after", "After"))
      publish(turn.idle())

      const events = await collect(handle)
      expect([
        ...ofKind(events, TurnEventKind.TurnEnded),
        ...ofKind(events, TurnEventKind.TurnFailed),
      ]).toEqual([
        { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
      ])
      expect(messageIds(events)).toEqual(["reply-before", "reply-after"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores the superseded turn's completion and idle edges until a queued turn starts", async () => {
    vi.useFakeTimers()
    try {
      const { engine, publish } = settlement(["idle", "working"], {
        submit: async () => ({ acknowledgement: "accepted", status: "queued" }),
      })
      const handle = await engine.start(scope, input())
      const turn = nativeTurn("live-secret", 1)
      // Hermes always ends the turn AOS was admitted behind before it reports
      // idle, so neither frame describes the turn this run is waiting for.
      publish(turn.complete("previous-reply", "Previous answer"))
      publish(turn.idle())
      let settled = false
      void handle.settled.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBe(false)

      // Hermes drains the queued turn inside the grace the idle edge armed.
      publish(turn.messageStart("queued-reply"))
      await vi.advanceTimersByTimeAsync(1_000)
      publish(turn.delta("Queued answer"))
      publish(turn.complete("queued-reply", "Queued answer"))
      publish(turn.idle())

      const events = await collect(handle)
      expect(messageIds(events)).toEqual(["queued-reply"])
      expect(JSON.stringify(events)).not.toContain("Previous answer")
      expect([
        ...ofKind(events, TurnEventKind.TurnEnded),
        ...ofKind(events, TurnEventKind.TurnFailed),
      ]).toEqual([
        { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails a queued turn Hermes never started once it confirms idle", async () => {
    vi.useFakeTimers()
    try {
      const { engine, publish } = settlement(["idle", "idle"], {
        submit: async () => ({ acknowledgement: "accepted", status: "queued" }),
      })
      const handle = await engine.start(scope, input())
      const turn = nativeTurn("live-secret", 1)
      publish(turn.complete("previous-reply", "Previous answer"))
      publish(turn.idle())
      // Hermes drained nothing inside the grace and still reports no turn, so no
      // assistant turn for this prompt exists or can arrive any more.
      await vi.advanceTimersByTimeAsync(1_000)

      const events = await collect(handle)
      expect(JSON.stringify(events)).not.toContain("Previous answer")
      expect(events).toEqual([
        { kind: TurnEventKind.TurnStarted },
        {
          kind: TurnEventKind.TurnFailed,
          message: "Hermes could not complete this turn.",
          code: "AOS_PROVIDER_RUN_FAILED",
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps re-reading Hermes while a queued turn has not started", async () => {
    vi.useFakeTimers()
    try {
      // Hermes stays busy across the boundary, so one read cannot decide: the
      // bounded re-reads make sure a start that never comes settles this run
      // instead of fencing the Session behind it.
      const { engine, status, publish } = settlement(
        ["idle", "working", "working", "idle"],
        {
          submit: async () => ({
            acknowledgement: "accepted",
            status: "queued",
          }),
        }
      )
      const handle = await engine.start(scope, input())
      const turn = nativeTurn("live-secret", 1)
      publish(turn.complete("previous-reply", "Previous answer"))
      publish(turn.idle())
      await vi.advanceTimersByTimeAsync(5_000)

      const events = await collect(handle)
      expect(events.at(-1)).toEqual({
        kind: TurnEventKind.TurnFailed,
        message: "Hermes could not complete this turn.",
        code: "AOS_PROVIDER_RUN_FAILED",
      })
      expect(status).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a Hermes agent build failure as an unavailable Agent", async () => {
    await expect(
      failedTurn({
        error: "agent build timed out",
        error_surface: { layer: "agent", code: "agent_init_failed" },
      })
    ).resolves.toContainEqual({
      kind: TurnEventKind.TurnFailed,
      message:
        "Hermes could not start the agent for this Session.\nagent build timed out",
      code: "AOS_PROVIDER_AGENT_UNAVAILABLE",
    })
  })

  it("reports a native billing or quota failure", async () => {
    await expect(
      failedTurn({ error_surface: { layer: "billing", code: "wall_reached" } })
    ).resolves.toContainEqual({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes reported a billing or quota problem.",
      code: "AOS_PROVIDER_BILLING_FAILED",
    })
    await expect(
      failedTurn({ error_surface: { code: "insufficient_quota" } })
    ).resolves.toContainEqual({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes reported a billing or quota problem.",
      code: "AOS_PROVIDER_BILLING_FAILED",
    })
  })

  it("reports a retryable provider failure", async () => {
    await expect(
      failedTurn({
        error_surface: {
          layer: "provider",
          code: "throttled",
          retryable: true,
        },
      })
    ).resolves.toContainEqual({
      kind: TurnEventKind.TurnFailed,
      message:
        "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.",
      code: "AOS_PROVIDER_RETRYABLE_FAILURE",
    })
  })

  it("never publishes Hermes' failure copy as assistant text", async () => {
    // With nothing streamed Hermes composes its own failure copy into `text`
    // and leaves `partial` absent: that copy explains the failure, so it is
    // published as one instead of as an assistant message.
    const events = await failedTurn({
      text: "AWS Bedrock didn't answer after 3 attempts. Provider said: An error occurred (ValidationException)",
      error:
        "An error occurred (ValidationException) when calling the InvokeModel operation",
      error_surface: {
        layer: "provider",
        code: "validation_exception",
        retryable: true,
      },
    })

    expect(ofKind(events, TurnEventKind.MessageChunk)).toEqual([])
    expect(JSON.stringify(events)).not.toContain("AWS Bedrock")
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message:
        "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.\nAn error occurred (ValidationException) when calling the InvokeModel operation",
      code: "AOS_PROVIDER_RETRYABLE_FAILURE",
    })
  })

  it("keeps the prose a partial failed completion streamed and still fails", async () => {
    const events = await failedTurn({
      text: "I read the filing and then",
      partial: true,
      error: "connection reset by peer",
    })

    expect(ofKind(events, TurnEventKind.MessageChunk)).toEqual([
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "reply",
        text: "I read the filing and then",
      },
    ])
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes could not complete this turn.\nconnection reset by peer",
      code: "AOS_PROVIDER_RUN_FAILED",
    })
  })

  it("bounds the native cause a failed run publishes", async () => {
    const events = (await failedTurn({ error: "boom ".repeat(200) })) as Array<{
      kind: string
      message?: string
    }>

    expect(
      events.find((event) => event.kind === TurnEventKind.TurnFailed)?.message
    ).toBe(
      `Hermes could not complete this turn.\n${"boom ".repeat(100).trim()}`
    )
  })

  it("drops a native cause that carries a credential-shaped value", async () => {
    const events = await failedTurn({
      error: "provider rejected authorization=Bearer sk-live-native-secret",
    })

    expect(JSON.stringify(events)).not.toContain("sk-live-native-secret")
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes could not complete this turn.",
      code: "AOS_PROVIDER_RUN_FAILED",
    })
  })

  it("restores a retained failed turn exactly as the live turn failed", async () => {
    const errorSurface = {
      layer: "provider",
      code: "validation_exception",
      retryable: true,
      provider: "bedrock",
      model: "sonnet",
    }
    const nativeError = "This model does not support assistant message prefill"
    const assistant = "I could not finish this answer."
    const events = (await failedTurn({
      text: assistant,
      partial: true,
      error: nativeError,
      error_surface: errorSurface,
    })) as Array<{
      kind: string
      text?: string
      message?: string
      code?: string
    }>
    const liveText = events
      .filter((event) => event.kind === TurnEventKind.MessageChunk)
      .map((event) => event.text ?? "")
      .join("")
    const liveFailure = events.find(
      (event) => event.kind === TurnEventKind.TurnFailed
    )

    const inflight = hermesInflightTurn({
      user: "Ask",
      assistant: liveText,
      streaming: false,
      status: "error",
      recoverable: true,
      error: nativeError,
      error_surface: errorSurface,
    })
    if (!inflight) throw new Error("Expected a validated inflight snapshot")
    const restored = restoredHermesFailedTurn(inflight, {
      id: "aos-inflight:stored-session",
      userText: "Ask",
      createdAt: "2026-09-15T19:41:41.000Z",
    })

    expect(liveText).toBe(assistant)
    expect(restored?.content).toEqual([{ type: "text", text: liveText }])
    expect(restored?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: liveFailure?.message,
    })
    expect(restored?.metadata?.custom).toEqual({
      aos: { turnErrorCode: liveFailure?.code },
    })
    // The operator acts on the provider's own words, so the same bounded cause
    // reads on both paths rather than staying in the server log alone.
    expect(liveFailure?.message).toContain(nativeError)
  })

  it("restores a non-partial failed turn with no assistant text either way", async () => {
    const errorSurface = {
      layer: "provider",
      code: "validation_exception",
      retryable: true,
    }
    const nativeError = "An error occurred (ValidationException)"
    const events = (await failedTurn({
      // Hermes' composed failure copy, which neither path may render as prose.
      text: `AWS Bedrock didn't answer after 3 attempts. Provider said: ${nativeError}`,
      error: nativeError,
      error_surface: errorSurface,
    })) as Array<{ kind: string; message?: string; code?: string }>
    const liveFailure = events.find(
      (event) => event.kind === TurnEventKind.TurnFailed
    )

    const inflight = hermesInflightTurn({
      user: "Ask",
      assistant: "",
      streaming: false,
      status: "error",
      error: nativeError,
      error_surface: errorSurface,
    })
    if (!inflight) throw new Error("Expected a validated inflight snapshot")
    const restored = restoredHermesFailedTurn(inflight, {
      id: "aos-inflight:stored-session",
      userText: "Ask",
      createdAt: "2026-09-15T19:41:41.000Z",
    })

    expect(ofKind(events, TurnEventKind.MessageChunk)).toEqual([])
    expect(JSON.stringify(events)).not.toContain("AWS Bedrock")
    expect(restored?.content).toEqual([])
    expect(restored?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: liveFailure?.message,
    })
  })

  it("logs one redacted, bounded native cause per failed run", async () => {
    const log = { warn: vi.fn() }
    const events = await failedTurn(
      {
        error: "https://hermes.internal/api/prompt?token=native-secret",
        failure_reason: "provider_rejected",
        error_surface: {
          layer: "provider",
          code: "bad_request",
          retryable: false,
        },
      },
      { log }
    )

    expect(
      log.warn.mock.calls.filter(([event]) => event === "hermes.turn.failed")
    ).toEqual([
      [
        "hermes.turn.failed",
        expect.objectContaining({
          code: "bad_request",
          layer: "provider",
          retryable: false,
          failureReason: "provider_rejected",
          nativeMessage: "https://hermes.internal/api/prompt",
        }),
      ],
    ])
    expect(JSON.stringify(events)).not.toContain("native-secret")

    const bounded = { warn: vi.fn() }
    await failedTurn({ error: "boom ".repeat(200) }, { log: bounded })
    const failures = bounded.warn.mock.calls.filter(
      ([event]) => event === "hermes.turn.failed"
    )
    expect(failures).toHaveLength(1)
    expect(
      (failures[0]![1] as { nativeMessage: string }).nativeMessage
    ).toHaveLength(200)
  })

  it("keeps the run open through the failed-tool recovery sequence", async () => {
    const { engine, publish } = settlement()
    const handle = await engine.start(scope, input())
    for (const frame of failedToolThenRecovery("live-secret", 1)) publish(frame)

    const events = await collect(handle)
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: TurnEventKind.TurnFailed })
    )
    expect(ofKind(events, TurnEventKind.TurnEnded)).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "tool-fail",
        output: '{"error":"not found"}',
        failed: true,
      })
    )
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "msg-ftr",
      text: "I will try another approach.",
    })
  })

  it("completes the advisory-error sequence without a turn error", async () => {
    const log = { warn: vi.fn() }
    const { engine, publish } = settlement(["idle", "working"], {}, { log })
    const handle = await engine.start(scope, input())
    for (const frame of advisoryErrorThenComplete("live-secret", 1)) {
      publish(frame)
      // The sequence's precondition: Hermes answers the reconciling status read
      // while the turn is still open, so the verdict decides this outcome.
      if (frame.type === "error")
        await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const events = await collect(handle)
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: TurnEventKind.TurnFailed })
    )
    expect(events.at(-1)).toMatchObject({ kind: TurnEventKind.TurnEnded })
    expect(log.warn.mock.calls).toEqual([
      [
        "hermes.turn.native_error",
        expect.objectContaining({ verdict: "advisory", status: "working" }),
      ],
    ])
  })

  it("fails the terminal-error sequence once at the idle edge", async () => {
    const { engine, publish } = settlement()
    const handle = await engine.start(scope, input())
    for (const frame of terminalErrorThenIdle("live-secret", 1)) publish(frame)

    const events = await collect(handle)
    expect(events).toContainEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "msg-tei",
      text: "Partial response before",
    })
    expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes could not complete this turn.",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })
  it("fails a queued turn Hermes never started after a bare error frame", async () => {
    vi.useFakeTimers()
    try {
      const log = { warn: vi.fn() }
      const { engine, publish } = settlement(
        [],
        {
          // Hermes admitted this turn behind the one still running.
          submit: async () => ({
            acknowledgement: "accepted" as const,
            status: "queued" as const,
          }),
        },
        { log }
      )
      const handle = await engine.start(scope, input())
      const previous = nativeTurn("live-secret", 1)

      // The previous turn ends with a bare error frame and no idle session.info,
      // so only authoritative status reads can settle this run.
      publish(previous.error("provider stream closed"))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)

      const events = await collect(handle)
      expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([
        {
          kind: TurnEventKind.TurnFailed,
          message: "Hermes could not complete this turn.",
          code: "AOS_PROVIDER_RUN_FAILED",
        },
      ])
      expect(log.warn).toHaveBeenCalledWith(
        "hermes.turn.failed",
        expect.objectContaining({ failureReason: "queued-turn-not-started" })
      )
      // The Session fence is released, so the next Send is admitted.
      await expect(
        engine.start(scope, input({ turnId: "run-2" }))
      ).resolves.toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not carry a superseded turn's error into the turn that follows", async () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      const attachment = observation()
      const publish = (frame: unknown) =>
        attachment.publish("live-secret", frame)
      const engine = new HermesTurnEngine(
        runtime({
          observe: attachment.observe,
          // Only the pre-submit gate answers; every later read is an outage, so
          // the advisory error frame is never reconciled by a status read.
          status: async () => {
            reads += 1
            if (reads === 1) return "idle"
            throw new HermesUnavailableError()
          },
          redirect: async () => "queued",
        })
      )
      const handle = await engine.start(scope, input())
      const previous = nativeTurn("live-secret", 1)
      publish(previous.messageStart("reply-before"))
      publish(previous.delta("Before"))

      await expect(
        handle.steer?.({ requestId: "queue-1", text: "Correction" })
      ).resolves.toBe("queued")
      publish(previous.error("model switch rejected"))
      publish(previous.complete("reply-before", "Before"))
      publish(previous.idle())
      // The queued correction is the turn this run follows from here.
      publish(previous.messageStart("reply-after"))
      publish(previous.delta("After"))
      publish(previous.idle())

      const events = await collect(handle)
      expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([])
      expect(ofKind(events, TurnEventKind.TurnEnded)).toEqual([
        { kind: TurnEventKind.TurnEnded },
      ])
      expect(events).toContainEqual({
        kind: TurnEventKind.MessageChunk,
        messageId: "reply-after",
        text: "After",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits for a catch-up page before a status read may settle the turn", async () => {
    const attachment = observation()
    const publish = (frame: unknown) => attachment.publish("live-secret", frame)
    let announceCatchUp!: () => void
    const catchUpStarted = new Promise<void>((resolve) => {
      announceCatchUp = resolve
    })
    let releasePage!: (recovery: HermesRecovery) => void
    const page = new Promise<HermesRecovery>((resolve) => {
      releasePage = resolve
    })
    const cursors: number[] = []
    let reads = 0
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        // The read the error frame reconciles answers only once the catch-up for
        // the hole is already in flight.
        status: async () => {
          reads += 1
          if (reads > 1) await catchUpStarted
          return "idle"
        },
        replay: async (_liveSessionId: string, after: number) => {
          cursors.push(after)
          announceCatchUp()
          return page
        },
      })
    )
    const handle = await engine.start(scope, input())
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("msg-1"))
    publish(turn.error("provider hiccup"))
    const completion = turn.complete("msg-1", "Done")
    // The next live frame skips the completion, so the ring is read once.
    publish(turn.delta("ignored"))

    releasePage({
      epoch: "epoch-1",
      lastSeen: completion.seq,
      truncated: false,
      events: [completion],
    })
    const events = await collect(handle)

    expect(cursors).toEqual([2])
    expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([])
    expect(ofKind(events, TurnEventKind.TurnEnded)).toEqual([
      { kind: TurnEventKind.TurnEnded, stopReason: StopReason.EndTurn },
    ])
  })

  it("keeps a Stop-uncertain run reconcilable instead of overflowing it", async () => {
    const attachment = observation()
    const publish = (frame: unknown) => attachment.publish("live-secret", frame)
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        interrupt: async () => {
          throw new HermesUnavailableError()
          return "interrupted" as const
        },
      })
    )
    const handle = await engine.start(scope, input())
    let settled = false
    void handle.settled.then(() => {
      settled = true
    })

    await expect(handle.stop()).rejects.toMatchObject({
      code: "AOS_STOP_UNCERTAIN",
    })
    const turn = nativeTurn("live-secret", 1)
    publish(turn.messageStart("msg-1"))
    for (let index = 0; index < 5_000; index += 1) publish(turn.delta("chunk"))
    await Promise.resolve()
    await Promise.resolve()

    // Nothing was published into the closed stream, so no overflow settled the
    // run and released the Session fence without a reconcile.
    expect(settled).toBe(false)
    await expect(
      engine.recover(scope, {
        threadId: scope.threadId,
        turnId: "run-1",
        position: { epoch: "epoch-1", lastSeen: 1 },
      })
    ).resolves.toBeDefined()
  })

  it("replays the frames a Stop-uncertain run stopped consuming", async () => {
    const attachment = observation()
    const publish = (frame: unknown) => attachment.publish("live-secret", frame)
    const turn = nativeTurn("live-secret", 1)
    const frames = [
      turn.messageStart("msg-1"),
      turn.delta("After the Stop"),
      turn.complete("msg-1", "After the Stop"),
    ]
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        interrupt: async () => {
          throw new HermesUnavailableError()
        },
        replay: async (_liveSessionId, after) => ({
          epoch: "epoch-1",
          lastSeen: 3,
          truncated: false,
          events: frames.filter((frame) => frame.seq > after),
        }),
      })
    )
    const handle = await engine.start(scope, input())

    await expect(handle.stop()).rejects.toMatchObject({
      code: "AOS_STOP_UNCERTAIN",
    })
    for (const frame of frames) publish(frame)

    // The observer was released, so the cursor stayed at the last frame this
    // run delivered: nothing published after the Stop was consumed and lost.
    expect(handle.recoveryPosition()).toEqual({ epoch: "epoch-1", lastSeen: 0 })
    const recovered = await collect(
      await engine.recover(scope, {
        threadId: scope.threadId,
        turnId: "run-1",
      })
    )

    expect(eventKinds(recovered)).toEqual([
      TurnEventKind.TurnStarted,
      TurnEventKind.MessageChunk,
      TurnEventKind.TurnEnded,
    ])
  })

  it("catches up when a replayed page stops short of the reported watermark", async () => {
    const attachment = observation()
    const publish = (frame: unknown) => attachment.publish("live-secret", frame)
    const turn = nativeTurn("live-secret", 6)
    const start = turn.messageStart("msg-1")
    const first = turn.delta("Hello")
    const second = turn.delta(" there")
    const completion = turn.complete("msg-1", "Hello there")
    const cursors: number[] = []
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        replay: async (_liveSessionId: string, after: number) => {
          cursors.push(after)
          // Hermes reports a watermark of 9 but returns only seq 6 first.
          return {
            epoch: "epoch-1",
            lastSeen: completion.seq,
            truncated: false,
            events: after === 5 ? [start] : [first, second, completion],
          }
        },
      })
    )

    const handle = await engine.recover(scope, {
      threadId: scope.threadId,
      turnId: "run-1",
      position: { epoch: "epoch-1", lastSeen: 5 },
    })
    publish(turn.idle())
    const events = await collect(handle)

    // The watermark advanced only to the frame the page carried, so 7..9 were
    // read rather than silently skipped.
    expect(cursors).toEqual([5, start.seq])
    expect(
      ofKind(events, TurnEventKind.MessageChunk).map(
        (event) => (event as { text: string }).text
      )
    ).toEqual(["Hello", " there"])
    expect(ofKind(events, TurnEventKind.TurnFailed)).toEqual([])
  })
})

/**
 * One tool call, projected twice: once as it streams live through the engine and
 * once as `history.ts` refreshes it from the authoritative durable rows. Both
 * paths must agree on the public tool name, arguments, error classification,
 * result content and artifact descriptors, so a change to either alone fails
 * here.
 */
describe("live and refreshed Hermes tool projection agree", () => {
  type ParityCall = {
    toolCallId: string
    name: string
    args: Record<string, unknown>
    result: unknown
    isError?: boolean
    /**
     * The tool name Hermes records on the durable result row. It names the
     * selected tool for a `tool_call` bridge call, so it may differ from the
     * name the assistant row and the live frames carry.
     */
    resultName?: string
  }

  type ToolProjection = {
    toolName: string
    args: unknown
    argsText: string
    result: unknown
    resultText: string
    artifacts: unknown[]
    isError: boolean
    toolKind: unknown
    locations: unknown
    diffs: unknown
  }

  async function liveProjection(call: ParityCall): Promise<ToolProjection> {
    const attachment = observation()
    const engine = new HermesTurnEngine(
      runtime({
        observe: attachment.observe,
        submit: async () => {
          const turn = nativeTurn("live-secret", 1)
          for (const frame of [
            turn.messageStart("message-parity"),
            turn.toolStart(call.toolCallId, call.name, call.args),
            turn.toolComplete(
              call.toolCallId,
              call.name,
              call.result,
              call.isError
            ),
            turn.complete("message-parity", ""),
            turn.idle(),
          ])
            attachment.publish("live-secret", frame)
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )
    const events = await collect(await engine.start(scope, input()))
    const forCall = (kind: TurnEventKind) =>
      ofKind(events, kind).find(
        (event) =>
          (event as { toolCallId?: unknown }).toolCallId === call.toolCallId
      ) as Record<string, unknown> | undefined
    const argsText = String(
      forCall(TurnEventKind.ToolCallInputChunk)?.delta ?? ""
    )
    const resultText = String(
      forCall(TurnEventKind.ToolCallFinished)?.output ?? ""
    )
    return {
      toolName: String(forCall(TurnEventKind.ToolCallStarted)?.title ?? ""),
      args: JSON.parse(argsText || "null"),
      argsText,
      result: JSON.parse(resultText || "null"),
      resultText,
      artifacts: ofKind(events, TurnEventKind.ArtifactPublished).map(
        (event) => (event as { artifact: unknown }).artifact
      ),
      isError: forCall(TurnEventKind.ToolCallFinished)?.failed === true,
      toolKind: forCall(TurnEventKind.ToolCallStarted)?.toolKind,
      locations: forCall(TurnEventKind.ToolCallStarted)?.locations,
      diffs: forCall(TurnEventKind.ToolCallFinished)?.diffs,
    }
  }

  function refreshedProjection(call: ParityCall): ToolProjection {
    const messages = projectHermesHistory([
      assistantToolCall("assistant-parity", [
        { toolCallId: call.toolCallId, name: call.name, args: call.args },
      ]),
      toolRow(
        call.toolCallId,
        call.resultName ?? call.name,
        call.result,
        call.isError
      ),
    ])
    const parts = (messages[0]?.content ?? []) as unknown as Record<
      string,
      unknown
    >[]
    const part = parts.find(
      (candidate) =>
        candidate.type === "tool-call" &&
        candidate.toolCallId === call.toolCallId
    )
    return {
      toolName: String(part?.toolName ?? ""),
      args: part?.args ?? null,
      argsText: String(part?.argsText ?? ""),
      result: part?.result ?? null,
      resultText: JSON.stringify(part?.result ?? null),
      artifacts: parts
        .filter(
          (candidate) =>
            candidate.type === "data" && candidate.name === "aos.artifact"
        )
        .map((candidate) => candidate.data),
      isError: part?.isError === true,
      toolKind: part?.kind,
      locations: part?.locations,
      diffs: part?.diffs,
    }
  }

  async function parity(call: ParityCall) {
    const { isError, ...live } = await liveProjection(call)
    expect({ isError, ...live }).toEqual(refreshedProjection(call))
    return { projection: live, isError }
  }

  it("projects a public file edit's kind, location, and diff identically", async () => {
    const path = "/workspace/app/notes.md"
    const { projection } = await parity({
      toolCallId: "edit-parity",
      name: "patch",
      args: { path, old_string: "old", new_string: "new" },
      result: {
        success: true,
        diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
        files_modified: [path],
      },
    })

    expect(projection.toolKind).toBe(ToolKind.Edit)
    expect(projection.locations).toEqual([{ path }])
    expect(projection.diffs).toMatchObject([
      { changes: [{ operation: "modify", path }] },
    ])
  })

  it("projects a published artifact receipt identically", async () => {
    const { projection, isError } = await parity({
      toolCallId: "artifact-parity",
      name: "present_artifact",
      args: {
        id: "report-1",
        title: "Report",
        path: "/srv/hermes/private/report.md",
      },
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
    })

    expect(isError).toBe(false)
    expect(projection.args).toEqual({ id: "report-1", title: "Report" })
    expect(projection.result).toEqual({
      ok: true,
      type: "aos.artifact",
      artifact: {
        id: "report-1",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
      },
    })
    expect(projection.artifacts).toEqual([
      {
        id: "report-1",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
        source: { type: "provider", reference: "report-1" },
      },
    ])
    expect(JSON.stringify(projection)).not.toContain("/srv/hermes")
  })

  it("collapses an unpublishable artifact receipt identically", async () => {
    const { projection, isError } = await parity({
      toolCallId: "artifact-unsafe-parity",
      name: "present_artifact",
      args: { path: "/srv/private/report.md" },
      result: {
        ok: true,
        type: "aos.artifact",
        artifact: {
          id: "/srv/private/report.md",
          filename: "../report.md",
          path: "/srv/private/report.md",
        },
      },
    })

    expect(isError).toBe(false)
    expect(projection.args).toEqual({})
    expect(projection.result).toEqual({ ok: true })
    expect(projection.artifacts).toEqual([])
    expect(JSON.stringify(projection)).not.toContain("/srv/private")
  })

  it("projects a text_to_speech receipt and its trusted media identically", async () => {
    const audio = "/home/alice/voice-memos/out/brief.mp3"
    const { projection, isError } = await parity({
      toolCallId: "tts-parity",
      name: "text_to_speech",
      args: { text: "Quarterly update" },
      result: {
        success: true,
        file_path: audio,
        file_paths: [audio],
        media_tag: `MEDIA:${audio}`,
        provider: "edge",
      },
    })

    expect(isError).toBe(false)
    expect(projection.result).toEqual({ status: "completed" })
    expect(projection.artifacts).toMatchObject([
      { filename: "brief.mp3", mimeType: "audio/mpeg" },
    ])
    expect(JSON.stringify(projection)).not.toContain(audio)
  })

  it("classifies a failed text_to_speech receipt identically", async () => {
    const { projection, isError } = await parity({
      toolCallId: "tts-failed-parity",
      name: "text_to_speech",
      args: { text: "Quarterly update" },
      result: { success: false, error: "voice unavailable" },
    })

    expect(isError).toBe(true)
    expect(projection.result).toEqual({ status: "failed" })
    expect(projection.artifacts).toEqual([])
  })

  it("projects a batched clarification and its recorded answers identically", async () => {
    const { projection } = await parity({
      toolCallId: "clarify-parity",
      name: "clarify",
      args: {
        questions: [
          {
            question: "Where do you live?",
            choices: ["Jerusalem", "Tel Aviv"],
            multi_select: false,
          },
        ],
      },
      result: {
        responses: [
          {
            question: "Where do you live?",
            choices_offered: ["Jerusalem", "Tel Aviv"],
            user_response: JSON.stringify(["Jerusalem"]),
          },
        ],
      },
    })

    expect(projection.toolName).toBe("question")
    expect(projection.args).toEqual({
      question: "1 question",
      questions: [
        {
          question: "Where do you live?",
          options: ["Jerusalem", "Tel Aviv"],
          allowFreeform: false,
          multiple: false,
        },
      ],
      allowFreeform: true,
    })
    expect(projection.result).toEqual({
      status: "answered",
      responses: [{ question: "Where do you live?", answers: ["Jerusalem"] }],
    })
  })

  it("normalizes a freeform clarification identically", async () => {
    const { projection } = await parity({
      toolCallId: "clarify-freeform-parity",
      name: "clarify",
      args: { question: "Anything else?" },
      result: {
        responses: [
          { question: "Anything else?", user_response: "Ship it tomorrow" },
        ],
      },
    })

    expect(projection.toolName).toBe("question")
    expect(projection.args).toEqual({
      question: "Anything else?",
      allowFreeform: true,
      multiple: false,
    })
    expect(projection.result).toEqual({
      status: "answered",
      responses: [
        { question: "Anything else?", answers: ["Ship it tomorrow"] },
      ],
    })
  })

  it("drops a credential-shaped clarification answer identically", async () => {
    const { projection } = await parity({
      toolCallId: "clarify-secret-parity",
      name: "clarify",
      args: { question: "Which token?" },
      result: {
        responses: [
          {
            question: "Which token?",
            user_response: JSON.stringify(["api_key=sk-live-abcdef"]),
          },
        ],
      },
    })

    expect(projection.result).toEqual({
      status: "cancelled",
      responses: [{ question: "Which token?", answers: [] }],
    })
    expect(JSON.stringify(projection)).not.toContain("sk-live")
  })

  it("applies the delegate_subagent description fallback identically", async () => {
    const { projection } = await parity({
      toolCallId: "delegate-parity",
      name: "delegate_task",
      args: { goal: "Inspect the ledger" },
      result: { ok: true },
    })

    expect(projection.toolName).toBe("delegate_subagent")
    expect(projection.args).toEqual({
      goal: "Inspect the ledger",
      description: "Inspect the ledger",
    })
    expect(projection.result).toEqual({ ok: true })
  })

  it("unwraps a tool-search bridge call identically", async () => {
    const { projection } = await parity({
      toolCallId: "bridge-parity",
      name: "tool_call",
      args: { name: "read_file", arguments: '{"path":"report.txt"}' },
      result: "contents",
      resultName: "read_file",
    })

    expect(projection.toolName).toBe("read_file")
    expect(projection.args).toEqual({ path: "report.txt" })
  })

  it("keeps an oversized bridge envelope unwrapped identically", async () => {
    const { projection } = await parity({
      toolCallId: "bridge-oversized-parity",
      name: "tool_call",
      args: {
        name: "read_file",
        arguments: JSON.stringify({ note: "x".repeat(70_000) }),
      },
      result: "contents",
    })

    expect(projection.toolName).toBe("tool_call")
  })
})

describe("Hermes native provider facts", () => {
  const openrouter = { provider: "openrouter", model: "anthropic/claude-safe" }

  /** Runs one turn over `frames`, on a Session Hermes reports running `info`. */
  async function turnEvents(
    frames: (t: ReturnType<typeof nativeTurn>) => unknown[],
    info: unknown = openrouter
  ) {
    const attachment = observation()
    const engine = new HermesTurnEngine(
      runtime({
        resume: async () => ({
          liveSessionId: "live-secret",
          running: false,
          info,
        }),
        observe: attachment.observe,
        submit: async () => {
          for (const frame of frames(nativeTurn("live-secret", 1)))
            attachment.publish("live-secret", frame)
          return {
            acknowledgement: "accepted" as const,
            status: "streaming" as const,
          }
        },
      })
    )
    const events = await collect(await engine.start(scope, input()))
    for (const event of events)
      expect(TurnEventSchema.safeParse(event).success).toBe(true)
    return events
  }

  it("ends the turn with cache usage and the cost Hermes priced it at", async () => {
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.frame("message.complete", {
        message_id: "m1",
        text: "",
        status: "complete",
        usage: {
          input: 10,
          output: 4,
          cache_read: 6,
          cache_write: 2,
          cost_usd: 0.0125,
        },
      }),
    ])

    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnEnded,
      stopReason: StopReason.EndTurn,
      usage: [
        {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 6,
          cachedWriteTokens: 2,
        },
      ],
      cost: { amount: 0.0125, currency: "USD" },
    })
  })

  it("names the Session's provider and model on a failed turn", async () => {
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.complete("m1", "", "error"),
      t.idle(),
    ])

    expect(ofKind(events, TurnEventKind.TurnFailed)).toMatchObject([
      { provider: "openrouter", model: "anthropic/claude-safe" },
    ])
  })

  it("reports a model change as the id the model option carries", async () => {
    const events = await turnEvents((t) => [
      t.frame("session.info", openrouter),
      t.messageStart("m1"),
      t.frame("session.info", { provider: "openrouter", model: "gpt-safe" }),
      t.complete("m1", ""),
    ])

    expect(ofKind(events, TurnEventKind.ModelChanged)).toEqual([
      {
        kind: TurnEventKind.ModelChanged,
        modelId: JSON.stringify(["openrouter", "gpt-safe"]),
      },
    ])
  })

  it("names, kinds, locates, and times a file edit and carries its diff", async () => {
    const path = "/workspace/app/notes.md"
    const diff = `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.toolStart("edit-1", "patch", { path, old_string: "old" }),
      t.frame("tool.complete", {
        tool_id: "edit-1",
        name: "patch",
        result: JSON.stringify({
          success: true,
          diff,
          files_modified: [path],
        }),
        duration_s: 1.2346,
      }),
      t.complete("m1", ""),
    ])

    expect(ofKind(events, TurnEventKind.ToolCallStarted)).toEqual([
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "edit-1",
        title: "patch",
        name: "patch",
        toolKind: ToolKind.Edit,
        locations: [{ path }],
        parentMessageId: "m1",
      },
    ])
    expect(ofKind(events, TurnEventKind.ToolCallFinished)).toMatchObject([
      {
        toolCallId: "edit-1",
        failed: false,
        durationMs: 1235,
        diffs: [
          {
            changes: [{ operation: "modify", path }],
            patch: diff,
          },
        ],
      },
    ])
  })

  it("locates and diffs an edit under the operator's home directory", async () => {
    const path = "/home/operator/project/notes.md"
    const diff = `--- a${path}\n+++ b${path}\n@@ -1 +1 @@\n-old\n+new\n`
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.toolStart("edit-1", "patch", { path, old_string: "old" }),
      t.toolComplete("edit-1", "patch", {
        success: true,
        diff,
        files_modified: [path],
      }),
      t.complete("m1", ""),
    ])

    expect(ofKind(events, TurnEventKind.ToolCallStarted)).toMatchObject([
      { toolCallId: "edit-1", locations: [{ path }] },
    ])
    expect(ofKind(events, TurnEventKind.ToolCallFinished)).toMatchObject([
      {
        toolCallId: "edit-1",
        diffs: [{ changes: [{ operation: "modify", path }], patch: diff }],
      },
    ])
  })

  it("keeps a credential out of locations and diffs", async () => {
    const path = "/workspace/token=ghp_leaked/notes.md"
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.toolStart("edit-1", "write_file", { path, content: "x" }),
      t.toolComplete("edit-1", "write_file", {
        bytes_written: 1,
        files_modified: [path],
      }),
      t.toolStart("edit-2", "patch", { path: "/workspace/.env" }),
      t.toolComplete("edit-2", "patch", {
        success: true,
        diff: "--- a/workspace/.env\n+++ b/workspace/.env\n+API_KEY=sk-leaked\n",
        files_modified: ["/workspace/.env"],
      }),
      t.complete("m1", ""),
    ])

    const [first, second] = ofKind(events, TurnEventKind.ToolCallFinished)
    expect(
      ofKind(events, TurnEventKind.ToolCallStarted)[0]?.locations
    ).toBeUndefined()
    expect(first?.diffs).toBeUndefined()
    expect(second?.diffs).toEqual([
      {
        changes: [{ operation: "modify", path: "/workspace/.env" }],
      },
    ])
    expect(JSON.stringify(events)).not.toContain("leaked")
  })

  it("streams a background process as the terminal of its call", async () => {
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.toolStart("run-1", "terminal", {
        command: "npm run dev",
        background: true,
      }),
      // Hermes restates the call's arguments when it completes.
      t.frame("tool.complete", {
        tool_id: "run-1",
        name: "terminal",
        args: { command: "npm run dev", background: true },
        result: JSON.stringify({
          output: "Background process started",
          session_id: "proc_1",
          pid: 7,
          exit_code: 0,
        }),
      }),
      t.frame("agent.terminal.output", {
        process_id: "proc_1",
        chunk: "\u001b[32mready\u001b[0m\n",
      }),
      t.frame("agent.terminal.output", { process_id: "proc_2", chunk: "x" }),
      t.frame("terminal.close", { process_id: "proc_1" }),
      t.complete("m1", ""),
    ])

    const terminal = { terminalId: "run-1:terminal", toolCallId: "run-1" }
    expect(ofKind(events, TurnEventKind.TerminalOutput)).toEqual([
      {
        kind: TurnEventKind.TerminalOutput,
        ...terminal,
        command: "npm run dev",
      },
      { kind: TurnEventKind.TerminalOutput, ...terminal, data: "ready\n" },
      { kind: TurnEventKind.TerminalOutput, ...terminal, exit: {} },
    ])
    const kinds = events.map((event) => (event as { kind: string }).kind)
    expect(kinds.indexOf(TurnEventKind.TerminalOutput)).toBeLessThan(
      kinds.indexOf(TurnEventKind.ToolCallFinished)
    )
  })

  it("reports one compaction per compacting run of status updates", async () => {
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.frame("status.update", { kind: "compacting", text: "Compacting" }),
      t.frame("status.update", { kind: "compacting", text: "Compacting" }),
      t.frame("status.update", { kind: "compacted", text: "Done" }),
      t.frame("status.update", { kind: "compacting", text: "Compacting" }),
      t.frame("status.update", { kind: "compacted", text: "Done" }),
      t.complete("m1", ""),
    ])

    expect(ofKind(events, TurnEventKind.CompactionUpdated)).toEqual([
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "run-1:compaction:1",
        status: "started",
      },
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "run-1:compaction:1",
        status: "completed",
      },
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "run-1:compaction:2",
        status: "started",
      },
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "run-1:compaction:2",
        status: "completed",
      },
    ])
  })

  it("cancels a compaction Hermes never confirmed when the turn ends", async () => {
    // Hermes' gateway tags a threshold notice as `compacting` and never
    // follows it with `compacted`.
    const events = await turnEvents((t) => [
      t.frame("status.update", {
        kind: "compacting",
        text: "Auto-compaction was raised to 85% before summarizing.",
      }),
      t.messageStart("m1"),
      t.complete("m1", "Done"),
    ])

    expect(ofKind(events, TurnEventKind.CompactionUpdated)).toEqual([
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "run-1:compaction:1",
        status: "started",
      },
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "run-1:compaction:1",
        status: "cancelled",
      },
    ])
    const kinds = events.map((event) => (event as { kind: string }).kind)
    expect(kinds.lastIndexOf(TurnEventKind.CompactionUpdated)).toBeLessThan(
      kinds.indexOf(TurnEventKind.TurnEnded)
    )
  })

  it("reports a delegated subagent on the call that spawned it", async () => {
    const events = await turnEvents((t) => [
      t.messageStart("m1"),
      t.toolStart("delegate-1", "delegate_task", { goal: "Inspect" }),
      t.frame("subagent.start", {
        subagent_id: "sa-1",
        goal: "Inspect",
        depth: 0,
        model: "claude-safe",
      }),
      t.frame("subagent.start", { subagent_id: "sa-deep", depth: 1 }),
      t.frame("subagent.complete", {
        subagent_id: "sa-1",
        depth: 0,
        status: "completed",
        summary: "Looks fine",
        input_tokens: 30,
        output_tokens: 12,
        duration_seconds: 2.5,
        files_read: [
          "/workspace/app/a.ts",
          "/home/operator/b.ts",
          "/workspace/token=ghp_leaked",
        ],
      }),
      t.toolComplete("delegate-1", "delegate_task", { results: [] }),
      t.complete("m1", ""),
    ])

    expect(ofKind(events, TurnEventKind.SubagentUpdated)).toEqual([
      {
        kind: TurnEventKind.SubagentUpdated,
        toolCallId: "delegate-1",
        subagent: {
          id: "sa-1",
          goal: "Inspect",
          model: "claude-safe",
          depth: 1,
          status: "running",
        },
      },
      {
        kind: TurnEventKind.SubagentUpdated,
        toolCallId: "delegate-1",
        subagent: {
          id: "sa-1",
          depth: 1,
          status: "completed",
          tokens: 42,
          filesRead: ["/workspace/app/a.ts", "/home/operator/b.ts"],
          durationMs: 2500,
          summary: "Looks fine",
        },
      },
    ])
  })
})
