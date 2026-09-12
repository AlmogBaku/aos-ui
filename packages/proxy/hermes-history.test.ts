import { describe, expect, it } from "vitest"

import { projectHermesHistory } from "./hermes-history"

describe("server-side Hermes history projection", () => {
  it("preserves message IDs, reasoning, tools, images, and safe rich descriptors without native disclosure", () => {
    const messages = projectHermesHistory([
      {
        id: "user-native-1",
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "Show the report" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YQ==" },
          },
        ],
        native_position: 17,
      },
      {
        id: "assistant-native-1",
        role: "assistant",
        timestamp: 2,
        reasoning_content: "Inspecting the measurements",
        tool_calls: [
          {
            id: "chart-1",
            function: {
              name: "tool_call",
              arguments: JSON.stringify({
                name: "render_chart",
                arguments: { type: "bar", data: [{ label: "A", value: 2 }] },
              }),
            },
          },
          {
            id: "artifact-1",
            function: {
              name: "present_artifact",
              arguments: '{"path":"private/report.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "chart-1",
        tool_name: "render_chart",
        content: '{"ok":true}',
      },
      {
        role: "tool",
        tool_call_id: "artifact-1",
        tool_name: "present_artifact",
        content: JSON.stringify({
          ok: true,
          type: "aos.artifact",
          artifact: {
            id: "report-1",
            filename: "report.md",
            path: "/srv/hermes/private/report.md",
            mimeType: "text/markdown",
            sizeBytes: 42,
          },
        }),
      },
      {
        id: "assistant-native-2",
        role: "assistant",
        timestamp: 3,
        content: "Here it is.",
      },
    ])

    expect(messages).toEqual([
      {
        id: "user-native-1",
        role: "user",
        createdAt: "1970-01-01T00:00:01.000Z",
        content: [
          { type: "text", text: "Show the report" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
      },
      {
        id: "assistant-native-1",
        role: "assistant",
        createdAt: "1970-01-01T00:00:02.000Z",
        content: [
          { type: "reasoning", text: "Inspecting the measurements" },
          {
            type: "tool-call",
            toolCallId: "chart-1",
            toolName: "render_chart",
            args: { type: "bar", data: [{ label: "A", value: 2 }] },
            argsText: JSON.stringify({
              type: "bar",
              data: [{ label: "A", value: 2 }],
            }),
            result: { ok: true },
          },
          {
            type: "tool-call",
            toolCallId: "artifact-1",
            toolName: "present_artifact",
            args: { path: "private/report.md" },
            argsText: '{"path":"private/report.md"}',
            result: {
              ok: true,
              type: "aos.artifact",
              artifact: {
                id: "report-1",
                filename: "report.md",
                mimeType: "text/markdown",
                sizeBytes: 42,
              },
            },
          },
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "report-1",
              filename: "report.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
              source: { type: "provider", reference: "artifact:report-1" },
            },
          },
          { type: "text", text: "Here it is." },
        ],
      },
    ])
    expect(JSON.stringify(messages)).not.toContain("/srv/hermes")
    expect(JSON.stringify(messages)).not.toContain("native_position")
  })
})
