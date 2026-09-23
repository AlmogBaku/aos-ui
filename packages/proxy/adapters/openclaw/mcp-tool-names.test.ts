import { describe, expect, it, vi } from "vitest"

import { canonicalToolName } from "../../core/aos-tool-names"
import {
  createOpenClawMcpToolNames,
  openClawMcpNames,
  openClawMcpResolver,
} from "./mcp-tool-names"

function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    description: "",
    rawDescription: "",
    source: "mcp",
    ...extra,
  }
}

const effective = {
  agentId: "research",
  profile: "default",
  groups: [
    {
      id: "core",
      label: "Core",
      source: "core",
      tools: [{ ...entry("exec"), source: "core" }],
    },
    {
      id: "mcp",
      label: "MCP",
      source: "mcp",
      tools: [
        entry("github__search_issues", {
          mcpServer: "github",
          mcpToolName: "search_issues",
        }),
        entry("my-notes__find", { mcpServer: "My Notes", mcpToolName: "find" }),
      ],
    },
  ],
  notices: [
    {
      id: "mcp-not-yet-connected",
      severity: "info",
      message: "not connected",
      servers: ["linear"],
    },
  ],
}

describe("OpenClaw MCP tool names", () => {
  it.each([
    ["github__search_issues", "mcp__github__search_issues"],
    ["my-notes__find", "mcp__My Notes__find"],
    ["linear__create_issue", "mcp__linear__create_issue"],
    ["aos-ui__render_chart", "render_chart"],
    ["aos_ui__present_artifact", "present_artifact"],
    ["exec", "exec"],
    ["unknown__tool", "unknown__tool"],
    ["linear__", "linear__"],
  ])("%s reads as %s", (raw, canonical) => {
    const resolve = openClawMcpResolver(openClawMcpNames(effective))
    expect(canonicalToolName(raw, resolve)).toBe(canonical)
  })

  it("refetches a Session's catalog when a name misses", async () => {
    vi.useFakeTimers()
    let groups: unknown[] = []
    const request = vi.fn(async () => ({ ...effective, groups, notices: [] }))
    const names = createOpenClawMcpToolNames({ request } as never)
    const resolve = () =>
      names.resolver("research", "agent:research:main")("github__search_issues")

    await names.load("research", "agent:research:main")
    expect(resolve()).toBeUndefined()
    groups = effective.groups
    vi.advanceTimersByTime(31_000)
    await names.load("research", "agent:research:main", [
      "github__search_issues",
    ])
    vi.useRealTimers()

    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "research",
      sessionKey: "agent:research:main",
    })
    expect(resolve()).toEqual({ server: "github", tool: "search_issues" })
  })
})
