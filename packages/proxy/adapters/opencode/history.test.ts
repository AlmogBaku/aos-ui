import { describe, expect, it } from "vitest"

import { StopReason, ToolKind } from "../../../protocol"

import { projectOpenCodeHistory } from "./history"

describe("OpenCode history projection", () => {
  it("accepts pinned-v2 message envelopes including all tool states and data-uri image attachments", () => {
    const result = projectOpenCodeHistory({
      messages: [
        {
          id: "assistant-1",
          type: "assistant",
          agent: "research",
          model: { providerID: "openai", id: "gpt" },
          time: { created: 2_000 },
          content: [
            { id: "text", type: "text", text: "Answer" },
            { id: "reason", type: "reasoning", text: "Thinking" },
            {
              id: "pending-tool",
              type: "tool",
              name: "read",
              time: { created: 2_000 },
              state: { status: "pending", input: '{"safe":true}' },
            },
            {
              id: "running-tool",
              type: "tool",
              name: "search",
              time: { created: 2_000 },
              state: {
                status: "running",
                input: { safe: true, path: "/private" },
                structured: {},
                content: [],
              },
            },
            {
              id: "completed-tool",
              type: "tool",
              name: "write",
              time: { created: 2_000 },
              state: {
                status: "completed",
                input: { safe: true, path: "/private" },
                attachments: [],
                content: [],
                outputPaths: [],
                structured: {},
                result: { ok: true, path: "/private" },
              },
            },
            {
              id: "error-tool",
              type: "tool",
              name: "shell",
              time: { created: 2_000 },
              state: {
                status: "error",
                input: { safe: false },
                content: [],
                structured: {},
                error: { name: "PermissionDenied" },
              },
            },
          ],
        },
        {
          id: "user-1",
          type: "user",
          text: "See image",
          time: { created: 1_000 },
          files: [{ uri: "data:image/png;base64,YQ==", name: "plot.png" }],
        },
        {
          id: "compaction-1",
          type: "compaction",
          reason: "auto",
          summary: "Earlier work",
          recent: "private recent data",
          time: { created: 3_000 },
        },
      ],
      sessionId: "session-1",
    })

    expect(result).toEqual([
      {
        id: "user-1",
        role: "user",
        createdAt: "1970-01-01T00:16:40.000Z",
        content: [
          { type: "text", text: "See image" },
          {
            type: "image",
            image: "data:image/png;base64,YQ==",
            filename: "plot.png",
          },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "1970-01-01T00:33:20.000Z",
        content: [
          { type: "text", text: "Answer" },
          { type: "reasoning", text: "Thinking" },
          {
            type: "tool-call",
            toolCallId: "pending-tool",
            toolName: "read",
            kind: ToolKind.Read,
            startedAt: "1970-01-01T00:33:20.000Z",
            args: { safe: true },
            argsText: '{"safe":true}',
          },
          {
            type: "tool-call",
            toolCallId: "running-tool",
            toolName: "search",
            startedAt: "1970-01-01T00:33:20.000Z",
            args: { safe: true },
            argsText: '{"safe":true}',
          },
          {
            type: "tool-call",
            toolCallId: "completed-tool",
            toolName: "write",
            kind: ToolKind.Edit,
            startedAt: "1970-01-01T00:33:20.000Z",
            args: { safe: true },
            argsText: '{"safe":true}',
            result: { ok: true },
          },
          {
            type: "tool-call",
            toolCallId: "error-tool",
            toolName: "shell",
            kind: ToolKind.Execute,
            startedAt: "1970-01-01T00:33:20.000Z",
            args: { safe: false },
            argsText: '{"safe":false}',
            isError: true,
          },
        ],
      },
      {
        id: "compaction-1",
        role: "system",
        createdAt: "1970-01-01T00:50:00.000Z",
        content: [{ type: "text", text: "Earlier work" }],
      },
    ])
    expect(JSON.stringify(result)).not.toContain("/private")
    expect(JSON.stringify(result)).not.toContain("providerID")
    expect(JSON.stringify(result)).not.toContain("private recent data")
  })

  it("projects the native subagent tool under its canonical name and summary result", () => {
    const result = projectOpenCodeHistory({
      messages: [
        {
          id: "assistant-1",
          type: "assistant",
          agent: "research",
          model: { providerID: "openai", id: "gpt" },
          time: { created: 2_000 },
          content: [
            {
              id: "subagent-tool",
              type: "tool",
              name: "task",
              time: { created: 2_000 },
              state: {
                status: "completed",
                input: { description: "Review the launch plan" },
                content: [],
                structured: {},
                result: "The review is complete.",
              },
            },
          ],
        },
      ],
      sessionId: "session-1",
    })

    expect(result).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "1970-01-01T00:33:20.000Z",
        content: [
          {
            type: "tool-call",
            toolCallId: "subagent-tool",
            toolName: "delegate_subagent",
            startedAt: "1970-01-01T00:33:20.000Z",
            args: { description: "Review the launch plan" },
            argsText: '{"description":"Review the launch plan"}',
            result: { summary: "The review is complete." },
          },
        ],
      },
    ])
  })

  it.each([
    ["stop", StopReason.EndTurn],
    ["length", StopReason.MaxTokens],
    ["content-filter", StopReason.Refusal],
  ])(
    "replays a stored %s finish and a settled call's span as the live turn reported them",
    (finish, stopReason) => {
      const [message] = projectOpenCodeHistory({
        messages: [
          {
            id: "assistant-1",
            type: "assistant",
            agent: "build",
            model: { providerID: "openai", id: "gpt" },
            finish,
            time: { created: 2_000, completed: 4_000 },
            content: [
              {
                id: "bash-tool",
                type: "tool",
                name: "bash",
                time: { created: 2_500, completed: 3_000 },
                state: {
                  status: "completed",
                  input: { command: "ls" },
                  content: [],
                  outputPaths: ["/private/worktree/README.md"],
                  structured: {},
                  result: "README.md",
                },
              },
            ],
          },
        ],
        sessionId: "session-1",
      })

      expect(message).toMatchObject({
        stopReason,
        content: [
          {
            type: "tool-call",
            toolName: "bash",
            kind: ToolKind.Execute,
            startedAt: "1970-01-01T00:41:40.000Z",
            completedAt: "1970-01-01T00:50:00.000Z",
          },
        ],
      })
      expect(JSON.stringify(message)).not.toContain("/private")
      expect(message?.content[0]).not.toHaveProperty("locations")
    }
  )

  it("replays no stop reason for a turn the provider stored without a finish", () => {
    const [message] = projectOpenCodeHistory({
      messages: [
        {
          id: "assistant-1",
          type: "assistant",
          agent: "build",
          model: { providerID: "openai", id: "gpt" },
          time: { created: 2_000 },
          content: [{ id: "text", type: "text", text: "Partial" }],
        },
      ],
      sessionId: "session-1",
    })

    expect(message).not.toHaveProperty("stopReason")
  })
})
