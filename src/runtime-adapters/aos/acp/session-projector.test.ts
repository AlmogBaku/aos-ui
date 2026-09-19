import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import { AOS_METHODS, AOS_PLAN_ID, AOS_STOP_REASONS } from "@aos/protocol/acp"

import { ARTIFACT_DATA_PART_NAME } from "@/artifacts/artifacts"
import { STEER_ACCEPTED_DATA_NAME } from "@/components/assistant-ui/elements/message-queue"

import {
  applyNotification,
  applyUpdate,
  initialProjectorState,
  messageBlocks,
  renameMessage,
  retainBefore,
  retainMessages,
  toThreadMessages,
  type ProjectorState,
} from "./session-projector"

const RUN_META = { sequence: 0, runId: "run-1" }
const TOOL_META = { ...RUN_META, messageId: "a1" }

type Entry = readonly [SessionUpdate, unknown?]

const fold = (entries: readonly Entry[], from = initialProjectorState) =>
  entries.reduce<ProjectorState>(
    (state, [update, meta]) => applyUpdate(state, update, meta),
    from
  )

const userChunk = (messageId: string, text: string): Entry => [
  {
    sessionUpdate: "user_message_chunk",
    messageId,
    content: { type: "text", text },
  },
  RUN_META,
]

const agentChunk = (messageId: string, text: string): Entry => [
  {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  },
  RUN_META,
]

const thoughtChunk = (messageId: string, text: string): Entry => [
  {
    sessionUpdate: "agent_thought_chunk",
    messageId,
    content: { type: "text", text },
  },
  RUN_META,
]

const toolCall = (patch: Record<string, unknown>, meta: unknown): Entry => [
  { sessionUpdate: "tool_call_update", toolCallId: "t1", ...patch },
  meta,
]

const stateUpdate = (
  patch: Record<string, unknown>,
  meta: unknown = RUN_META
): Entry => [{ sessionUpdate: "state_update", ...patch }, meta]

const ARTIFACT = {
  id: "art-1",
  filename: "chart.json",
  mimeType: "application/json",
  source: { type: "inline", encoding: "utf8", data: "{}" },
} as const

describe("applyUpdate messages", () => {
  const cases: {
    name: string
    entries: readonly Entry[]
    expected: unknown
  }[] = [
    {
      name: "a user chunk opens a user turn",
      entries: [userChunk("u1", "Hi")],
      expected: [
        { id: "u1", role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    },
    {
      name: "chunks of one kind extend one part in arrival order",
      entries: [agentChunk("a1", "Hel"), agentChunk("a1", "lo")],
      expected: [
        {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    },
    {
      name: "streamed thoughts and prose share the turn they belong to",
      entries: [
        thoughtChunk("a1", "Think"),
        thoughtChunk("a1", "ing"),
        agentChunk("a1", "Ans"),
        agentChunk("a1", "wer"),
      ],
      expected: [
        {
          id: "a1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Thinking" },
            { type: "text", text: "Answer" },
          ],
        },
      ],
    },
    {
      name: "a whole thought upsert and a whole message upsert compose",
      entries: [
        [
          {
            sessionUpdate: "agent_thought",
            messageId: "a1",
            content: [{ type: "text", text: "Weigh it" }],
          },
        ],
        [
          {
            sessionUpdate: "agent_message",
            messageId: "a1",
            content: [{ type: "text", text: "Done." }],
          },
        ],
      ],
      expected: [
        {
          id: "a1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Weigh it" },
            { type: "text", text: "Done." },
          ],
        },
      ],
    },
    {
      name: "a whole upsert leaves the other kind's parts alone",
      entries: [
        thoughtChunk("a1", "Thinking"),
        agentChunk("a1", "draft"),
        [
          {
            sessionUpdate: "agent_message",
            messageId: "a1",
            content: [{ type: "text", text: "final" }],
          },
        ],
      ],
      expected: [
        {
          id: "a1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Thinking" },
            { type: "text", text: "final" },
          ],
        },
      ],
    },
    {
      name: "a whole upsert replaces the streamed content",
      entries: [
        agentChunk("a1", "draft"),
        [
          {
            sessionUpdate: "agent_message",
            messageId: "a1",
            content: [{ type: "text", text: "final" }],
          },
        ],
      ],
      expected: [
        {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "final" }],
        },
      ],
    },
    {
      name: "a null content upsert clears the turn",
      entries: [
        agentChunk("a1", "draft"),
        [{ sessionUpdate: "agent_message", messageId: "a1", content: null }],
      ],
      expected: [{ id: "a1", role: "assistant", content: [] }],
    },
    {
      name: "an empty content upsert clears the turn",
      entries: [
        agentChunk("a1", "draft"),
        [{ sessionUpdate: "agent_message", messageId: "a1", content: [] }],
      ],
      expected: [{ id: "a1", role: "assistant", content: [] }],
    },
    {
      name: "an inline image projects as an image part",
      entries: [
        [
          {
            sessionUpdate: "user_message",
            messageId: "u1",
            content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
          },
        ],
      ],
      expected: [
        {
          id: "u1",
          role: "user",
          content: [{ type: "image", image: "data:image/png;base64,AAAA" }],
        },
      ],
    },
    {
      name: "a staged attachment reference projects as a file part",
      entries: [
        [
          {
            sessionUpdate: "user_message",
            messageId: "u1",
            content: [
              {
                type: "resource_link",
                uri: "aos-attachment:stage-1/att-1",
                name: "notes.txt",
                mimeType: "text/plain",
              },
            ],
          },
        ],
      ],
      expected: [
        {
          id: "u1",
          role: "user",
          content: [
            {
              type: "file",
              data: "aos-attachment:stage-1/att-1",
              mimeType: "text/plain",
              filename: "notes.txt",
            },
          ],
        },
      ],
    },
  ]

  for (const { name, entries, expected } of cases) {
    it(name, () => {
      expect(toThreadMessages(fold(entries))).toEqual(expected)
    })
  }

  it("keeps the state when a whole upsert omits content", () => {
    const streamed = fold([agentChunk("a1", "draft")])
    const next = applyUpdate(
      streamed,
      { sessionUpdate: "agent_message", messageId: "a1" },
      RUN_META
    )
    expect(next).toBe(streamed)
  })

  it("ignores an update kind it does not project", () => {
    const streamed = fold([agentChunk("a1", "draft")])
    expect(
      applyUpdate(streamed, { sessionUpdate: "terminal_update" }, RUN_META)
    ).toBe(streamed)
  })

  it("keeps unchanged turns reference-equal across updates", () => {
    const first = fold([userChunk("u1", "Hi")])
    const second = fold([agentChunk("a1", "Hello")], first)
    expect(toThreadMessages(second)[0]).toBe(toThreadMessages(first)[0])
    expect(toThreadMessages(second)[1]).not.toBe(undefined)
  })
})

describe("applyUpdate tool calls", () => {
  const started = fold([
    agentChunk("a1", "Working"),
    toolCall({ title: "grep", status: "in_progress" }, TOOL_META),
  ])

  it("creates the call on the message its meta names", () => {
    expect(toThreadMessages(started)).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "Working" },
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "grep",
            args: {},
            isError: false,
          },
        ],
      },
    ])
  })

  it("starts a new part for a chunk that follows a tool call", () => {
    const resumed = fold([agentChunk("a1", "Done")], started)
    expect(toThreadMessages(resumed)[0]).toMatchObject({
      content: [
        { type: "text", text: "Working" },
        { type: "tool-call", toolCallId: "t1" },
        { type: "text", text: "Done" },
      ],
    })
  })

  it("falls back to the latest assistant turn without meta", () => {
    const fallback = fold(
      [toolCall({ title: "grep" }, undefined)],
      fold([agentChunk("a9", "Working")])
    )
    expect(toThreadMessages(fallback)[0]).toMatchObject({
      id: "a9",
      content: [{ type: "text", text: "Working" }, { toolCallId: "t1" }],
    })
  })

  it("drops a call with no turn to hang it off", () => {
    expect(fold([toolCall({ title: "grep" }, undefined)])).toBe(
      initialProjectorState
    )
  })

  it("accumulates argsText from deltas and replaces it when given whole", () => {
    const streaming = fold(
      [
        toolCall({}, { ...TOOL_META, argsTextDelta: '{"q":' }),
        toolCall({}, { ...TOOL_META, argsTextDelta: '"a"}' }),
      ],
      started
    )
    expect(toThreadMessages(streaming)[0]).toMatchObject({
      content: [{ type: "text" }, { argsText: '{"q":"a"}' }],
    })
    const settled = fold(
      [
        toolCall(
          {
            rawInput: { q: "a" },
            status: "completed",
            rawOutput: { ok: true },
          },
          { ...TOOL_META, argsText: '{"q": "a"}' }
        ),
      ],
      streaming
    )
    expect(toThreadMessages(settled)[0]).toMatchObject({
      content: [
        { type: "text" },
        {
          toolCallId: "t1",
          toolName: "grep",
          args: { q: "a" },
          argsText: '{"q": "a"}',
          result: { ok: true },
          isError: false,
        },
      ],
    })
  })

  it("patches only the fields the update carries", () => {
    const failed = fold(
      [
        toolCall(
          { status: "failed", rawOutput: { status: "failed" } },
          TOOL_META
        ),
      ],
      started
    )
    expect(toThreadMessages(failed)[0]).toMatchObject({
      content: [{ type: "text" }, { toolName: "grep", isError: true }],
    })
    const cleared = fold([toolCall({ title: null }, TOOL_META)], failed)
    expect(toThreadMessages(cleared)[0]).toMatchObject({
      content: [{ type: "text" }, { toolName: "t1", isError: true }],
    })
  })

  it("appends streamed tool content as the result it stands in for", () => {
    const streamed = fold(
      [
        [
          {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "t1",
            content: {
              type: "content",
              content: { type: "text", text: "line" },
            },
          },
          RUN_META,
        ],
      ],
      started
    )
    expect(toThreadMessages(streamed)[0]).toMatchObject({
      content: [{ type: "text" }, { toolCallId: "t1", result: "line" }],
    })
  })
})

describe("applyUpdate execution", () => {
  /** One finished turn, exactly as a replay from the start projects it. */
  const replayed = fold([
    userChunk("u1", "Hi"),
    stateUpdate({ state: "running" }),
    agentChunk("a1", "Hello"),
    stateUpdate({ state: "idle", stopReason: "end_turn" }),
  ])
  const COMPLETE = { status: { type: "complete", reason: "stop" } }
  /** The next run, with the turn its first chunk opened. */
  const answering = fold(
    [stateUpdate({ state: "running" }), agentChunk("a2", "Sure")],
    replayed
  )
  /** A run blocked before it wrote anything, and the turn hosting its ask. */
  const interrupted = fold(
    [
      stateUpdate({ state: "running" }),
      stateUpdate({ state: "requires_action" }),
    ],
    replayed
  )

  it("opens the turn the running run streams into", () => {
    expect(answering.execution).toEqual({ status: "running", runId: "run-1" })
    expect(toThreadMessages(answering)[2]).toMatchObject({
      id: "a2",
      status: { type: "running" },
    })
  })

  it("opens the turn a running run's first tool call belongs to", () => {
    const working = fold(
      [
        stateUpdate({ state: "running" }),
        toolCall({ title: "grep" }, { ...RUN_META, messageId: "a2" }),
      ],
      replayed
    )
    expect(toThreadMessages(working)[2]).toMatchObject({
      id: "a2",
      status: { type: "running" },
    })
  })

  it("leaves the finished turn behind a starting run finished", () => {
    const started = fold([stateUpdate({ state: "running" })], replayed)
    expect(started.execution).toEqual({ status: "running", runId: "run-1" })
    expect(started.messages).toBe(replayed.messages)
    expect(toThreadMessages(started)[1]).toMatchObject(COMPLETE)
  })

  it("reports a blocked run as waiting for input", () => {
    const blocked = fold([stateUpdate({ state: "requires_action" })], answering)
    expect(blocked.execution).toEqual({
      status: "waiting-for-input",
      runId: "run-1",
    })
    expect(toThreadMessages(blocked)[2]).toMatchObject({
      status: { type: "requires-action", reason: "interrupt" },
    })
  })

  it("hosts an interrupt that arrives before the run's first turn", () => {
    const messages = toThreadMessages(interrupted)
    expect(messages).toHaveLength(3)
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: [],
      status: { type: "requires-action", reason: "interrupt" },
    })
    expect(messages[1]).toMatchObject(COMPLETE)
    // The hosted turn is the one the run settles when it ends.
    const ended = fold(
      [stateUpdate({ state: "idle", stopReason: "end_turn" })],
      interrupted
    )
    expect(toThreadMessages(ended)[2]).toMatchObject(COMPLETE)
  })

  it("replaces an empty interrupt host with the resumed run's first turn", () => {
    const resumed = fold(
      [stateUpdate({ state: "running" }), agentChunk("a2", "Allowed")],
      interrupted
    )
    const messages = toThreadMessages(resumed)
    expect(messages).toHaveLength(3)
    expect(messages[2]).toMatchObject({
      id: "a2",
      role: "assistant",
      content: [{ type: "text", text: "Allowed" }],
      status: { type: "running" },
    })
    expect(messages[1]).toMatchObject(COMPLETE)
    const ended = fold(
      [stateUpdate({ state: "idle", stopReason: "end_turn" })],
      resumed
    )
    expect(toThreadMessages(ended)[2]).toMatchObject(COMPLETE)

    // A resumed run streams its answer without announcing a new running state,
    // so the host it takes over keeps the pending status until the run settles.
    const unannounced = fold([agentChunk("a2", "Allowed")], interrupted)
    expect(toThreadMessages(unannounced)).toHaveLength(3)
    expect(toThreadMessages(unannounced)[2]).toMatchObject({
      id: "a2",
      content: [{ type: "text", text: "Allowed" }],
      status: { type: "requires-action", reason: "interrupt" },
    })
    const settled = fold(
      [stateUpdate({ state: "idle", stopReason: "end_turn" })],
      unannounced
    )
    expect(toThreadMessages(settled)[2]).toMatchObject(COMPLETE)
  })

  it("keeps an interrupt host the run has already written into", () => {
    // The call the interrupt asked about belongs to the hosted turn, so the
    // turn the run opens next is its own.
    const resumed = fold(
      [
        toolCall({ title: "grep" }, undefined),
        stateUpdate({ state: "running" }),
        agentChunk("a2", "Allowed"),
      ],
      interrupted
    )
    const messages = toThreadMessages(resumed)
    expect(messages).toHaveLength(4)
    expect(messages[2]).toMatchObject({
      content: [{ type: "tool-call", toolCallId: "t1" }],
    })
    expect(messages[3]).toMatchObject({
      id: "a2",
      content: [{ type: "text", text: "Allowed" }],
      status: { type: "running" },
    })
  })

  it("completes the turn when the run ends its turn", () => {
    const idle = fold(
      [stateUpdate({ state: "idle", stopReason: "end_turn" })],
      answering
    )
    expect(idle.execution).toEqual({
      status: "idle",
      runId: "run-1",
      stopReason: "end_turn",
    })
    expect(toThreadMessages(idle)[2]).toMatchObject(COMPLETE)
  })

  it("leaves the history alone when a run ends without a turn", () => {
    const started = fold([stateUpdate({ state: "running" })], replayed)
    const ended = fold(
      [stateUpdate({ state: "idle", stopReason: "cancelled" })],
      started
    )
    expect(ended.execution.status).toBe("idle")
    expect(ended.messages).toBe(replayed.messages)
    expect(toThreadMessages(ended)[1]).toMatchObject(COMPLETE)
  })

  it("fails the Session on a vendor error stop reason", () => {
    const failed = fold(
      [
        stateUpdate(
          { state: "idle", stopReason: AOS_STOP_REASONS.error },
          {
            ...RUN_META,
            code: "provider_error",
            message: "Broke",
          }
        ),
      ],
      answering
    )
    expect(failed.execution).toEqual({
      status: "failed",
      runId: "run-1",
      stopReason: AOS_STOP_REASONS.error,
      error: { code: "provider_error", message: "Broke" },
    })
    expect(toThreadMessages(failed)[2]).toMatchObject({
      status: {
        type: "incomplete",
        reason: "error",
        error: { code: "provider_error", message: "Broke" },
      },
    })
  })

  it("fails the Session on an uncertain stop reason", () => {
    const uncertain = fold(
      [stateUpdate({ state: "idle", stopReason: AOS_STOP_REASONS.uncertain })],
      answering
    )
    expect(uncertain.execution.status).toBe("failed")
  })

  it("marks a cancelled turn incomplete and the Session idle", () => {
    const cancelled = fold(
      [stateUpdate({ state: "idle", stopReason: "cancelled" })],
      answering
    )
    expect(cancelled.execution.status).toBe("idle")
    expect(toThreadMessages(cancelled)[2]).toMatchObject({
      status: { type: "incomplete", reason: "cancelled" },
    })
  })

  it("ignores a state it does not know", () => {
    expect(fold([stateUpdate({ state: "_compacting" })], answering)).toBe(
      answering
    )
  })
})

describe("applyUpdate Session metadata", () => {
  const plan = (planId: string) => ({
    sessionUpdate: "plan_update" as const,
    plan: {
      type: "items",
      planId,
      entries: [{ content: "Ship", priority: "medium", status: "in_progress" }],
    },
  })
  const todos = [{ id: "todo-1", label: "Ship", status: "active" }]

  it("takes the Session Todos from the plan meta", () => {
    const planned = fold([[plan(AOS_PLAN_ID), { ...RUN_META, todos }]])
    expect(planned.todos).toEqual(todos)
  })

  it("ignores a plan that is not the Session's own", () => {
    expect(fold([[plan("other"), { ...RUN_META, todos }]])).toBe(
      initialProjectorState
    )
  })

  it("ignores a plan whose meta has no Todos", () => {
    expect(fold([[plan(AOS_PLAN_ID), RUN_META]])).toBe(initialProjectorState)
  })

  it("records usage, title, config options, and commands", () => {
    const projected = fold([
      [{ sessionUpdate: "usage_update", used: 10, size: 100 }, RUN_META],
      [{ sessionUpdate: "session_info_update", title: "Ship it" }],
      [
        {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              type: "select",
              configId: "model",
              name: "Model",
              value: "sonnet",
              options: [],
            },
          ],
        },
      ],
      [
        {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "plan", description: "Plan the work" }],
        },
      ],
    ])
    expect(projected.usage).toEqual({ used: 10, size: 100 })
    expect(projected.title).toBe("Ship it")
    expect(projected.configOptions).toEqual([
      {
        type: "select",
        configId: "model",
        name: "Model",
        value: "sonnet",
        options: [],
      },
    ])
    expect(projected.commands).toEqual([
      { name: "plan", description: "Plan the work" },
    ])
  })

  it("clears a title the Session dropped", () => {
    const named = fold([
      [{ sessionUpdate: "session_info_update", title: "Ship" }],
    ])
    const cleared = fold(
      [[{ sessionUpdate: "session_info_update", title: null }]],
      named
    )
    expect(cleared.title).toBeUndefined()
  })

  it("ignores config options it cannot read", () => {
    const projected = fold([
      [
        {
          sessionUpdate: "config_option_update",
          configOptions: [{ type: "select" }],
        },
      ],
    ])
    expect(projected.configOptions).toBeUndefined()
  })
})

describe("applyNotification", () => {
  const answered = fold([userChunk("u1", "Hi"), agentChunk("a1", "Hello")])

  it("appends an artifact to the message it names", () => {
    const withArtifact = applyNotification(
      answered,
      AOS_METHODS.notify.artifact,
      { sessionId: "s1", ...RUN_META, messageId: "a1", artifact: ARTIFACT }
    )
    expect(toThreadMessages(withArtifact)[1]).toMatchObject({
      content: [
        { type: "text", text: "Hello" },
        { type: "data", name: ARTIFACT_DATA_PART_NAME, data: ARTIFACT },
      ],
    })
  })

  it("appends an unaddressed artifact to the latest assistant turn", () => {
    const withArtifact = applyNotification(
      answered,
      AOS_METHODS.notify.artifact,
      { sessionId: "s1", ...RUN_META, artifact: ARTIFACT }
    )
    expect(toThreadMessages(withArtifact)[1]).toMatchObject({
      content: [{ type: "text" }, { name: ARTIFACT_DATA_PART_NAME }],
    })
  })

  it("appends an accepted steer to the latest assistant turn", () => {
    const params = {
      sessionId: "s1",
      ...RUN_META,
      requestId: "steer-1",
      text: "Also check the logs",
      delivery: "steered",
    }
    const steered = applyNotification(
      answered,
      AOS_METHODS.notify.steerAccepted,
      params
    )
    expect(toThreadMessages(steered)[1]).toMatchObject({
      content: [
        { type: "text" },
        { type: "data", name: STEER_ACCEPTED_DATA_NAME, data: params },
      ],
    })
  })

  it("ignores a malformed payload and an unknown method", () => {
    expect(
      applyNotification(answered, AOS_METHODS.notify.artifact, {
        sessionId: "s1",
      })
    ).toBe(answered)
    expect(
      applyNotification(answered, AOS_METHODS.notify.activity, {
        sessionId: "s1",
      })
    ).toBe(answered)
  })
})

describe("local turn bookkeeping", () => {
  const sent = fold([userChunk("local-1", "Hi"), agentChunk("a1", "Hello")])

  it("re-keys an optimistic turn onto the provider id", () => {
    const rekeyed = renameMessage(sent, "local-1", "u1")
    expect(toThreadMessages(rekeyed)[0]).toMatchObject({ id: "u1" })
  })

  it("drops the optimistic turn when the echo already arrived", () => {
    const echoed = fold([userChunk("u1", "Hi")], sent)
    const rekeyed = renameMessage(echoed, "local-1", "u1")
    expect(toThreadMessages(rekeyed).map((message) => message.id)).toEqual([
      "a1",
      "u1",
    ])
  })

  it("retains only the turns the runtime kept", () => {
    expect(
      toThreadMessages(retainMessages(sent, ["local-1"])).map((m) => m.id)
    ).toEqual(["local-1"])
    expect(retainMessages(sent, ["local-1", "a1"])).toBe(sent)
  })

  it("keeps only the turns before the one a rewind replaces", () => {
    expect(
      toThreadMessages(retainBefore(sent, "a1")).map((message) => message.id)
    ).toEqual(["local-1"])
    expect(retainBefore(sent, "missing")).toBe(sent)
  })

  it("hands back the blocks a turn was sent with", () => {
    expect(messageBlocks(sent, "local-1")).toEqual([
      { type: "text", text: "Hi" },
    ])
    expect(messageBlocks(sent, "missing")).toEqual([])
  })
})
