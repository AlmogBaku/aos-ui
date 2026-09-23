import { describe, expect, it } from "vitest"

import { ToolKind } from "../../core/events"

import {
  canonicalOpenCodeToolCall,
  canonicalOpenCodeToolName,
  openCodeToolKind,
} from "./tool-names"

describe("canonicalOpenCodeToolName", () => {
  it("renames the native subagent tool and passes every other name through", () => {
    expect(canonicalOpenCodeToolName("task")).toBe("delegate_subagent")
    expect(canonicalOpenCodeToolName("read")).toBe("read")
  })
})

describe("openCodeToolKind", () => {
  it.each([
    ["read", ToolKind.Read],
    ["write", ToolKind.Edit],
    ["edit", ToolKind.Edit],
    ["patch", ToolKind.Edit],
    ["bash", ToolKind.Execute],
    ["shell", ToolKind.Execute],
    ["grep", ToolKind.Search],
    ["glob", ToolKind.Search],
    ["list", ToolKind.Search],
    ["webfetch", ToolKind.Fetch],
    ["todowrite", ToolKind.Think],
    ["todoread", ToolKind.Think],
  ])("names what %s does", (name, kind) => {
    expect(openCodeToolKind(name)).toBe(kind)
  })

  it("leaves every other tool, the delegation tool included, without a kind", () => {
    expect(openCodeToolKind("delegate_subagent")).toBeUndefined()
    expect(openCodeToolKind("mcp_lookup")).toBeUndefined()
  })
})

describe("canonicalOpenCodeToolCall", () => {
  it("projects a native subagent string outcome to a summary result", () => {
    expect(
      canonicalOpenCodeToolCall(
        "task",
        { description: "Review the launch plan" },
        "  The review is complete.  "
      )
    ).toEqual({
      toolName: "delegate_subagent",
      args: { description: "Review the launch plan" },
      result: { summary: "The review is complete." },
    })
  })

  it("passes a non-string or blank subagent result through unchanged", () => {
    expect(
      canonicalOpenCodeToolCall(
        "task",
        { description: "Inspect" },
        { ok: true }
      )
    ).toEqual({
      toolName: "delegate_subagent",
      args: { description: "Inspect" },
      result: { ok: true },
    })
    expect(
      canonicalOpenCodeToolCall("task", { description: "Inspect" }, "   ")
    ).toEqual({
      toolName: "delegate_subagent",
      args: { description: "Inspect" },
      result: "   ",
    })
    expect(
      canonicalOpenCodeToolCall("task", { description: "Inspect" }, undefined)
    ).toEqual({
      toolName: "delegate_subagent",
      args: { description: "Inspect" },
      result: undefined,
    })
  })

  it("leaves an unrenamed tool call untouched", () => {
    expect(
      canonicalOpenCodeToolCall("read", { path: "README.md" }, "contents")
    ).toEqual({
      toolName: "read",
      args: { path: "README.md" },
      result: "contents",
    })
  })
})
