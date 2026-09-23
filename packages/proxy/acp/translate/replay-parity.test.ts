import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import type { SessionHistoryResponse } from "../../../protocol"
import { AOS_META_KEY } from "../../../protocol/acp"
import { RunEventKind, type RunEvent } from "../../core/events"
import {
  initialTranslateState,
  type AcpOutbound,
  type TranslateContext,
  type TranslateState,
} from "../types"
import { translateHistory } from "./history"
import { translateRunEvent } from "./run-events"

/**
 * One turn, watched live and then replayed from the transcript, must reach the
 * browser as the same ordered stream: the browser projects a Session through one
 * code path, so a reload can only show what the run showed if the proxy says it
 * the same way.
 */

const ASSISTANT = "a1"
const READ_ARGS = '{"path":"a.txt"}'
const WRITE_ARGS = '{"path":"b.txt"}'
const READ_RESULT = '{"ok":true}'
const WRITE_RESULT = '{"written":1}'
/** What the turn published: an id that needs encoding to name in a link. */
const ARTIFACT = {
  id: "b.txt#1",
  filename: "b.txt",
  mimeType: "text/plain",
  sizeBytes: 1,
  source: { type: "provider", reference: "b.txt#1" },
}

/** The turn's span, which live reads from the clock and a replay from the page. */
const STARTED_AT = "2026-09-22T10:00:00.000Z"
const FINISHED_AT = "2026-09-22T10:00:09.000Z"

const liveContext: TranslateContext = {
  runId: "run-1",
  sequence: 4,
  lane: "operator",
  stopping: false,
  now: () => Date.parse(FINISHED_AT),
}

const liveEvents: RunEvent[] = [
  { type: RunEventKind.RUN_STARTED, threadId: "session-1", runId: "run-1" },
  {
    type: RunEventKind.REASONING_MESSAGE_START,
    messageId: `${ASSISTANT}:reasoning`,
    role: "reasoning",
  },
  {
    type: RunEventKind.REASONING_MESSAGE_CONTENT,
    messageId: `${ASSISTANT}:reasoning`,
    delta: "Read the file ",
  },
  {
    type: RunEventKind.REASONING_MESSAGE_CONTENT,
    messageId: `${ASSISTANT}:reasoning`,
    delta: "before writing it.",
  },
  {
    type: RunEventKind.REASONING_MESSAGE_END,
    messageId: `${ASSISTANT}:reasoning`,
  },
  {
    type: RunEventKind.TEXT_MESSAGE_START,
    messageId: ASSISTANT,
    role: "assistant",
  },
  {
    type: RunEventKind.TEXT_MESSAGE_CONTENT,
    messageId: ASSISTANT,
    delta: "Reading it now.",
  },
  {
    type: RunEventKind.TOOL_CALL_START,
    toolCallId: "c1",
    toolCallName: "read_file",
    parentMessageId: ASSISTANT,
  },
  { type: RunEventKind.TOOL_CALL_ARGS, toolCallId: "c1", delta: READ_ARGS },
  { type: RunEventKind.TOOL_CALL_END, toolCallId: "c1" },
  {
    type: RunEventKind.TOOL_CALL_RESULT,
    messageId: "tool-1",
    toolCallId: "c1",
    content: READ_RESULT,
  },
  {
    type: RunEventKind.REASONING_MESSAGE_CONTENT,
    messageId: `${ASSISTANT}:reasoning`,
    delta: "Now write it.",
  },
  {
    type: RunEventKind.TOOL_CALL_START,
    toolCallId: "c2",
    toolCallName: "write_file",
    parentMessageId: ASSISTANT,
  },
  { type: RunEventKind.TOOL_CALL_ARGS, toolCallId: "c2", delta: WRITE_ARGS },
  { type: RunEventKind.TOOL_CALL_END, toolCallId: "c2" },
  {
    type: RunEventKind.TOOL_CALL_RESULT,
    messageId: "tool-2",
    toolCallId: "c2",
    content: WRITE_RESULT,
  },
  {
    type: RunEventKind.TEXT_MESSAGE_CONTENT,
    messageId: ASSISTANT,
    delta: "Wrote it.",
  },
  { type: RunEventKind.CUSTOM, name: "aos.artifact", value: ARTIFACT },
  { type: RunEventKind.RUN_FINISHED, threadId: "session-1", runId: "run-1" },
]

/** The same turn as the provider stored it, one part per thing it produced. */
const storedHistory: SessionHistoryResponse = {
  sessionId: "session-1",
  messages: [
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "Copy a.txt into b.txt" }],
      createdAt: STARTED_AT,
    },
    {
      id: ASSISTANT,
      role: "assistant",
      content: [
        { type: "reasoning", text: "Read the file before writing it." },
        { type: "text", text: "Reading it now." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_file",
          args: { path: "a.txt" },
          argsText: READ_ARGS,
          result: { ok: true },
        },
        { type: "reasoning", text: "Now write it." },
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "write_file",
          args: { path: "b.txt" },
          argsText: WRITE_ARGS,
          result: { written: 1 },
        },
        { type: "text", text: "Wrote it." },
        { type: "data", name: "aos.artifact", data: ARTIFACT },
      ],
      createdAt: STARTED_AT,
      completedAt: FINISHED_AT,
    },
  ],
  total: 2,
  limit: 500,
  offset: 0,
  nextOffset: 0,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type Item = { kind: string; value: Record<string, unknown> }

const CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk"])

const UNSHARED_META = new Set(["sequence", "runId", "argsTextDelta"])

/**
 * One update without the run identity and the moment no two streams of one turn
 * can share. `argsTextDelta` is the streaming half of `argsText`, which a settled
 * call already carries whole, and a tool result's textual copy exists only while
 * the run streams it: the transcript keeps the parsed output the same update
 * carries as `rawOutput`.
 */
function anonymous(update: SessionUpdate): Record<string, unknown> {
  const { _meta, content, ...rest } = update as Record<string, unknown>
  const wrapper = isRecord(_meta) ? _meta[AOS_META_KEY] : undefined
  const aos = isRecord(wrapper) ? wrapper : {}
  const meta = Object.fromEntries(
    Object.entries(aos)
      .filter(([key]) => !UNSHARED_META.has(key))
      .map(([key, value]) => [key, key === "at" ? "<at>" : value])
  )
  return {
    ...rest,
    ...(update.sessionUpdate === "tool_call_update" ? {} : { content }),
    meta,
  }
}

const isText = (value: Record<string, unknown>) =>
  isRecord(value.content) && value.content.type === "text"

const textOf = (value: Record<string, unknown>) =>
  isRecord(value.content) && typeof value.content.text === "string"
    ? value.content.text
    : ""

/**
 * The one update a run arrives at, given the two it sent: live opens a call and
 * settles it later, and streams prose delta by delta, where a replay knows each
 * of those as one finished thing.
 */
function folded(previous: Item | undefined, item: Item) {
  if (previous?.kind !== item.kind) return undefined
  if (item.kind === "tool_call_update")
    return previous.value.toolCallId === item.value.toolCallId
      ? {
          ...previous.value,
          ...item.value,
          meta: {
            ...(previous.value.meta as object),
            ...(item.value.meta as object),
          },
        }
      : undefined
  if (
    !CHUNKS.has(item.kind) ||
    previous.value.messageId !== item.value.messageId ||
    !isText(previous.value) ||
    !isText(item.value)
  )
    return undefined
  return {
    ...previous.value,
    content: {
      ...item.value.content,
      text: textOf(previous.value) + textOf(item.value),
    },
  }
}

/** What a turn said, with only what the two streams cannot say alike folded in. */
function stream(outbound: readonly AcpOutbound[]): Item[] {
  const flow: Item[] = []
  for (const outgoing of outbound) {
    if (outgoing.kind !== "update") {
      flow.push({ kind: outgoing.kind, value: { ...outgoing, runId: "<run>" } })
      continue
    }
    const kind = outgoing.update.sessionUpdate
    // Live never restates the operator's prompt: the composer shows it, and only
    // a replay has to send it.
    if (kind === "user_message") continue
    const item: Item = { kind, value: anonymous(outgoing.update) }
    const merged = folded(flow.at(-1), item)
    if (merged) flow[flow.length - 1] = { kind, value: merged }
    else flow.push(item)
  }
  return flow
}

function live(): AcpOutbound[] {
  let state: TranslateState = initialTranslateState
  const outbound: AcpOutbound[] = []
  for (const event of liveEvents) {
    const step = translateRunEvent(state, event, liveContext)
    state = step.state
    outbound.push(...step.outbound)
  }
  return outbound
}

describe("replay parity", () => {
  it("replays a turn as the stream the live run sent", () => {
    expect(stream(translateHistory(storedHistory, "operator"))).toEqual(
      stream(live())
    )
  })

  it("keeps the execution order the turn was produced in", () => {
    expect(stream(live()).map((item) => item.kind)).toEqual([
      "state_update",
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_call_update",
      "agent_thought_chunk",
      "tool_call_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "state_update",
    ])
  })
})
