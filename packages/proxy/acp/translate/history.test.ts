import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import type { SessionHistoryResponse } from "../../../protocol"
import {
  AOS_META_KEY,
  AOS_STOP_REASONS,
  AosPlanMetaSchema,
  AosStateMetaSchema,
  AosToolCallMetaSchema,
} from "../../../protocol/acp"
import { persistedCorrections, withoutLiveRows } from "../../core/replay-page"
import type { AcpOutbound } from "../types"
import { translateHistory } from "./history"

const PNG = "data:image/png;base64,iVBORw0KGgo="

/** What `present_artifact` publishes: a size, and no media type it could guess. */
const ARTIFACT = {
  id: "art-1",
  filename: "chart.png",
  sizeBytes: 2048,
  source: { type: "provider" as const, reference: "art-1" },
}

/** The link a replay sends for `artifact` on the turn `messageId`. */
function artifactLink(
  sessionUpdate: "agent_message_chunk" | "user_message_chunk",
  messageId: string,
  artifact: {
    id: string
    filename: string
    mimeType?: string
    sizeBytes?: number
  }
) {
  return {
    kind: "update",
    update: {
      sessionUpdate,
      messageId,
      content: {
        type: "resource_link",
        uri: `artifact://${artifact.id}`,
        name: artifact.filename,
        ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
        ...(artifact.sizeBytes === undefined
          ? {}
          : { size: artifact.sizeBytes }),
      },
      _meta: { [AOS_META_KEY]: { sequence: 0, turnId: "history" } },
    },
  }
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
  it("replays a published artifact as a link on the message that stored it", () => {
    expect(translateHistory(history)[7]).toEqual(
      artifactLink("agent_message_chunk", "a1", ARTIFACT)
    )
  })

  it("upserts the user turn with its text and inline image", () => {
    const [update] = updatesOf(translateHistory(history))

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
    const outbound = translateHistory({
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
    })

    expect(kinds(outbound)).toEqual(["user_message", "user_message_chunk"])
    expect(outbound[1]).toEqual(
      artifactLink("user_message_chunk", "u9", attached)
    )
  })

  it("starts each agent message from empty content, and replays no past state", () => {
    // A view rebuilt in place already holds these messages; each upsert
    // empties one before its chunks, so it shows once. No stored turn's
    // state still stands, and the live turn's follows the replay.
    expect(kinds(translateHistory(history))).toEqual([
      "user_message",
      "agent_thought",
      "agent_thought_chunk",
      "agent_message",
      "agent_message_chunk",
      "tool_call_update",
      "tool_call_update",
      "agent_message_chunk",
      "plan_update",
      "agent_message",
      "agent_message_chunk",
    ])
    expect(updatesOf(translateHistory(history))[3]).toMatchObject({
      messageId: "a1",
      content: [],
    })
  })

  it("replays a settled tool call with its output and parseable history metadata", () => {
    const update = updatesOf(translateHistory(history))[5]

    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      title: "read_file",
      name: "read_file",
      status: "completed",
      rawInput: { path: "a.txt" },
      rawOutput: { ok: true },
      // The content the live call settles with.
      content: [
        { type: "content", content: { type: "text", text: '{"ok":true}' } },
      ],
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 0,
      turnId: "history",
      messageId: "a1",
      argsText: '{"path":"a.txt"}',
    })
  })

  it("replays the flag of a tool call that opens an MCP App view", () => {
    const withApp: SessionHistoryResponse = {
      ...history,
      messages: [
        {
          id: "a-app",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c-app",
              toolName: "mcp__weather__show-forecast",
              args: { city: "Haifa" },
              argsText: '{"city":"Haifa"}',
              result: { result: "Sunny" },
              app: true,
            },
          ],
          createdAt: "2026-09-19T09:00:00.000Z",
        },
      ],
    }
    const update = updatesOf(translateHistory(withApp)).find(
      (item) => item.sessionUpdate === "tool_call_update"
    )

    expect(AosToolCallMetaSchema.parse(aosMeta(update!))).toMatchObject({
      app: {},
    })
  })

  it("replays a failed tool call without an output", () => {
    const update = updatesOf(translateHistory(history))[6]

    expect(update).toMatchObject({ toolCallId: "c2", status: "failed" })
    expect(update).not.toHaveProperty("rawOutput")
  })

  it("replays the kind, locations, diffs and timing a stored call kept", () => {
    const [update] = updatesOf(
      translateHistory({
        ...history,
        messages: [
          {
            id: "a6",
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "c6",
                toolName: "edit_file",
                args: { path: "/work/a.ts" },
                argsText: '{"path":"/work/a.ts"}',
                result: "ok",
                kind: "edit",
                locations: [{ path: "/work/a.ts", line: 3 }],
                diffs: [
                  {
                    changes: [{ operation: "modify", path: "/work/a.ts" }],
                    patch: "--- a/work/a.ts\n+++ b/work/a.ts\n",
                  },
                ],
                startedAt: "2026-09-19T09:00:05.000Z",
                completedAt: "2026-09-19T09:00:06.500Z",
                durationMs: 1500,
              },
            ],
            createdAt: "2026-09-19T09:00:05.000Z",
          },
        ],
      }).filter(
        (item) =>
          item.kind === "update" &&
          item.update.sessionUpdate === "tool_call_update"
      )
    )

    expect(update).toMatchObject({
      kind: "edit",
      locations: [{ path: "/work/a.ts", line: 3 }],
      content: [
        { type: "content", content: { type: "text", text: "ok" } },
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/work/a.ts" }],
          patch: {
            format: "git_patch",
            text: "--- a/work/a.ts\n+++ b/work/a.ts\n",
          },
        },
      ],
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(update!))).toMatchObject({
      startedAt: "2026-09-19T09:00:05.000Z",
      completedAt: "2026-09-19T09:00:06.500Z",
      durationMs: 1500,
    })
  })

  it("replays the Session Todos as the one plan", () => {
    const update = updatesOf(translateHistory(history))[8]

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

  it("replays a failed turn that streamed nothing, carrying its failure", () => {
    const updates = updatesOf(
      translateHistory({
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
      })
    )

    // A failed turn replays the way a live run reports failure: the turn's
    // idle state update carries the vendor stop reason and the stored error.
    const idle = updates.at(-1)
    expect(idle).toMatchObject({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: AOS_STOP_REASONS.error,
    })
    expect(
      AosStateMetaSchema.parse(
        (idle as { _meta: Record<string, unknown> })._meta[AOS_META_KEY]
      ).message
    ).toBe("The model provider rejected this turn.")
  })

  it("replays a message with no renderable content and no artifact as nothing", () => {
    expect(
      translateHistory({
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
      })
    ).toEqual([])
  })

  it("opens a turn the provider started on its own ahead of its parts, with its notice", () => {
    const notice = { severity: "info", title: "/loop wakeup #1", kind: "loop" }
    const opened = (
      lead: SessionHistoryResponse["messages"][number]["content"]
    ) =>
      translateHistory({
        ...history,
        messages: [
          {
            id: "a2",
            role: "assistant",
            content: [...lead, { type: "text", text: "TICK" }],
            createdAt: "2026-09-19T09:00:03.000Z",
            opensTurn: true,
          },
        ],
      })
    const noticePart = {
      type: "data" as const,
      name: "aos-notice",
      data: notice,
    }

    expect(updatesOf(opened([noticePart]))).toEqual([
      {
        sessionUpdate: "agent_message",
        messageId: "a2",
        content: [],
        _meta: { [AOS_META_KEY]: { opensTurn: true, notice } },
      },
      expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
    ])
    expect(updatesOf(opened([]))[0]).toMatchObject({
      _meta: { [AOS_META_KEY]: { opensTurn: true } },
    })
    expect(JSON.stringify(opened([]))).not.toContain("notice")
    // An ordinary message says nothing of turns.
    expect(JSON.stringify(translateHistory(history))).not.toContain("opensTurn")
  })
})

const PROMPTED_AT = "2026-09-19T09:00:00.000Z"

const user = (id: string, text: string, correction = false) => ({
  id,
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  createdAt: PROMPTED_AT,
  ...(correction ? { correction: true as const } : {}),
})

const agent = {
  id: "a9",
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "Answered" }],
  createdAt: "2026-09-19T09:00:01.000Z",
}

describe("persistedCorrections", () => {
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

describe("withoutLiveRows", () => {
  const page = (messages: SessionHistoryResponse["messages"]) => ({
    ...history,
    messages,
  })
  const plan = {
    id: "plan-1",
    role: "activity" as const,
    activityType: "PLAN" as const,
    content: { todos: [] },
  }
  const called = (id: string, toolCallId: string) => ({
    ...agent,
    id,
    content: [
      {
        type: "tool-call" as const,
        toolCallId,
        toolName: "read_file",
        args: { path: "/tmp/demo.txt" },
        argsText: '{"path":"/tmp/demo.txt"}',
      },
    ],
  })

  it("drops the rows the replay names by message or tool call id, keeping the prompt", () => {
    const stored = page([
      user("u1", "list the files"),
      agent,
      called("a10", "call-read"),
      plan,
      { ...agent, id: "a11" },
    ])

    expect(
      withoutLiveRows(stored, new Set(["u1", "a9", "call-read"])).messages
    ).toEqual([user("u1", "list the files"), plan, { ...agent, id: "a11" }])
  })

  it("keeps an earlier turn's row whose tool call id the live turn reused", () => {
    const earlier = called("a1", "call-read")
    const stored = page([earlier, user("u1", "list the files")])

    expect(withoutLiveRows(stored, new Set(["call-read"])).messages).toEqual(
      stored.messages
    )
  })
})
