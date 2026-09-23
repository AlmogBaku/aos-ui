import { describe, expect, it } from "vitest"

import { MCP_APP_TOOL_ARTIFACT } from "@/components/mcp-apps/tool-part"
import { withAosToolArtifact } from "@/components/tool-ui/tool-artifact"

import {
  createToolPartSelector,
  createToolTimelineModel,
  hasRunningTerminal,
  shouldRenderToolDetails,
  toolIconKind,
  toolRunState,
} from "./message-tool-experience"

describe("createToolTimelineModel", () => {
  it("keeps every tool call in order and marks the active final call", () => {
    const model = createToolTimelineModel([
      {
        toolCallId: "one",
        toolName: "read_file",
        args: { path: "README.md" },
        status: { type: "complete" },
      },
      {
        toolCallId: "two",
        toolName: "ask_user_question",
        args: { question: "Continue?" },
        status: { type: "requires-action" },
      },
    ])

    expect(model.steps).toHaveLength(2)
    expect(model.steps.map((step) => step.chip)).toEqual([
      "README.md",
      "Continue?",
    ])
    expect(model.requiresAttention).toBe(true)
  })

  it("does not expose sensitive provider args in timeline chips", () => {
    const model = createToolTimelineModel([
      {
        toolCallId: "one",
        toolName: "search",
        args: { query: "api_key=raw-secret" },
        status: { type: "complete" },
      },
    ])

    expect(model.steps[0]?.chip).toBe("[REDACTED]")
  })

  it("leaves semantic UI out of the command timeline", () => {
    const select = createToolPartSelector()
    const parts = select([
      {
        type: "tool-call",
        toolCallId: "chart",
        toolName: "render_chart",
        args: { title: "Investment trend" },
        artifact: MCP_APP_TOOL_ARTIFACT,
        status: { type: "complete" },
      },
      {
        type: "tool-call",
        toolCallId: "read",
        toolName: "read_file",
        args: { path: "planning.md" },
        status: { type: "complete" },
      },
      {
        type: "tool-call",
        toolCallId: "question-generic",
        toolName: "ask_user_question",
        args: { question: "Which audience?", allowFreeform: true },
        status: { type: "complete" },
      },
      {
        type: "tool-call",
        toolCallId: "question-provider",
        toolName: "question",
        args: { question: "Which audience?", allowFreeform: true },
        status: { type: "complete" },
      },
    ])

    expect(parts.map((part) => part.toolName)).toEqual(["read_file"])
  })

  it("keeps skill and generic tool invocations in the ordinary execution timeline", () => {
    const select = createToolPartSelector()
    const parts = select([
      {
        type: "tool-call",
        toolCallId: "skill-one",
        toolName: "use_skill",
        args: { skill: "kb" },
        status: { type: "complete" },
      },
      {
        type: "tool-call",
        toolCallId: "skill-two",
        toolName: "load_skill",
        args: { skill: "kb-capture" },
        status: { type: "complete" },
      },
      {
        type: "tool-call",
        toolCallId: "tool-one",
        toolName: "run_tool",
        args: { name: "pdf" },
        status: { type: "complete" },
      },
      {
        type: "tool-call",
        toolCallId: "tool-two",
        toolName: "tool_activity",
        args: { name: "writer" },
        status: { type: "complete" },
      },
    ])

    expect(parts.map((part) => part.toolName)).toEqual([
      "use_skill",
      "load_skill",
      "run_tool",
      "tool_activity",
    ])
  })

  it("keeps loaded skill bodies out of inspectable tool details", () => {
    expect(shouldRenderToolDetails("use_skill")).toBe(false)
    expect(shouldRenderToolDetails("load_skill")).toBe(false)
    expect(shouldRenderToolDetails("skill")).toBe(false)
    expect(shouldRenderToolDetails("tool_describe")).toBe(false)
    expect(shouldRenderToolDetails("read_file")).toBe(true)
  })

  it("derives one semantic state for a collapsed tool run", () => {
    expect(toolRunState([{ status: { type: "complete" } }])).toBe("complete")
    expect(toolRunState([{ status: { type: "requires-action" } }])).toBe(
      "attention"
    )
    expect(toolRunState([{ status: { type: "incomplete" } }])).toBe("failed")
    expect(toolRunState([{ status: { type: "running" } }])).toBe("running")
  })

  it("uses semantic icons for compact tool rows", () => {
    expect(toolIconKind("use_skill")).toBe("skill")
    expect(toolIconKind("read_file")).toBe("read")
    expect(toolIconKind("apply_patch")).toBe("edit")
    expect(toolIconKind("bash")).toBe("command")
    expect(toolIconKind("web_search")).toBe("search")
    expect(toolIconKind("tool_describe")).toBe("inspect")
    expect(toolIconKind("unknown_provider_tool")).toBe("generic")
  })

  it("uses settled action verbs instead of provider tool identifiers", () => {
    const model = createToolTimelineModel(
      [
        ["skill", "use_skill", { skill: "kb" }],
        ["read", "read_file", { path: "thread.tsx" }],
        ["edit", "apply_patch", { path: "composer.tsx" }],
        ["command", "terminal", { command: "bun test" }],
        ["search", "web_search", { query: "assistant-ui" }],
        ["inspect", "tool_describe", { name: "browser" }],
        ["generic", "provider_tool", { name: "provider" }],
      ].map(([toolCallId, toolName, args]) => ({
        toolCallId: toolCallId as string,
        toolName: toolName as string,
        args: args as Record<string, string>,
        status: { type: "complete" as const },
      }))
    )

    expect(model.steps.map((step) => step.verb)).toEqual([
      "Loaded",
      "Read",
      "Edited",
      "Ran",
      "Searched",
      "Inspected",
      "Used",
    ])
  })

  it("names a row by the provider's ACP kind and its first file location", () => {
    const model = createToolTimelineModel([
      {
        toolCallId: "one",
        toolName: "provider_tool",
        args: {},
        artifact: withAosToolArtifact(undefined, {
          kind: "delete",
          locations: [{ path: "notes/draft.md" }],
        }),
        status: { type: "complete" },
      },
    ])

    expect(model.steps[0]).toMatchObject({
      verb: "Deleted",
      chip: "notes/draft.md",
    })
  })

  it("reads a run as failed when a call's result is an error", () => {
    expect(
      toolRunState([{ status: { type: "complete" }, isError: true }])
    ).toBe("failed")
  })

  it("reads a run as failed when a completed command exited non-zero", () => {
    expect(
      toolRunState([
        {
          status: { type: "complete" },
          result: { output: "[Command interrupted]", exit_code: 130 },
        },
      ])
    ).toBe("failed")
  })

  it("opens a run only while one of its terminals is still running", () => {
    const terminalPart = (
      running: boolean,
      status: "running" | "complete"
    ) => ({
      artifact: withAosToolArtifact(undefined, {
        terminals: [{ terminalId: "t", output: "", running }],
      }),
      status: { type: status },
    })

    expect(hasRunningTerminal([terminalPart(true, "running")])).toBe(true)
    expect(hasRunningTerminal([terminalPart(false, "running")])).toBe(false)
    expect(hasRunningTerminal([terminalPart(true, "complete")])).toBe(false)
  })
})
