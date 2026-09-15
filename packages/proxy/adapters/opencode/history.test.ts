import { describe, expect, it } from "vitest"

import { projectOpenCodeHistory } from "./history"

describe("OpenCode history projection", () => {
  it("maps chronological native messages, reasoning, tools, images, and Todos without private native data", () => {
    const result = projectOpenCodeHistory({
      messages: [
        {
          id: "assistant-1",
          type: "assistant",
          agent: "research",
          model: { providerID: "openai", modelID: "gpt" },
          time: { created: 2_000 },
          content: [
            { id: "reason", type: "reasoning", text: "Thinking" },
            {
              id: "tool",
              type: "tool",
              callID: "call-1",
              tool: "read",
              state: {
                status: "completed",
                input: { safe: true, path: "/private" },
                output: "done",
                title: "Read",
                metadata: {},
                time: { start: 2_000, end: 2_100 },
              },
              time: { created: 2_000 },
            },
          ],
        },
        {
          id: "user-1",
          type: "user",
          text: "See image",
          time: { created: 1_000 },
          files: [
            {
              mime: "image/png",
              filename: "plot.png",
              url: "data:image/png;base64,YQ==",
            },
          ],
        },
      ],
      todos: [
        { content: "Check numbers", status: "in_progress", priority: "high" },
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
          { type: "reasoning", text: "Thinking" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read",
            args: { safe: true },
            argsText: '{"safe":true}',
            result: "done",
          },
        ],
      },
      {
        id: "aos-plan:session-1",
        role: "activity",
        activityType: "PLAN",
        content: {
          todos: [{ id: "todo:0", label: "Check numbers", status: "active" }],
        },
      },
    ])
    expect(JSON.stringify(result)).not.toContain("/private")
    expect(JSON.stringify(result)).not.toContain("providerID")
  })
})
