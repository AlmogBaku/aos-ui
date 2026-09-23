import { describe, expect, it } from "vitest"

import { openCodeArtifactReceipt } from "./content"
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
            args: { safe: true },
            argsText: '{"safe":true}',
          },
          {
            type: "tool-call",
            toolCallId: "running-tool",
            toolName: "search",
            args: { safe: true },
            argsText: '{"safe":true}',
          },
          {
            type: "tool-call",
            toolCallId: "completed-tool",
            toolName: "write",
            args: { safe: true },
            argsText: '{"safe":true}',
            result: { ok: true },
          },
          {
            type: "tool-call",
            toolCallId: "error-tool",
            toolName: "shell",
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
            args: { description: "Review the launch plan" },
            argsText: '{"description":"Review the launch plan"}',
            result: { summary: "The review is complete." },
          },
        ],
      },
    ])
  })

  it("replays an aos-ui receipt as the same opaque artifact the live run published", () => {
    const receipt = JSON.stringify({
      ok: true,
      type: "aos.artifact",
      artifact: {
        path: "/workspaces/aos/out/report.pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
      },
    })
    const assistant = (name: string, text: string) => ({
      id: "assistant-1",
      type: "assistant",
      agent: "research",
      model: { providerID: "openai", id: "gpt" },
      time: { created: 2_000 },
      content: [
        {
          id: "call-1",
          type: "tool",
          name,
          time: { created: 2_000 },
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text }],
            structured: {},
          },
        },
      ],
    })
    const [message] = projectOpenCodeHistory({
      messages: [assistant("aos-ui_present_artifact", receipt)],
      sessionId: "session-1",
    })
    const live = openCodeArtifactReceipt("call-1", receipt)

    expect(message?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "present_artifact",
        result: live?.result,
      }),
      { type: "data", name: "aos.artifact", data: live?.descriptor },
    ])
    expect(JSON.stringify(message)).not.toContain("/workspaces")
    expect(
      projectOpenCodeHistory({
        messages: [
          assistant(
            "aos-ui_present_artifact",
            JSON.stringify({
              ok: true,
              type: "aos.artifact",
              artifact: { path: "out/report.pdf", filename: "report.pdf" },
            })
          ),
        ],
        sessionId: "session-1",
      })[0]?.content.some((part) => part.type === "data")
    ).toBe(false)
  })

  it("canonicalizes an aos-ui render tool in history", () => {
    const [message] = projectOpenCodeHistory({
      messages: [
        {
          id: "assistant-1",
          type: "assistant",
          agent: "research",
          model: { providerID: "openai", id: "gpt" },
          time: { created: 2_000 },
          content: [
            {
              id: "call-1",
              type: "tool",
              name: "aos-ui_render_chart",
              time: { created: 2_000 },
              state: {
                status: "completed",
                input: { title: "Sales" },
                content: [],
                structured: {},
                result: "ok",
              },
            },
          ],
        },
      ],
      sessionId: "session-1",
    })
    expect(message?.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "render_chart",
    })
  })
})
