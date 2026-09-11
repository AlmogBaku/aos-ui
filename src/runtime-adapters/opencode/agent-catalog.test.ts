import { describe, expect, it, vi } from "vitest"
import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { createOpenCodeWorkspace } from "./opencode-workspace"

describe("Agent catalog and visibility contract", () => {
  it("filters OpenCode system definitions and keeps native management read-only", async () => {
    const base = { mode: "primary", native: false, permission: [], options: {} }
    const agents = [
      { ...base, name: "legacy", options: { aos_ui_name: "Legacy" } },
      {
        ...base,
        name: "hidden",
        hidden: true,
        options: { aos_ui_managed: true },
      },
      { ...base, name: "provider-owned" },
      { ...base, name: "native", native: true },
      { ...base, name: "agent-builder" },
      { ...base, name: "child", mode: "subagent" },
    ]
    const client = {
      app: { agents: vi.fn(async () => ({ data: agents })) },
      experimental: { session: { list: vi.fn(async () => ({ data: [] })) } },
    } as unknown as OpencodeClient
    const workspace = createOpenCodeWorkspace({
      client,
      events: { subscribe: () => () => undefined },
    })
    expect((await workspace.listAgents()).map((agent) => agent.id)).toEqual([
      "legacy",
      "hidden",
      "provider-owned",
      "agent-builder",
    ])
    expect(
      (await workspace.listAgentCatalog()).map((entry) => [
        entry.summary.id,
        entry.visibility,
        entry.editable,
      ])
    ).toEqual([
      ["legacy", "visible", false],
      ["hidden", "hidden", false],
      ["provider-owned", "visible", false],
      ["agent-builder", "visible", false],
    ])
    const readonly = createOpenCodeWorkspace({
      client,
      events: { subscribe: () => () => undefined },
    })
    expect(
      (await readonly.listAgentCatalog()).every((entry) => !entry.editable)
    ).toBe(true)
    expect(readonly).not.toHaveProperty("updateAgentVisibility")
  })
})
