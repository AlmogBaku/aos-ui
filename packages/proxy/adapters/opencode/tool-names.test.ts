import { describe, expect, it } from "vitest"

import { ToolKind } from "../../core/events"
import { createMcpToolNames } from "../../mcp-apps/tool-names"
import {
  canonicalOpenCodeToolCall,
  canonicalOpenCodeToolName,
  OPENCODE_MCP_TOOL_NAMES,
  openCodeToolKind,
} from "./tool-names"

describe("canonicalOpenCodeToolName", () => {
  it("renames the native subagent tool and passes every other name through", () => {
    expect(canonicalOpenCodeToolName("task")).toBe("delegate_subagent")
    expect(canonicalOpenCodeToolName("read")).toBe("read")
  })

  it("names an aos-ui MCP tool by its bare AOS name and keeps any other MCP tool raw", () => {
    expect(canonicalOpenCodeToolName("aos-ui_render_chart")).toBe(
      "render_chart"
    )
    expect(canonicalOpenCodeToolName("mcp__aos-ui__present_artifact")).toBe(
      "present_artifact"
    )
    expect(canonicalOpenCodeToolName("aos-ui_unknown_tool")).toBe(
      "aos-ui_unknown_tool"
    )
    expect(canonicalOpenCodeToolName("github_render_chart")).toBe(
      "github_render_chart"
    )
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

describe("OpenCode MCP tool names", () => {
  it.each([
    ["my-server_get_weather", "mcp__my-server__get.weather"],
    // The longest configured server name wins the shared prefix.
    ["my-server_admin_purge", "mcp__my-server_admin__purge"],
    ["local_run", "mcp__local__run"],
    ["aos-ui_render_chart", "render_chart"],
    ["task", "delegate_subagent"],
    ["web_fetch", "web_fetch"],
  ])("reads %s as %s", async (raw, canonical) => {
    const names = createMcpToolNames(OPENCODE_MCP_TOOL_NAMES, async () => [
      { name: "my-server", tools: ["get.weather"] },
      { name: "my-server_admin", tools: ["purge"] },
      { name: "local" },
    ])

    expect(
      canonicalOpenCodeToolName(raw, await names.load("build", [raw]))
    ).toBe(canonical)
  })
})
