import { describe, expect, it } from "vitest"

import {
  canonicalHermesToolArgs,
  canonicalHermesToolName,
  projectHermesHistory,
} from "./hermes-native-codec"

describe("Hermes native history projection", () => {
  it("restores persisted assistant reasoning before its tools and final text", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-reasoning",
        role: "assistant",
        reasoning_content: "Inspecting the implementation",
        content: "",
        tool_calls: [
          {
            id: "read-1",
            function: {
              name: "read_file",
              arguments: '{"path":"thread.tsx"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read-1",
        content: "Loaded thread.tsx",
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: "The fix is ready.",
      },
    ])

    expect(messages[0]).toMatchObject({
      content: [
        { type: "reasoning", text: "Inspecting the implementation" },
        expect.objectContaining({
          type: "tool-call",
          toolName: "read_file",
        }),
        expect.objectContaining({
          type: "text",
          text: "The fix is ready.",
        }),
      ],
    })
  })

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

  it("canonicalizes a Hermes clarification into the shared question payload", () => {
    expect(
      canonicalHermesToolArgs("clarify", {
        question: "Which regions?",
        choices: ["Israel", "United Kingdom"],
        multi_select: true,
      })
    ).toEqual({
      question: "Which regions?",
      options: ["Israel", "United Kingdom"],
      allowFreeform: false,
      multiple: true,
    })

    expect(
      canonicalHermesToolArgs("clarify", { question: "Explain the choice" })
    ).toEqual({
      question: "Explain the choice",
      allowFreeform: true,
      multiple: false,
    })
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

  it("restores one assistant turn when durable history splits its tool loop across rows", () => {
    const messages = projectHermesHistory([
      { id: "user-1", role: "user", content: "Update the knowledge base" },
      {
        id: "assistant-skill-1",
        role: "assistant",
        tool_calls: [
          {
            id: "skill-1",
            function: {
              name: "skill_view",
              arguments: '{"skill":"kb"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "skill-1",
        tool_name: "skill_view",
        content: '{"loaded":true}',
      },
      {
        id: "assistant-skill-2",
        role: "assistant",
        tool_calls: [
          {
            id: "skill-2",
            function: {
              name: "skill_view",
              arguments: '{"skill":"kb-capture"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "skill-2",
        tool_name: "skill_view",
        content: '{"loaded":true}',
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: "Knowledge base updated.",
      },
    ])

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      id: "assistant-skill-1",
      role: "assistant",
      content: [
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "skill-1",
          toolName: "use_skill",
          result: { loaded: true },
        }),
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "skill-2",
          toolName: "use_skill",
          result: { loaded: true },
        }),
        { type: "text", text: "Knowledge base updated." },
      ],
    })
  })
})
