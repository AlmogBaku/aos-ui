import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import type { SessionHistoryResponse } from "../../../protocol"
import {
  AOS_META_KEY,
  AosHistoryStatusMetaSchema,
  AosPlanMetaSchema,
  AosToolCallMetaSchema,
} from "../../../protocol/acp"
import type { AcpOutbound } from "../types"
import { persistedCorrections, translateHistory } from "./history"

const PNG = "data:image/png;base64,iVBORw0KGgo="

/** What `present_artifact` publishes: a size, and no media type it could guess. */
const ARTIFACT = {
  id: "art-1",
  filename: "chart.png",
  sizeBytes: 2048,
  source: { type: "provider" as const, reference: "art-1" },
}

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
          data: ARTIFACT,
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

/** What the replay sends, naming a `session/update` by the update it carries. */
function kinds(outbound: readonly AcpOutbound[]) {
  return outbound.map((item) =>
    item.kind === "update" ? item.update.sessionUpdate : item.kind
  )
}

function updatesOf(outbound: readonly AcpOutbound[]) {
  return outbound.flatMap((item) =>
    item.kind === "update" ? [item.update] : []
  )
}

describe("translateHistory", () => {
  it("replays every message in order for the operator", () => {
    expect(kinds(translateHistory(history, "operator"))).toEqual([
      "user_message",
      "agent_thought",
      "agent_message",
      "tool_call_update",
      "tool_call_update",
      "artifact",
      "plan_update",
      "agent_message",
    ])
  })

  it("replays a published artifact against the message that stored it", () => {
    expect(translateHistory(history, "operator")[5]).toEqual({
      kind: "artifact",
      runId: "history",
      messageId: "a1",
      artifact: ARTIFACT,
    })
  })

  it("upserts the user turn with its text and inline image", () => {
    const [update] = updatesOf(translateHistory(history, "operator"))

    expect(update).toEqual({
      sessionUpdate: "user_message",
      messageId: "u1",
      content: [
        { type: "text", text: "Check this chart" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    })
  })

  it("replays an attached image on the user turn that carried it", () => {
    const attached = {
      id: "att-1",
      filename: "upload_20260920_024035_1.png",
      mimeType: "image/png",
      source: { type: "provider" as const, reference: "att-1" },
    }
    const outbound = translateHistory(
      {
        ...history,
        messages: [
          {
            id: "u9",
            role: "user",
            content: [
              { type: "text", text: "do u see it?" },
              { type: "data", name: "aos.artifact", data: attached },
            ],
            createdAt: "2026-09-19T09:00:03.000Z",
          },
        ],
      },
      "operator"
    )

    expect(kinds(outbound)).toEqual(["user_message", "artifact"])
    expect(outbound[1]).toEqual({
      kind: "artifact",
      runId: "history",
      messageId: "u9",
      artifact: attached,
    })
  })

  it("replays reasoning and prose on one assistant message", () => {
    const [, thought, prose] = updatesOf(translateHistory(history, "operator"))

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
    const update = updatesOf(translateHistory(history, "operator"))[3]

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
    const update = updatesOf(translateHistory(history, "operator"))[4]

    expect(update).toMatchObject({ toolCallId: "c2", status: "failed" })
    expect(update).not.toHaveProperty("rawOutput")
  })

  it("replays the Session Todos as the one plan", () => {
    const update = updatesOf(translateHistory(history, "operator"))[5]

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

  it("keeps execution history out of the guest lane, but not outcomes", () => {
    expect(kinds(translateHistory(history, "guest"))).toEqual([
      "user_message",
      "agent_message",
      "artifact",
      "plan_update",
      "agent_message",
    ])
  })

  it("replays a failed turn that streamed nothing, carrying its failure", () => {
    const updates = updatesOf(
      translateHistory(
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

  it("replays a message with no renderable content and no artifact as nothing", () => {
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

describe("persistedCorrections", () => {
  const user = (id: string, text: string, correction = false) => ({
    id,
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    createdAt: "2026-09-19T09:00:00.000Z",
    ...(correction ? { metadata: { custom: { correction: true } } } : {}),
  })
  const agent = {
    id: "a9",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Answered" }],
    createdAt: "2026-09-19T09:00:01.000Z",
  }
  const of = (messages: SessionHistoryResponse["messages"]) =>
    persistedCorrections({ ...history, messages })

  it("counts nothing when no turn is flagged", () => {
    expect(of([user("u1", "Summarize"), agent])).toBe(0)
  })

  it("counts every correction the running turn's prompt collected", () => {
    expect(of([user("u1", "Summarize"), user("u2", "Shorter", true)])).toBe(1)
    expect(
      of([
        user("u1", "Summarize"),
        user("u2", "Shorter", true),
        user("u3", "And bullet it", true),
      ])
    ).toBe(2)
  })

  it("ignores a correction an earlier turn already settled", () => {
    expect(
      of([
        user("u1", "Summarize"),
        user("u2", "Shorter", true),
        agent,
        user("u3", "Now the appendix"),
      ])
    ).toBe(0)
  })
})
