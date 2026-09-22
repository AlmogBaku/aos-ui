import { describe, expect, it } from "vitest"

import {
  canonicalOpenCodeToolCall,
  canonicalOpenCodeToolName,
} from "./tool-names"

describe("canonicalOpenCodeToolName", () => {
  it("renames the native subagent tool and passes every other name through", () => {
    expect(canonicalOpenCodeToolName("task")).toBe("delegate_subagent")
    expect(canonicalOpenCodeToolName("read")).toBe("read")
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
