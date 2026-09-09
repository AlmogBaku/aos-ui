import { describe, expect, it } from "vitest"

import {
  canonicalHermesToolName,
  projectHermesHistory,
} from "./hermes-native-codec"

describe("Hermes native history projection", () => {
  it("keeps durable native row identities and canonicalizes native tool names", () => {
    const messages = projectHermesHistory([
      { _row_id: 41, role: "user", content: "Plan this" },
      {
        id: "native-assistant",
        role: "assistant",
        tool_calls: [
          {
            id: "delegate-1",
            function: { name: "delegate_task", arguments: '{"goal":"Audit"}' },
          },
          {
            id: "todo-1",
            function: { name: "todo_list", arguments: "{}" },
          },
        ],
      },
    ])

    expect(messages[0]?.id).toBe("hermes-row-41")
    expect(messages[1]?.id).toBe("native-assistant")
    expect(messages[1]).toMatchObject({
      content: [
        expect.objectContaining({
          toolName: "delegate_subagent",
          args: { goal: "Audit", description: "Audit" },
        }),
        expect.objectContaining({ toolName: "todo" }),
      ],
    })
  })

  it.each([
    ["delegate_task", "delegate_subagent"],
    ["skill_view", "use_skill"],
    ["todo_list", "todo"],
    ["clarify", "question"],
    ["render_chart", "render_chart"],
  ])("canonicalizes %s", (native, expected) => {
    expect(canonicalHermesToolName(native)).toBe(expected)
  })

  it("unwraps tools selected through Hermes tool search", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-1",
        role: "assistant",
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
        ],
      },
      {
        role: "tool",
        tool_call_id: "chart-1",
        tool_name: "render_chart",
        content: '{"ok":true}',
      },
    ])

    expect(messages[0]).toMatchObject({
      content: [
        {
          type: "tool-call",
          toolCallId: "chart-1",
          toolName: "render_chart",
          args: { type: "bar", data: [{ label: "A", value: 2 }] },
          result: { ok: true },
        },
      ],
    })
  })
})
