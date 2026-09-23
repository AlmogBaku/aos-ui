import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import type { ToolCallMessagePart } from "@assistant-ui/core"
import { describe, expect, it } from "vitest"

import { AOS_METHODS, AOS_PLAN_ID, AOS_STOP_REASONS } from "@aos/protocol/acp"

import { ARTIFACT_DATA_PART_NAME } from "@/artifacts/artifacts"
import { COMPACTION_DATA_PART_NAME } from "@/components/assistant-ui/elements/compaction-divider"
import { steerMessageId } from "@/components/assistant-ui/elements/message-queue"
import { isMcpAppToolPart } from "@/components/mcp-apps/tool-part"
import { permissionProviderMetadata } from "@/components/tool-ui/payloads/permission"
import { readAosToolArtifact } from "@/components/tool-ui/tool-artifact"

import type { AcpApproval } from "./acp-approvals"
import { TERMINAL_TAIL_LIMIT } from "./projector-terminals"

import {
  applyApprovals,
  applyNotification,
  applyUpdate,
  clearTranscript,
  failLatestTurn,
  initialProjectorState,
  LOCAL_PROMPT_PREFIX,
  messageBlocks,
  prependMessages,
  renameMessage,
  retainBefore,
  retainMessages,
  toThreadMessages,
  type ProjectorState,
} from "./session-projector"

const TURN_META = { sequence: 0, turnId: "run-1" }
const TOOL_META = { ...TURN_META, messageId: "a1" }

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
  TURN_META,
]

const agentChunk = (messageId: string, text: string): Entry => [
  {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  },
  TURN_META,
]

const thoughtChunk = (messageId: string, text: string): Entry => [
  {
    sessionUpdate: "agent_thought_chunk",
    messageId,
    content: { type: "text", text },
  },
  TURN_META,
]

const toolCall = (patch: Record<string, unknown>, meta: unknown): Entry => [
  { sessionUpdate: "tool_call_update", toolCallId: "t1", ...patch },
  meta,
]

const stateUpdate = (
  patch: Record<string, unknown>,
  meta: unknown = TURN_META
): Entry => [{ sessionUpdate: "state_update", ...patch }, meta]

/** The artifact data part a published link projects as. */
const ARTIFACT = {
  id: "art-1",
  filename: "chart.json",
  mimeType: "application/json",
  source: { type: "provider", reference: "art-1" },
} as const

/** A published artifact as the proxy streams it: a `resource_link` to its id. */
const artifactLink = (
  messageId: string,
  extra: { uri?: string; size?: number } = {},
  sessionUpdate:
    "agent_message_chunk" | "user_message_chunk" = "agent_message_chunk"
): Entry => [
  {
    sessionUpdate,
    messageId,
    content: {
      type: "resource_link",
      uri: "artifact://art-1",
      name: "chart.json",
      mimeType: "application/json",
      ...extra,
    },
  },
  TURN_META,
]

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
      TURN_META
    )
    expect(next).toBe(streamed)
  })

  it("ignores an update kind it does not project", () => {
    const streamed = fold([agentChunk("a1", "draft")])
    expect(
      applyUpdate(streamed, { sessionUpdate: "terminal_update" }, TURN_META)
    ).toBe(streamed)
  })

  it("fails a replayed turn as the run that wrote it reported it", () => {
    const error = { code: "provider_error", message: "Broke" }
    const history = { sequence: 0, turnId: "history" }
    const replayed = fold([
      stateUpdate({ state: "running" }, history),
      agentChunk("a1", "Half an answer"),
      stateUpdate(
        { state: "idle", stopReason: AOS_STOP_REASONS.error },
        { ...history, ...error }
      ),
    ])

    expect(toThreadMessages(replayed)[0]?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error,
    })
    // A replay brackets each turn with its own state updates, so the Session is
    // left in the state the last one reported.
    expect(replayed.execution).toEqual({
      status: "failed",
      turnId: "history",
      stopReason: AOS_STOP_REASONS.error,
      error,
    })
  })

  it("shows a failure awaiting Stop while the Session stays running", () => {
    const error = {
      code: "AOS_INTERACTION_LOST",
      message: "Stop the turn to continue.",
    }
    const failing = fold([
      userChunk("u1", "Pick a branch"),
      stateUpdate({ state: "running" }),
      stateUpdate({ state: "running" }, { ...TURN_META, ...error }),
    ])

    expect(failing.execution).toMatchObject({
      status: "running",
      turnId: "run-1",
      error,
    })
    const hosted = toThreadMessages(failing).at(-1)
    expect(hosted?.role).toBe("assistant")
    expect(hosted?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error,
    })

    // Stopping the turn ends it, and the failure it reported stays on it.
    const stopped = fold(
      [
        stateUpdate(
          { state: "running" },
          { ...TURN_META, execution: "stopping" }
        ),
        stateUpdate({ state: "idle", stopReason: "cancelled" }),
      ],
      failing
    )
    expect(stopped.execution).toMatchObject({ status: "failed", error })
    expect(toThreadMessages(stopped).at(-1)?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error,
    })
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

  it("settles a call on the turn that holds it when the update names no message", () => {
    const answered = fold(
      [
        agentChunk("a2", "Thanks"),
        toolCall(
          { status: "completed", rawOutput: { status: "answered" } },
          undefined
        ),
      ],
      started
    )
    expect(toThreadMessages(answered)).toMatchObject([
      {
        id: "a1",
        content: [
          { type: "text", text: "Working" },
          {
            toolCallId: "t1",
            toolName: "grep",
            result: { status: "answered" },
          },
        ],
      },
      { id: "a2", content: [{ type: "text", text: "Thanks" }] },
    ])
  })

  it("settles a call a later segment re-announces on the turn that holds it", () => {
    const resumed = fold(
      [
        toolCall(
          { title: "grep", status: "in_progress" },
          { ...TURN_META, messageId: "a2" }
        ),
        toolCall(
          { status: "completed", rawOutput: { status: "answered" } },
          { ...TURN_META, messageId: "run-2" }
        ),
      ],
      started
    )
    expect(toThreadMessages(resumed)).toMatchObject([
      {
        id: "a1",
        content: [
          { type: "text", text: "Working" },
          {
            toolCallId: "t1",
            toolName: "grep",
            result: { status: "answered" },
          },
        ],
      },
    ])
  })

  it("carries a declared MCP App view as the part's artifact flag", () => {
    const flagged = fold([
      agentChunk("a1", "Working"),
      toolCall({ title: "show_board" }, { ...TOOL_META, app: {} }),
      toolCall({ status: "completed", rawOutput: "done" }, TOOL_META),
    ])
    expect(toThreadMessages(flagged)[0]?.content[1]).toMatchObject({
      toolCallId: "t1",
      artifact: { aos: { app: {} } },
    })
    const running = fold([
      agentChunk("a1", "Working"),
      toolCall({ title: "show_board" }, { ...TOOL_META, app: {} }),
    ])
    expect(toThreadMessages(running)[0]?.content[1]).toMatchObject({
      artifact: { aos: { app: {} } },
    })
    expect(toThreadMessages(running)[0]?.content[1]).not.toHaveProperty(
      "artifact.aos.app.settled"
    )
    expect(toThreadMessages(started)[0]?.content[1]).not.toHaveProperty(
      "artifact"
    )
  })

  it("keeps an App call's ACP facts with its App flag", () => {
    const part = toThreadMessages(
      fold([
        agentChunk("a1", "Working"),
        toolCall(
          { title: "show_board", kind: "fetch" },
          { ...TOOL_META, app: {} }
        ),
      ])
    )[0]?.content[1]
    expect(isMcpAppToolPart(part as { artifact?: unknown })).toBe(true)
    expect(
      readAosToolArtifact((part as { artifact?: unknown }).artifact)
    ).toEqual({ kind: "fetch", app: {} })
  })

  it("marks an App call settled when it completes without a result", () => {
    // A guest's App call arrives without its input or output.
    const settled = fold([
      agentChunk("a1", "Working"),
      toolCall({ title: "show_board" }, { ...TOOL_META, app: {} }),
      toolCall({ status: "completed" }, TOOL_META),
    ])
    const part = toThreadMessages(settled)[0]?.content[1]
    expect(part).toMatchObject({
      artifact: { aos: { app: { settled: true } } },
    })
    expect(part).not.toHaveProperty("result")
  })

  it("marks an App call cancelled when it fails without a result", () => {
    const failed = fold([
      agentChunk("a1", "Working"),
      toolCall({ title: "show_board" }, { ...TOOL_META, app: {} }),
      toolCall({ status: "failed" }, TOOL_META),
    ])
    const part = toThreadMessages(failed)[0]?.content[1]
    expect(part).toMatchObject({
      artifact: { aos: { app: { cancelled: "The tool call failed" } } },
    })
    expect(part).not.toHaveProperty("artifact.aos.app.settled")

    const reported = fold([
      agentChunk("a1", "Working"),
      toolCall({ title: "show_board" }, { ...TOOL_META, app: {} }),
      toolCall({ status: "failed", rawOutput: "boom" }, TOOL_META),
    ])
    expect(toThreadMessages(reported)[0]?.content[1]).not.toHaveProperty(
      "artifact.aos.app.cancelled"
    )
  })

  it("marks an open App call cancelled once its turn ends", () => {
    const open = fold([
      stateUpdate({ state: "running" }, TURN_META),
      agentChunk("a1", "Working"),
      toolCall({ title: "show_board" }, { ...TOOL_META, app: {} }),
    ])
    expect(toThreadMessages(open)[0]?.content[1]).not.toHaveProperty(
      "artifact.aos.app.cancelled"
    )
    const stopped = fold(
      [stateUpdate({ state: "idle", stopReason: "cancelled" })],
      open
    )
    expect(toThreadMessages(stopped)[0]?.content[1]).toMatchObject({
      artifact: {
        aos: {
          app: { cancelled: "The turn ended before the tool call finished" },
        },
      },
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
          TURN_META,
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
    expect(answering.execution).toEqual({ status: "running", turnId: "run-1" })
    expect(toThreadMessages(answering)[2]).toMatchObject({
      id: "a2",
      status: { type: "running" },
    })
  })

  it("opens the turn a running run's first tool call belongs to", () => {
    const working = fold(
      [
        stateUpdate({ state: "running" }),
        toolCall({ title: "grep" }, { ...TURN_META, messageId: "a2" }),
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
    expect(started.execution).toEqual({ status: "running", turnId: "run-1" })
    expect(started.messages).toBe(replayed.messages)
    expect(toThreadMessages(started)[1]).toMatchObject(COMPLETE)
  })

  it("reports a blocked run as waiting for input", () => {
    const blocked = fold([stateUpdate({ state: "requires_action" })], answering)
    expect(blocked.execution).toEqual({
      status: "waiting-for-input",
      turnId: "run-1",
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

  it("gives a replayed wait to the turn that asked instead of an empty one", () => {
    // Reopening a Session that is waiting replays its turns and only then
    // reports the wait: nothing streamed, so the request belongs to the turn
    // already in the transcript rather than to a turn of its own.
    const reopened = fold([stateUpdate({ state: "requires_action" })], replayed)

    const messages = toThreadMessages(reopened)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: "assistant",
      status: { type: "requires-action", reason: "interrupt" },
    })
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
      turnId: "run-1",
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
            ...TURN_META,
            code: "provider_error",
            message: "Broke",
          }
        ),
      ],
      answering
    )
    expect(failed.execution).toEqual({
      status: "failed",
      turnId: "run-1",
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

  it("keeps the normalized code alone as the turn's failure shape", () => {
    const failed = fold(
      [
        stateUpdate(
          { state: "idle", stopReason: AOS_STOP_REASONS.error },
          { ...TURN_META, code: "AOS_PROVIDER_RUN_FAILED" }
        ),
      ],
      answering
    )
    // Nothing stringifies the failure on its way to the UI, so a code with no
    // provider description still arrives as the one shape the notice localizes.
    expect(toThreadMessages(failed)[2]?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: { code: "AOS_PROVIDER_RUN_FAILED" },
    })
    expect(failed.execution.error).toEqual({ code: "AOS_PROVIDER_RUN_FAILED" })
  })

  it("carries no failure detail when the run named neither code nor message", () => {
    const failed = fold(
      [stateUpdate({ state: "idle", stopReason: AOS_STOP_REASONS.error })],
      answering
    )
    expect(toThreadMessages(failed)[2]?.status).toEqual({
      type: "incomplete",
      reason: "error",
    })
    expect(failed.execution.error).toBeUndefined()
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

describe("applyUpdate turn timing", () => {
  const STARTED_AT = "2026-09-22T10:00:00.000Z"
  const COMPLETED_AT = "2026-09-22T10:00:04.500Z"
  const at = (moment?: string) =>
    moment === undefined ? TURN_META : { ...TURN_META, at: moment }
  const started = (moment?: string) =>
    stateUpdate({ state: "running" }, at(moment))
  const settled = (moment?: string) =>
    stateUpdate({ state: "idle", stopReason: "end_turn" }, at(moment))

  it("times a turn by the two moments its run reported", () => {
    const timed = fold([
      started(STARTED_AT),
      agentChunk("a1", "Half"),
      agentChunk("a1", " an answer"),
      toolCall({ title: "grep", status: "completed" }, TOOL_META),
      settled(COMPLETED_AT),
    ])

    expect(toThreadMessages(timed)[0]?.metadata?.timing).toEqual({
      streamStartTime: Date.parse(STARTED_AT),
      totalStreamTime: 4_500,
      totalChunks: 2,
      toolCallCount: 1,
    })
  })

  it("keeps the start of a turn whose run has not ended", () => {
    const open = fold([started(STARTED_AT), agentChunk("a1", "Working")])

    expect(toThreadMessages(open)[0]?.metadata?.timing).toEqual({
      streamStartTime: Date.parse(STARTED_AT),
      totalChunks: 1,
      toolCallCount: 0,
    })
  })

  it("keeps the start when the run repeats its running state untimed", () => {
    const timed = fold([
      started(STARTED_AT),
      started(),
      agentChunk("a1", "Done"),
      settled(COMPLETED_AT),
    ])

    expect(toThreadMessages(timed)[0]?.metadata?.timing).toMatchObject({
      streamStartTime: Date.parse(STARTED_AT),
      totalStreamTime: 4_500,
    })
  })

  it("leaves a turn untimed when its run reported no moment", () => {
    const untimed = fold([started(), agentChunk("a1", "Hello"), settled()])

    expect(toThreadMessages(untimed)[0]?.metadata).toBeUndefined()
  })

  it("settles and times the turn a replayed run's chunks opened", () => {
    const replayed = fold([
      userChunk("hermes-row-41", "Ship it"),
      started(STARTED_AT),
      agentChunk("hermes-row-42", "Shipped"),
      settled(COMPLETED_AT),
    ])

    expect(toThreadMessages(replayed)[1]).toMatchObject({
      id: "hermes-row-42",
      status: { type: "complete", reason: "stop" },
      metadata: {
        timing: {
          streamStartTime: Date.parse(STARTED_AT),
          totalStreamTime: 4_500,
        },
      },
    })
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
    const planned = fold([[plan(AOS_PLAN_ID), { ...TURN_META, todos }]])
    expect(planned.todos).toEqual(todos)
  })

  it("ignores a plan that is not the Session's own", () => {
    expect(fold([[plan("other"), { ...TURN_META, todos }]])).toBe(
      initialProjectorState
    )
  })

  it("ignores a plan whose meta has no Todos", () => {
    expect(fold([[plan(AOS_PLAN_ID), TURN_META]])).toBe(initialProjectorState)
  })

  it("records title, config options, and commands, and leaves usage to the composer", () => {
    const projected = fold([
      [{ sessionUpdate: "usage_update", used: 10, size: 100 }, TURN_META],
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

describe("artifact links", () => {
  const answered = fold([userChunk("u1", "Hi"), agentChunk("a1", "Hello")])

  it("appends a published link to its turn as an artifact", () => {
    expect(
      toThreadMessages(fold([artifactLink("a1")], answered))[1]
    ).toMatchObject({
      content: [
        { type: "text", text: "Hello" },
        { type: "data", name: ARTIFACT_DATA_PART_NAME, data: ARTIFACT },
      ],
    })
  })

  it("carries the size the publisher reported", () => {
    const [, answer] = toThreadMessages(
      fold([artifactLink("a1", { size: 2_048 })], answered)
    )
    expect(answer).toMatchObject({
      content: [
        { type: "text" },
        { type: "data", data: { ...ARTIFACT, sizeBytes: 2_048 } },
      ],
    })
  })

  it("appends a replayed link to the earlier turn it names", () => {
    const replayed = fold(
      [userChunk("u2", "And again"), agentChunk("a2", "Still here")],
      answered
    )
    const messages = toThreadMessages(fold([artifactLink("a1")], replayed))

    expect(messages[1]).toMatchObject({
      content: [{ type: "text", text: "Hello" }, { data: ARTIFACT }],
    })
    expect(messages[3]).toMatchObject({
      content: [{ type: "text", text: "Still here" }],
    })
  })

  it("keeps an attachment's link on the user turn that carried it", () => {
    const [user] = toThreadMessages(
      fold([artifactLink("u1", {}, "user_message_chunk")], answered)
    )
    expect(user).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Hi" }, { data: ARTIFACT }],
    })
  })

  it("reads an id the link had to encode", () => {
    const [, answer] = toThreadMessages(
      fold(
        [artifactLink("a1", { uri: "artifact://q3%2Freport%231" })],
        answered
      )
    )
    expect(answer).toMatchObject({
      content: [
        { type: "text" },
        {
          type: "data",
          data: {
            id: "q3/report#1",
            source: { type: "provider", reference: "q3/report#1" },
          },
        },
      ],
    })
  })

  it.each([
    "https://aos.example/api/aos/v1/agents/researcher/sessions/s1/artifacts/art-1",
    "artifact://art-1/../../secrets",
  ])("keeps a link to %s an ordinary file, never an artifact", (uri) => {
    const [, answer] = toThreadMessages(
      fold([artifactLink("a1", { uri })], answered)
    )
    expect(answer?.content).not.toContainEqual(
      expect.objectContaining({ type: "data" })
    )
    expect(answer?.content).toHaveLength(2)
  })

  it("grants one artifact once however often a replay announces it", () => {
    const once = fold([artifactLink("a1")], answered)

    expect(fold([artifactLink("a1")], once)).toEqual(once)
  })
})

describe("applyNotification", () => {
  const answered = fold([userChunk("u1", "Hi"), agentChunk("a1", "Hello")])

  const correction = {
    sessionId: "s1",
    ...TURN_META,
    requestId: "steer-1",
    text: "Also check the logs",
    delivery: "steered",
  }
  const steer = (state: ProjectorState) =>
    applyNotification(state, AOS_METHODS.notify.steerAccepted, correction)

  it("appends an accepted correction as a user turn at the tail", () => {
    const messages = toThreadMessages(steer(answered))

    expect(messages).toHaveLength(3)
    expect(messages[2]).toMatchObject({
      id: steerMessageId("steer-1"),
      role: "user",
      content: [{ type: "text", text: "Also check the logs" }],
    })
  })

  it("lands after the prompt of a run that has written nothing yet", () => {
    const asked = fold(
      [userChunk("u2", "And again"), stateUpdate({ state: "running" })],
      answered
    )
    const messages = toThreadMessages(steer(asked))

    expect(messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      steerMessageId("steer-1"),
    ])
    expect(messages[1]).toMatchObject({
      content: [{ type: "text", text: "Hello" }],
    })
  })

  it("opens the redirected output in a fresh turn below the correction", () => {
    const streaming = fold(
      [
        userChunk("u2", "And again"),
        stateUpdate({ state: "running" }),
        agentChunk("a2", "Partial"),
      ],
      answered
    )
    const redirected = fold(
      [agentChunk("a3", "Checking the logs")],
      steer(streaming)
    )
    const messages = toThreadMessages(redirected)

    expect(messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      steerMessageId("steer-1"),
      "a3",
    ])
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial" }],
    })
    expect(messages[5]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Checking the logs" }],
    })
  })

  it("moves what the interrupted turn is still addressed below the correction", () => {
    const streaming = fold(
      [
        userChunk("u2", "And again"),
        stateUpdate({ state: "running" }),
        agentChunk("a2", "Partial"),
      ],
      answered
    )
    // The provider keeps naming the turn the correction interrupted.
    const continued = fold(
      [agentChunk("a2", "Checking the logs")],
      steer(streaming)
    )
    const messages = toThreadMessages(continued)

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    expect(messages[3]).toMatchObject({
      id: "a2",
      content: [{ type: "text", text: "Partial" }],
    })
    expect(messages[4]).toMatchObject({ id: steerMessageId("steer-1") })
    expect(messages[5]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Checking the logs" }],
    })
  })

  it("settles the sealed turn at the correction and the fresh one at idle", () => {
    const streaming = fold(
      [
        userChunk("u2", "And again"),
        stateUpdate({ state: "running" }),
        agentChunk("a2", "Partial"),
      ],
      answered
    )
    const corrected = toThreadMessages(steer(streaming))
    expect(corrected[3]).toMatchObject({
      id: "a2",
      status: { type: "complete" },
    })

    const settled = toThreadMessages(
      fold(
        [agentChunk("a3", "Checking the logs"), stateUpdate({ state: "idle" })],
        steer(streaming)
      )
    )
    expect(settled[3]).toMatchObject({ id: "a2", status: { type: "complete" } })
    expect(settled[5]).toMatchObject({ id: "a3", status: { type: "complete" } })
  })

  it("grants one correction once however often it is announced", () => {
    const once = steer(answered)

    expect(steer(once)).toBe(once)
  })

  it("ignores a malformed payload and an unknown method", () => {
    expect(
      applyNotification(answered, AOS_METHODS.notify.steerAccepted, {
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

describe("from-start replay", () => {
  const page: readonly Entry[] = [
    userChunk("u1", "Ship it"),
    stateUpdate(
      { state: "running" },
      { ...TURN_META, at: "2026-09-22T10:00:00.000Z" }
    ),
    agentChunk("a1", "Shipped"),
    toolCall({ title: "grep", status: "completed" }, TOOL_META),
    stateUpdate(
      { state: "idle", stopReason: "end_turn" },
      { ...TURN_META, at: "2026-09-22T10:00:01.000Z" }
    ),
  ]

  it("projects one copy of every part however often the page replays", () => {
    const once = fold(page)
    const twice = fold(page, clearTranscript(once))

    expect(toThreadMessages(twice)).toEqual(toThreadMessages(once))
  })

  it("keeps a prompt the provider has not echoed yet", () => {
    const localId = `${LOCAL_PROMPT_PREFIX}1`
    const sending = fold([userChunk(localId, "Ship it again")], fold(page))
    const cleared = clearTranscript(sending)

    expect(toThreadMessages(cleared).map((message) => message.id)).toEqual([
      localId,
    ])
    expect(clearTranscript(cleared)).toBe(cleared)
    // The replay carries the provider's own copy of that prompt, and the reply
    // to the prompt re-keys the local turn onto it.
    const replayed = fold([userChunk("u2", "Ship it again")], cleared)
    expect(
      toThreadMessages(renameMessage(replayed, localId, "u2")).map(
        (message) => message.id
      )
    ).toEqual(["u2"])
  })
})

describe("prependMessages", () => {
  const ids = (state: ProjectorState) =>
    toThreadMessages(state).map((message) => message.id)

  it("places an older page's unseen messages first and skips ids already present", () => {
    const current = fold([
      userChunk("u2", "Newer question"),
      agentChunk("a2", "Newer answer"),
    ])
    // A turn landed between the two reads, so the older page overlaps the
    // newest one by a turn the thread already shows.
    const older = fold([
      userChunk("u1", "First question"),
      agentChunk("a1", "First answer"),
      userChunk("u2", "Stale copy"),
    ])

    const prepended = prependMessages(current, older.messages)

    expect(ids(prepended)).toEqual(["u1", "a1", "u2", "a2"])
    expect(prepended.messages[2]).toBe(current.messages[0])
  })

  it("keeps the state it has when the page holds nothing new", () => {
    const current = fold([userChunk("u1", "Ship it")])

    expect(prependMessages(current, current.messages)).toBe(current)
    expect(prependMessages(current, [])).toBe(current)
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

  it("reports a refusal in the same failure shape a failed run uses", () => {
    const refused = failLatestTurn(sent, {
      message: "This Session is still busy.",
    })
    expect(toThreadMessages(refused)[1]?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: { message: "This Session is still busy." },
    })
  })
})

describe("saved ids", () => {
  /** A turn streamed under the proxy's live ids, still running. */
  const streamed = fold([
    userChunk("u1", "Hi"),
    stateUpdate({ state: "running" }),
    agentChunk("run-1:assistant", "Checking"),
    toolCall({ title: "grep" }, { ...TURN_META, messageId: "run-1:assistant" }),
    agentChunk("run-1:assistant:2", "Done"),
  ])
  const ended = (savedIds: Record<string, string>, from = streamed) =>
    fold(
      [
        stateUpdate(
          { state: "idle", stopReason: "end_turn" },
          { ...TURN_META, savedIds }
        ),
      ],
      from
    )
  const ids = (state: ProjectorState) =>
    toThreadMessages(state).map((message) => message.id)

  it("re-keys each streamed turn onto the id the provider saved it under", () => {
    const saved = ended({
      u1: "hermes-row-1",
      "run-1:assistant": "hermes-row-2",
      "run-1:assistant:2": "hermes-row-3",
    })
    expect(ids(saved)).toEqual(["hermes-row-1", "hermes-row-2", "hermes-row-3"])
    expect(toThreadMessages(saved)[2]).toMatchObject({
      content: [{ type: "text", text: "Done" }],
      status: { type: "complete", reason: "stop" },
    })
  })

  it("folds the replies the provider saved as one message, in their order", () => {
    const saved = ended({
      u1: "hermes-row-1",
      "run-1:assistant": "hermes-row-2",
      "run-1:assistant:2": "hermes-row-2",
    })
    expect(ids(saved)).toEqual(["hermes-row-1", "hermes-row-2"])
    expect(toThreadMessages(saved)[1]).toMatchObject({
      content: [
        { type: "text", text: "Checking" },
        { type: "tool-call", toolCallId: "t1" },
        { type: "text", text: "Done" },
      ],
      status: { type: "complete", reason: "stop" },
    })
  })

  it("keeps one message when the saved id is already projected", () => {
    const replayed = fold([agentChunk("hermes-row-3", "Done")], streamed)
    const saved = ended({ "run-1:assistant:2": "hermes-row-3" }, replayed)
    expect(ids(saved)).toEqual(["u1", "run-1:assistant", "hermes-row-3"])
  })

  it("leaves unlisted turns as they are and ignores an id it does not hold", () => {
    const saved = ended({ u1: "hermes-row-1", missing: "hermes-row-9" })
    expect(ids(saved)).toEqual([
      "hermes-row-1",
      "run-1:assistant",
      "run-1:assistant:2",
    ])
    const plain = ended({})
    expect(plain.messages[0]).toBe(streamed.messages[0])
  })
})

const toolPartOf = (state: ProjectorState, toolCallId = "t1") =>
  toThreadMessages(state)
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    )
    .find(
      (part) => part.type === "tool-call" && part.toolCallId === toolCallId
    ) as ToolCallMessagePart | undefined

const aosOf = (state: ProjectorState, toolCallId?: string) =>
  readAosToolArtifact(toolPartOf(state, toolCallId)?.artifact)

const base64 = (bytes: string | readonly number[]) =>
  Buffer.from(typeof bytes === "string" ? bytes : [...bytes]).toString("base64")

const terminalUpdate = (patch: Record<string, unknown>): Entry => [
  { sessionUpdate: "terminal_update", terminalId: "term-1", ...patch },
  TURN_META,
]

const terminalChunk = (bytes: string | readonly number[]): Entry => [
  {
    sessionUpdate: "terminal_output_chunk",
    terminalId: "term-1",
    data: base64(bytes),
  },
  TURN_META,
]

const toolContent = (content: unknown, toolCallId = "t1"): Entry => [
  { sessionUpdate: "tool_call_content_chunk", toolCallId, content },
  { ...TOOL_META },
]

const terminalContent = toolContent({ type: "terminal", terminalId: "term-1" })

describe("applyUpdate tool facts", () => {
  it("names the call by its programmatic name and reads its kind and locations", () => {
    const state = fold([
      toolCall(
        {
          title: "Read notes.md",
          name: "read_file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/w/notes.md", line: 3 }, { path: "/w/b.md" }],
        },
        TOOL_META
      ),
    ])
    expect(toolPartOf(state)?.toolName).toBe("read_file")
    expect(aosOf(state)).toEqual({
      kind: "read",
      locations: [{ path: "/w/notes.md", line: 3 }, { path: "/w/b.md" }],
    })
  })

  it("falls back to the title and drops a kind the tool UI does not know", () => {
    const state = fold([
      toolCall({ title: "Mystery", kind: "teleport" }, TOOL_META),
    ])
    expect(toolPartOf(state)?.toolName).toBe("Mystery")
    expect(toolPartOf(state)?.artifact).toBeUndefined()
  })

  it("carries diff content as the call's diffs", () => {
    const state = fold([
      toolCall(
        {
          title: "Edit",
          status: "completed",
          content: [
            {
              type: "diff",
              changes: [
                { operation: "modify", path: "a.ts" },
                { operation: "move", path: "c.ts", oldPath: "b.ts" },
              ],
              patch: { format: "git_patch", text: "+one\n-two" },
            },
          ],
        },
        TOOL_META
      ),
    ])
    expect(aosOf(state)?.diffs).toEqual([
      {
        changes: [
          { kind: "modify", path: "a.ts" },
          { kind: "move", path: "c.ts", oldPath: "b.ts" },
        ],
        patch: "+one\n-two",
      },
    ])
  })

  it("times the call from its reported start and end", () => {
    const state = fold([
      toolCall(
        { title: "grep" },
        { ...TOOL_META, startedAt: "2026-01-01T00:00:00.000Z" }
      ),
      toolCall(
        { status: "completed" },
        { ...TOOL_META, completedAt: "2026-01-01T00:00:02.000Z" }
      ),
    ])
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z")
    expect(toolPartOf(state)?.timing).toEqual({
      startedAt,
      completedAt: startedAt + 2000,
    })
  })

  it("times the call from its end and duration when it reported no start", () => {
    const completedAt = Date.parse("2026-01-01T00:00:05.000Z")
    const state = fold([
      toolCall(
        { title: "grep", status: "completed" },
        {
          ...TOOL_META,
          completedAt: "2026-01-01T00:00:05.000Z",
          durationMs: 1500,
        }
      ),
    ])
    expect(toolPartOf(state)?.timing).toEqual({
      startedAt: completedAt - 1500,
      completedAt,
    })
  })

  it("times the call from its duration alone when it reported neither end", () => {
    const state = fold([
      toolCall(
        { title: "terminal", status: "completed" },
        { ...TOOL_META, durationMs: 201 }
      ),
    ])
    const timing = toolPartOf(state)?.timing
    expect(timing?.completedAt).toBeDefined()
    expect((timing?.completedAt ?? 0) - (timing?.startedAt ?? 0)).toBe(201)
  })

  it("appends partial output held back until its call appears", () => {
    const early = fold([
      agentChunk("a1", "Working"),
      toolContent({
        type: "content",
        content: { type: "text", text: "early " },
      }),
    ])
    expect(toolPartOf(early)).toBeUndefined()
    const state = fold(
      [
        toolCall({ title: "run", status: "in_progress" }, TOOL_META),
        toolContent({
          type: "content",
          content: { type: "text", text: "late" },
        }),
      ],
      early
    )
    expect(toolPartOf(state)?.result).toBe("early late")
    expect(state.early).toBeUndefined()
  })

  it("drops output still waiting for a call when the run ends", () => {
    const state = fold([
      toolContent({ type: "content", content: { type: "text", text: "x" } }),
      stateUpdate({ state: "idle", stopReason: "end_turn" }),
    ])
    expect(state.early).toBeUndefined()
  })
})

describe("applyUpdate terminals", () => {
  const opened = fold([
    toolCall({ title: "bash", status: "in_progress" }, TOOL_META),
    terminalUpdate({ command: "ls", cwd: "/w" }),
    terminalContent,
  ])

  it("streams a terminal's output into the call that shows it", () => {
    const state = fold([terminalChunk("one\n"), terminalChunk("two\n")], opened)
    expect(aosOf(state)?.terminals).toEqual([
      {
        terminalId: "term-1",
        command: "ls",
        cwd: "/w",
        output: "one\ntwo\n",
        running: true,
      },
    ])
  })

  it("decodes a character split across two chunks", () => {
    // "é" is 0xC3 0xA9 in UTF-8; the chunk boundary falls between them.
    const state = fold(
      [terminalChunk([0x61, 0xc3]), terminalChunk([0xa9, 0x62])],
      opened
    )
    expect(aosOf(state)?.terminals?.[0]?.output).toBe("aéb")
  })

  it("replaces the output with a snapshot and reports the exit", () => {
    const state = fold(
      [
        terminalChunk("stale"),
        terminalUpdate({
          output: { data: base64("fresh") },
          exitStatus: { exitCode: 2, signal: null },
        }),
      ],
      opened
    )
    expect(aosOf(state)?.terminals).toEqual([
      {
        terminalId: "term-1",
        command: "ls",
        cwd: "/w",
        output: "fresh",
        running: false,
        exitCode: 2,
        signal: null,
      },
    ])
  })

  it("keeps only the tail of a long output", () => {
    const state = fold(
      [
        terminalChunk("head"),
        terminalChunk("x".repeat(TERMINAL_TAIL_LIMIT)),
        terminalChunk("end"),
      ],
      opened
    )
    const terminal = aosOf(state)?.terminals?.[0]
    expect(terminal?.output).toHaveLength(TERMINAL_TAIL_LIMIT)
    expect(terminal?.output.endsWith("xend")).toBe(true)
    expect(terminal?.truncated).toBe(true)
  })

  it("shows output that streamed before the call named its terminal", () => {
    const state = fold([
      toolCall({ title: "bash", status: "in_progress" }, TOOL_META),
      terminalUpdate({}),
      terminalChunk("early"),
      terminalContent,
    ])
    expect(aosOf(state)?.terminals?.[0]?.output).toBe("early")
  })

  it("lists a terminal the settled content restates once, and stops it running", () => {
    const state = fold(
      [
        terminalChunk("done"),
        toolCall(
          {
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "done" } },
              { type: "terminal", terminalId: "term-1" },
              { type: "terminal", terminalId: "term-1" },
            ],
          },
          TOOL_META
        ),
      ],
      opened
    )
    expect(aosOf(state)?.terminals).toMatchObject([
      { terminalId: "term-1", output: "done", running: false },
    ])
  })

  it("forgets terminals with the transcript a replay resends", () => {
    expect(clearTranscript(fold([terminalChunk("x")], opened)).terminals).toBe(
      undefined
    )
  })
})

describe("applyUpdate subagents", () => {
  const SPAWN_META = {
    ...TOOL_META,
    subagent: { id: "sub-1", goal: "Research", status: "running" },
  }
  const CHILD = { subagentId: "sub-1", parentToolCallId: "t1" }
  const spawned = fold([
    toolCall({ title: "delegate", status: "in_progress" }, SPAWN_META),
  ])

  const childMessages = (state: ProjectorState) =>
    toolPartOf(state)?.messages?.map(({ id, role, content }) => ({
      id,
      role,
      content,
    }))

  it("nests what the subagent writes under the call that spawned it", () => {
    const state = fold(
      [
        [
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "a1",
            content: { type: "text", text: "Looking" },
          },
          { ...TURN_META, ...CHILD },
        ],
        [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "t2",
            name: "web_search",
            status: "in_progress",
          },
          { ...TOOL_META, ...CHILD },
        ],
      ],
      spawned
    )
    expect(toThreadMessages(state)).toHaveLength(1)
    expect(toThreadMessages(state)[0]?.content).toHaveLength(1)
    expect(childMessages(state)).toMatchObject([
      {
        id: "sub-1",
        role: "assistant",
        content: [
          { type: "text", text: "Looking" },
          { type: "tool-call", toolCallId: "t2", toolName: "web_search" },
        ],
      },
    ])
  })

  it("settles a nested call its update no longer attributes", () => {
    const state = fold(
      [
        [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "t2",
            name: "web_search",
          },
          { ...TOOL_META, ...CHILD },
        ],
        [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "t2",
            status: "completed",
            rawOutput: "found",
          },
          TOOL_META,
        ],
      ],
      spawned
    )
    expect(childMessages(state)?.[0]?.content).toMatchObject([
      { toolCallId: "t2", result: "found", isError: false },
    ])
  })

  it("patches the subagent's status, tokens, and duration by id", () => {
    const state = fold(
      [
        toolCall(
          {},
          {
            ...TOOL_META,
            subagent: {
              id: "sub-1",
              status: "completed",
              tokens: 900,
              durationMs: 4000,
            },
          }
        ),
      ],
      spawned
    )
    expect(aosOf(state)?.subagent).toEqual({
      id: "sub-1",
      goal: "Research",
      status: "completed",
      tokens: 900,
      durationMs: 4000,
    })
  })

  it("holds a child update until the spawning call it names appears", () => {
    const state = fold([
      agentChunk("a1", "Delegating"),
      [
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "a1",
          content: { type: "text", text: "Early" },
        },
        { ...TURN_META, ...CHILD },
      ],
      toolCall({ title: "delegate" }, SPAWN_META),
    ])
    expect(childMessages(state)).toMatchObject([
      { id: "sub-1", content: [{ type: "text", text: "Early" }] },
    ])
    expect(toThreadMessages(state)[0]?.content).toHaveLength(2)
  })

  it("synthesizes a spawning call for a subagent the stream never announced", () => {
    const state = fold([
      agentChunk("a1", "Working"),
      [
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "a1",
          content: { type: "text", text: "Orphan" },
        },
        { ...TURN_META, subagentId: "sub-9" },
      ],
    ])
    const spawn = toolPartOf(state, "aos-subagent-sub-9")
    expect(spawn?.toolName).toBe("subagent")
    expect(readAosToolArtifact(spawn?.artifact)?.subagent).toEqual({
      id: "sub-9",
    })
    expect(spawn?.messages?.[0]?.content).toMatchObject([
      { type: "text", text: "Orphan" },
    ])
  })
})

describe("applyUpdate stop reasons", () => {
  const answering = fold([
    stateUpdate({ state: "running" }),
    agentChunk("a1", "Part"),
  ])

  it.each([
    ["end_turn", { type: "complete", reason: "stop" }],
    ["cancelled", { type: "incomplete", reason: "cancelled" }],
    ["max_tokens", { type: "incomplete", reason: "length" }],
    ["refusal", { type: "incomplete", reason: "content-filter" }],
    ["max_turn_requests", { type: "incomplete", reason: "other" }],
  ])("settles a turn that stopped on %s", (stopReason, status) => {
    const settled = fold(
      [stateUpdate({ state: "idle", stopReason })],
      answering
    )
    expect(settled.execution.status).toBe("idle")
    expect(toThreadMessages(settled)[0]?.status).toEqual(status)
  })

  it("names the provider and model a failed turn ran on", () => {
    const failed = fold(
      [
        stateUpdate(
          { state: "idle", stopReason: AOS_STOP_REASONS.error },
          {
            ...TURN_META,
            code: "provider_error",
            message: "Broke",
            provider: "openai",
            model: "gpt-9",
          }
        ),
      ],
      answering
    )
    expect(failed.execution.error).toEqual({
      code: "provider_error",
      message: "Broke",
      provider: "openai",
      model: "gpt-9",
    })
  })
})

describe("applyUpdate compaction", () => {
  const compaction = (patch: Record<string, unknown>): Entry => [
    { sessionUpdate: "compaction_update", compactionId: "c1", ...patch },
    TURN_META,
  ]
  const compactionParts = (state: ProjectorState) =>
    toThreadMessages(state).flatMap((message) =>
      (Array.isArray(message.content) ? message.content : []).filter(
        (part) => part.type === "data"
      )
    )

  it("places a compaction in order and updates it in place", () => {
    const state = fold([
      stateUpdate({ state: "running" }),
      agentChunk("a1", "Before"),
      compaction({ status: "in_progress" }),
      agentChunk("a1", "After"),
      compaction({
        status: "completed",
        summary: [{ type: "text", text: "Summed up" }],
      }),
    ])
    expect(toThreadMessages(state)[0]?.content).toEqual([
      { type: "text", text: "Before" },
      {
        type: "data",
        name: COMPACTION_DATA_PART_NAME,
        data: { compactionId: "c1", status: "completed", summary: "Summed up" },
      },
      { type: "text", text: "After" },
    ])
  })

  it("leads the run's first turn when it compacts before writing", () => {
    const state = fold([
      stateUpdate({ state: "running" }),
      compaction({ status: "failed", error: "Too big" }),
      agentChunk("a1", "Answer"),
    ])
    expect(toThreadMessages(state)).toMatchObject([
      {
        id: "a1",
        content: [
          {
            type: "data",
            data: { compactionId: "c1", status: "failed", error: "Too big" },
          },
          { type: "text", text: "Answer" },
        ],
      },
    ])
  })

  it("drops the divider of a compaction the runtime cancelled", () => {
    const state = fold([
      stateUpdate({ state: "running" }),
      compaction({ status: "in_progress" }),
      agentChunk("a1", "Answer"),
      compaction({ status: "cancelled" }),
      stateUpdate({ state: "idle", stopReason: "end_turn" }),
    ])
    expect(compactionParts(state)).toEqual([])
    expect(toThreadMessages(state)).toMatchObject([
      { id: "a1", content: [{ type: "text", text: "Answer" }] },
    ])
  })

  it("ignores a status the divider does not draw", () => {
    const state = fold([
      agentChunk("a1", "Hi"),
      compaction({ status: "cancelled" }),
    ])
    expect(compactionParts(state)).toEqual([])
  })
})

describe("applyApprovals", () => {
  const approval = (patch: Partial<AcpApproval> = {}): AcpApproval => ({
    id: "interrupt-1",
    action: "Run the deploy script",
    options: [
      { id: "once", kind: "allow-once" },
      { id: "deny", kind: "reject-once" },
    ],
    ...patch,
  })

  const toolParts = (state: ProjectorState) =>
    toThreadMessages(state).flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.filter((part) => part.type === "tool-call")
    ) as ToolCallMessagePart[]

  const waiting = fold([
    stateUpdate({ state: "running" }),
    agentChunk("a1", "Deploying"),
    toolCall({ title: "bash", status: "in_progress" }, TOOL_META),
    stateUpdate({ state: "requires_action" }),
  ])

  it("puts an approval on the tool call it guards", () => {
    const state = applyApprovals(waiting, [
      approval({
        toolCallId: "t1",
        action: "rm -rf /tmp/build",
        description: "Hermes flagged a recursive delete",
      }),
    ])

    expect(toolParts(state)).toEqual([
      expect.objectContaining({
        toolCallId: "t1",
        toolName: "bash",
        approval: {
          id: "interrupt-1",
          prompt: "Hermes flagged a recursive delete",
          options: [
            { id: "once", kind: "allow-once" },
            { id: "deny", kind: "reject-once" },
          ],
        },
        providerMetadata: permissionProviderMetadata("rm -rf /tmp/build"),
      }),
    ])
  })

  it("asks with the operation alone when nothing explains it", () => {
    const state = applyApprovals(waiting, [approval()])
    const standalone = toolParts(state)[1]

    expect(standalone?.approval?.prompt).toBe("Run the deploy script")
    expect(standalone?.providerMetadata).toEqual(
      permissionProviderMetadata("Run the deploy script")
    )
  })

  it("carries the recorded answer or resolution on the approval", () => {
    const answered = applyApprovals(waiting, [
      approval({ toolCallId: "t1", optionId: "once", approved: true }),
    ])
    expect(toolParts(answered)[0]?.approval).toMatchObject({
      optionId: "once",
      approved: true,
    })

    const expired = applyApprovals(waiting, [
      approval({ toolCallId: "t1", resolution: "expired" }),
    ])
    expect(toolParts(expired)[0]?.approval?.resolution).toBe("expired")
  })

  it("adds a standalone permission to the turn when no call matches", () => {
    const state = applyApprovals(waiting, [approval()])
    const [message] = toThreadMessages(state)

    expect(message?.id).toBe("a1")
    expect(toolParts(state)).toEqual([
      expect.objectContaining({ toolCallId: "t1" }),
      expect.objectContaining({
        toolName: "request_permission",
        args: { action: "Run the deploy script" },
        approval: expect.objectContaining({ id: "interrupt-1" }),
      }),
    ])
    expect(toolParts(state)[0]?.approval).toBeUndefined()
  })

  it("keeps a standalone permission on the turn it was first seen on", () => {
    const state = applyApprovals(waiting, [approval()])
    const later = fold(
      [
        stateUpdate({ state: "idle", stopReason: "end_turn" }),
        userChunk("u2", "Next"),
        stateUpdate({ state: "running" }),
        agentChunk("a2", "Another turn"),
      ],
      state
    )

    const [first, , second] = toThreadMessages(later)
    expect(first?.id).toBe("a1")
    expect(JSON.stringify(first?.content)).toContain("request_permission")
    expect(second?.id).toBe("a2")
    expect(JSON.stringify(second?.content)).not.toContain("request_permission")
  })

  it("moves a standalone permission onto its call once the call arrives", () => {
    const early = applyApprovals(
      fold([stateUpdate({ state: "running" }), agentChunk("a1", "Deploying")]),
      [approval({ toolCallId: "t1" })]
    )
    expect(toolParts(early)).toEqual([
      expect.objectContaining({ toolName: "request_permission" }),
    ])

    const linked = fold(
      [toolCall({ title: "bash", status: "pending" }, TOOL_META)],
      early
    )
    expect(toolParts(linked)).toEqual([
      expect.objectContaining({
        toolCallId: "t1",
        approval: expect.objectContaining({ id: "interrupt-1" }),
      }),
    ])
  })

  it.each(["completed", "failed"])(
    "drops a linked approval once its call has %s",
    (status) => {
      const state = fold(
        [toolCall({ status }, TOOL_META)],
        applyApprovals(waiting, [
          approval({ toolCallId: "t1", optionId: "once", approved: true }),
        ])
      )

      expect(toolParts(state)).toEqual([
        expect.objectContaining({ toolCallId: "t1" }),
      ])
      expect(toolParts(state)[0]?.approval).toBeUndefined()
    }
  )

  it.each([
    ["answered", { optionId: "once", approved: true }],
    ["cancelled", { resolution: "cancelled" as const }],
    ["expired", { resolution: "expired" as const }],
  ])(
    "leaves out a standalone permission %s before a remount replays",
    (_case, settled) => {
      // A remounted thread binds the Session's approvals before any turn is back.
      const remounted = applyApprovals(initialProjectorState, [
        approval(settled),
      ])
      const replayed = fold(
        [
          userChunk("u1", "Deploy"),
          agentChunk("a1", "Deploying"),
          userChunk("u2", "Again"),
          agentChunk("a2", "Deployed"),
        ],
        remounted
      )

      expect(JSON.stringify(toThreadMessages(replayed))).not.toContain(
        "request_permission"
      )
    }
  )

  it("still shows a pending standalone permission on the newest turn after a remount", () => {
    const replayed = fold(
      [
        userChunk("u1", "Deploy"),
        agentChunk("a1", "Deploying"),
        userChunk("u2", "Again"),
        agentChunk("a2", "Deployed"),
      ],
      applyApprovals(initialProjectorState, [approval()])
    )

    const messages = toThreadMessages(replayed)
    expect(JSON.stringify(messages.at(-1)?.content)).toContain(
      "request_permission"
    )
  })

  it("keeps its approvals across a replay that clears the transcript", () => {
    const cleared = clearTranscript(
      applyApprovals(waiting, [approval({ toolCallId: "t1" })])
    )
    const replayed = fold(
      [
        agentChunk("a1", "Deploying"),
        toolCall({ title: "bash", status: "in_progress" }, TOOL_META),
      ],
      cleared
    )

    expect(toolParts(replayed)[0]?.approval?.id).toBe("interrupt-1")
  })

  it("keeps turns without an approval, and unchanged ones, reference-equal", () => {
    const withTurns = fold([userChunk("u0", "Hi")], waiting)
    const list = [approval({ toolCallId: "t1" })]
    const first = applyApprovals(withTurns, list)
    const again = applyApprovals(fold([], first), [...list])

    expect(toThreadMessages(first)[1]).toBe(toThreadMessages(withTurns)[1])
    expect(toThreadMessages(again)[0]).toBe(toThreadMessages(first)[0])
    expect(toThreadMessages(first)[0]).not.toBe(toThreadMessages(withTurns)[0])
    expect(applyApprovals(first, list)).toBe(first)
  })
})
