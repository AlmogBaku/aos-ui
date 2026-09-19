import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import type { SessionHistoryResponse } from "../../../protocol"
import {
  AOS_META_KEY,
  AosHistoryStatusMetaSchema,
  AosPlanMetaSchema,
  AosToolCallMetaSchema,
} from "../../../protocol/acp"
import { translateHistory } from "./history"

const PNG = "data:image/png;base64,iVBORw0KGgo="

const history: SessionHistoryResponse = {
  sessionId: "session-1",
  messages: [
    {
      id: "u1",
      role: "user",
      content: [
        { type: "text", text: "Check this chart" },
        { type: "image", image: PNG, filename: "chart.png" },
        { type: "image", image: "/api/aos/v1/artifacts/a1" },
      ],
      createdAt: "2026-09-19T09:00:00.000Z",
    },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "reasoning", text: "weigh the options" },
        { type: "text", text: "Done." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_file",
          args: { path: "a.txt" },
          argsText: '{"path":"a.txt"}',
          result: { ok: true },
        },
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "write_file",
          args: {},
          argsText: "{}",
          isError: true,
        },
        {
          type: "data",
          name: "aos.artifact",
          data: { id: "art-1", filename: "chart.png" },
        },
      ],
      createdAt: "2026-09-19T09:00:01.000Z",
    },
    {
      id: "p1",
      role: "activity",
      activityType: "PLAN",
      content: { todos: [{ id: "t1", label: "Ship it", status: "completed" }] },
    },
    {
      id: "s1",
      role: "system",
      content: [{ type: "text", text: "Context compacted." }],
      createdAt: "2026-09-19T09:00:02.000Z",
    },
  ],
  total: 4,
  limit: 500,
  offset: 0,
  nextOffset: 0,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function aosMeta(update: SessionUpdate): unknown {
  const meta: unknown = update._meta
  return isRecord(meta) ? meta[AOS_META_KEY] : undefined
}

describe("translateHistory", () => {
  it("replays every message in order for the operator", () => {
    expect(
      translateHistory(history, "operator").map(
        ({ sessionUpdate }) => sessionUpdate
      )
    ).toEqual([
      "user_message",
      "agent_thought",
      "agent_message",
      "tool_call_update",
      "tool_call_update",
      "plan_update",
      "agent_message",
    ])
  })

  it("upserts the user turn with its text and inline image", () => {
    const [update] = translateHistory(history, "operator")

    expect(update).toEqual({
      sessionUpdate: "user_message",
      messageId: "u1",
      content: [
        { type: "text", text: "Check this chart" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    })
  })

  it("replays reasoning and prose on one assistant message", () => {
    const [, thought, prose] = translateHistory(history, "operator")

    expect(thought).toEqual({
      sessionUpdate: "agent_thought",
      messageId: "a1",
      content: [{ type: "text", text: "weigh the options" }],
    })
    expect(prose).toEqual({
      sessionUpdate: "agent_message",
      messageId: "a1",
      content: [{ type: "text", text: "Done." }],
    })
  })

  it("replays a settled tool call with parseable history metadata", () => {
    const update = translateHistory(history, "operator")[3]

    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      title: "read_file",
      status: "completed",
      rawInput: { path: "a.txt" },
      rawOutput: { ok: true },
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 0,
      runId: "history",
      messageId: "a1",
      argsText: '{"path":"a.txt"}',
    })
  })

  it("replays a failed tool call without an output", () => {
    expect(translateHistory(history, "operator")[4]).toMatchObject({
      toolCallId: "c2",
      status: "failed",
    })
    expect(translateHistory(history, "operator")[4]).not.toHaveProperty(
      "rawOutput"
    )
  })

  it("replays the Session Todos as the one plan", () => {
    const update = translateHistory(history, "operator")[5]

    expect(update).toMatchObject({
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "todos",
        entries: [
          { content: "Ship it", priority: "medium", status: "completed" },
        ],
      },
    })
    expect(AosPlanMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 0,
      todos: [{ id: "t1", label: "Ship it", status: "completed" }],
    })
  })

  it("keeps execution history out of the guest lane", () => {
    expect(
      translateHistory(history, "guest").map(
        ({ sessionUpdate }) => sessionUpdate
      )
    ).toEqual(["user_message", "agent_message", "plan_update", "agent_message"])
  })

  it("replays a failed turn that streamed nothing, carrying its failure", () => {
    const updates = translateHistory(
      {
        ...history,
        messages: [
          {
            id: "a3",
            role: "assistant",
            content: [],
            createdAt: "2026-09-19T09:00:04.000Z",
            status: {
              type: "incomplete",
              reason: "error",
              error: "The model provider rejected this turn.",
            },
          },
        ],
      },
      "operator"
    )

    expect(updates).toHaveLength(1)
    const [update] = updates
    expect(update).toMatchObject({
      sessionUpdate: "agent_message",
      messageId: "a3",
      content: [],
    })
    expect(
      AosHistoryStatusMetaSchema.parse(
        (update as { _meta: Record<string, unknown> })._meta[AOS_META_KEY]
      ).status
    ).toEqual({
      type: "incomplete",
      reason: "error",
      error: "The model provider rejected this turn.",
    })
  })

  it("replays a message with no renderable content as nothing", () => {
    expect(
      translateHistory(
        {
          ...history,
          messages: [
            {
              id: "a2",
              role: "assistant",
              content: [
                { type: "data", name: "aos.artifact", data: { id: "art-2" } },
              ],
              createdAt: "2026-09-19T09:00:03.000Z",
            },
          ],
        },
        "operator"
      )
    ).toEqual([])
  })
})
