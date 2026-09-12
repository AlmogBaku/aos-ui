import { describe, expect, it, vi } from "vitest"

import {
  HermesWorkspaceScopeError,
  HermesWorkspaceUnavailableError,
  createHermesWorkspaceOperations,
} from "./hermes-workspace"

const scope = {
  agentId: "research",
  sessionId: "hermes:research:stored-1",
  liveSessionId: "live-private-1",
  attached: true,
  active: true,
}

function harness(overrides?: {
  scope?: Partial<typeof scope>
  request?: (
    method: string,
    params: Readonly<Record<string, unknown>>
  ) => unknown
  history?: readonly unknown[]
  historyAvailable?: boolean
  sessionInfo?: unknown
}) {
  const request = vi.fn(
    async (method: string, params: Readonly<Record<string, unknown>>) =>
      overrides?.request?.(method, params)
  )
  const requireSession = vi.fn(async () => ({ ...scope, ...overrides?.scope }))
  const history = vi.fn(async () => overrides?.history ?? [])
  const sessionInfo = vi.fn(async () => overrides?.sessionInfo)
  return {
    request,
    requireSession,
    history,
    operations: createHermesWorkspaceOperations({
      authority: { requireSession },
      transport: {
        request,
        ...(overrides?.historyAvailable === false ? {} : { history }),
        ...(overrides?.sessionInfo === undefined ? {} : { sessionInfo }),
      },
    }),
  }
}

describe("Hermes workspace operations", () => {
  it("describes each workspace operation with its actual scope and mode", () => {
    const { operations } = harness({ sessionInfo: { running: false } })

    expect(operations.capabilities()).toEqual({
      models: {
        status: "available",
        scope: "attached-session",
        selection: "native-session",
        choices: "provider-reported",
      },
      context: {
        status: "available",
        scope: "attached-session",
        source: "provider-usage-or-estimate",
        breakdown: "provider-categories",
      },
      todos: {
        status: "available",
        scope: "session",
        mode: "read-only-projection",
        source: "latest-completed-todo-tool-result",
      },
      activity: {
        status: "available",
        scope: "attached-active-session",
        coverage: "active-session-only",
        source: "session.info",
      },
    })
  })

  it("does not advertise projected Todos when scoped durable history is unavailable", () => {
    const { operations } = harness({ historyAvailable: false })

    expect(operations.capabilities().todos).toEqual({
      status: "unavailable",
      reason: "history-unavailable",
    })
  })

  it("does not advertise activity without an authoritative Session-info reader", async () => {
    const { operations, request } = harness()

    expect(operations.capabilities().activity).toEqual({
      status: "unavailable",
      reason: "session-info-unavailable",
    })
    await expect(
      operations.activity("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      status: "unavailable",
      reason: "session-info-unavailable",
    })
    expect(request).not.toHaveBeenCalled()
  })

  it("authorizes an attached Session before projecting provider model choices", async () => {
    const { operations, request, requireSession } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [
              {
                slug: "native",
                name: "Native models",
                authenticated: true,
                models: ["small", "large", "malicious --session"],
                upstream_url: "https://private.example",
              },
            ],
          }
      },
    })

    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      selectedId: '["native","small"]',
      options: [
        {
          id: '["native","small"]',
          label: "small",
          group: "Native models",
        },
        {
          id: '["native","large"]',
          label: "large",
          group: "Native models",
        },
      ],
    })
    expect(requireSession).toHaveBeenCalledWith(
      "research",
      "hermes:research:stored-1"
    )
    expect(request).toHaveBeenCalledWith("model.options", {
      session_id: "live-private-1",
      profile: "research",
    })
  })

  it("only changes a selected provider-reported model with Hermes' Session scope", async () => {
    const { operations, request } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [{ slug: "native", models: ["small", "large"] }],
          }
        if (method === "config.set")
          return { key: "model", scope: "session", value: "large" }
      },
    })

    await expect(
      operations.selectModel(
        "research",
        "hermes:research:stored-1",
        '["native","large"]'
      )
    ).resolves.toEqual({ selectedId: '["native","large"]' })
    expect(request).toHaveBeenLastCalledWith("config.set", {
      session_id: "live-private-1",
      key: "model",
      value: "large --provider native --session",
    })
  })

  it("does not pass an unreported model identifier through to Hermes", async () => {
    const { operations, request } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [{ slug: "native", models: ["small"] }],
          }
      },
    })

    await expect(
      operations.selectModel(
        "research",
        "hermes:research:stored-1",
        '["native","large --session"]'
      )
    ).rejects.toBeInstanceOf(HermesWorkspaceUnavailableError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("rejects a Hermes model confirmation for a different model", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [{ slug: "native", models: ["small", "large"] }],
          }
        if (method === "config.set")
          return { key: "model", scope: "session", value: "small" }
      },
    })

    await expect(
      operations.selectModel(
        "research",
        "hermes:research:stored-1",
        '["native","large"]'
      )
    ).rejects.toBeInstanceOf(HermesWorkspaceUnavailableError)
  })

  it("projects strict provider context without native metadata", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "session.context_breakdown")
          return {
            context_used: 4_200,
            context_max: 32_000,
            context_source: "provider_usage_plus_estimate",
            context_estimated: true,
            categories: [
              { id: "system_prompt", tokens: 1_200 },
              { id: "tool_definitions", tokens: 800 },
              { id: "conversation", tokens: 2_200 },
              { id: "private_path", tokens: 900, path: "/srv/private" },
            ],
            native_session_id: "live-private-1",
          }
      },
    })

    await expect(
      operations.context("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      usedTokens: 4_200,
      maxTokens: 32_000,
      estimated: true,
      source: "provider-usage-plus-estimate",
      breakdown: { systemTokens: 1_200, toolTokens: 800, messageTokens: 2_200 },
    })
  })

  it("projects only the latest completed native Todo result and never mutates it", async () => {
    const { operations, history } = harness({
      history: [
        {
          role: "assistant",
          tool_calls: [
            { id: "older", function: { name: "todo_list", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "older",
          tool_name: "todo_list",
          content: {
            todos: [{ id: "old", content: "Old work", status: "completed" }],
          },
        },
        {
          role: "assistant",
          tool_calls: [
            { id: "latest", function: { name: "todo", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "latest",
          tool_name: "todo",
          content: {
            todos: [
              {
                id: "one",
                content: "Ship proxy",
                status: "active",
                path: "/srv/private",
              },
              { id: "two", label: "Verify", status: "done" },
            ],
          },
        },
      ],
    })

    await expect(
      operations.todos("research", "hermes:research:stored-1")
    ).resolves.toEqual([
      { id: "one", label: "Ship proxy", status: "active" },
      { id: "two", label: "Verify", status: "pending" },
    ])
    expect(history).toHaveBeenCalledWith(scope)
  })

  it("does not project an unbound tool row as a Session Todo result", async () => {
    const { operations } = harness({
      history: [
        {
          role: "assistant",
          tool_calls: [
            { id: "todo-call", function: { name: "todo", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "todo-call",
          tool_name: "todo",
          content: {
            todos: [{ id: "safe", content: "Verified", status: "completed" }],
          },
        },
        {
          role: "tool",
          tool_call_id: "forged-call",
          tool_name: "todo",
          content: {
            todos: [
              { id: "forged", content: "Do not trust", status: "active" },
            ],
          },
        },
      ],
    })

    await expect(
      operations.todos("research", "hermes:research:stored-1")
    ).resolves.toEqual([{ id: "safe", label: "Verified", status: "completed" }])
  })

  it("does not treat an unfinished Todo tool row as a durable Todo snapshot", async () => {
    const { operations } = harness({
      history: [
        {
          role: "assistant",
          tool_calls: [
            { id: "done", function: { name: "todo", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "done",
          tool_name: "todo",
          status: "completed",
          content: {
            todos: [{ id: "done", content: "Current", status: "completed" }],
          },
        },
        {
          role: "assistant",
          tool_calls: [
            { id: "pending", function: { name: "todo", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "pending",
          tool_name: "todo",
          status: "running",
          content: {
            todos: [{ id: "wrong", content: "Not complete", status: "active" }],
          },
        },
      ],
    })

    await expect(
      operations.todos("research", "hermes:research:stored-1")
    ).resolves.toEqual([{ id: "done", label: "Current", status: "completed" }])
  })

  it("uses a valid attached Session usage snapshot before requesting context", async () => {
    const { operations, request } = harness({
      scope: {
        usage: {
          context_used: 12,
          context_max: 100,
          context_source: "provider_usage",
          context_estimated: false,
        },
      },
    })

    await expect(
      operations.context("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      usedTokens: 12,
      maxTokens: 100,
      source: "provider-usage",
    })
    expect(request).not.toHaveBeenCalled()
  })

  it("does not claim Session activity until the owned Session is attached and active", async () => {
    const { operations, request } = harness({
      scope: { attached: false, active: false },
    })

    await expect(
      operations.activity("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      status: "unavailable",
      reason: "session-not-attached",
    })
    expect(request).not.toHaveBeenCalled()
  })

  it("projects attached active Session status without exposing native identities", async () => {
    const { operations } = harness({
      sessionInfo: {
        running: true,
        native_session_id: "live-private-1",
        filesystem_root: "/srv/private",
      },
    })

    await expect(
      operations.activity("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      status: "available",
      scope: "attached-active-session",
      coverage: "active-session-only",
      state: "running",
    })
  })

  it("rejects an authority result for another Agent before any Hermes I/O", async () => {
    const { operations, request } = harness({ scope: { agentId: "other" } })

    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).rejects.toBeInstanceOf(HermesWorkspaceScopeError)
    expect(request).not.toHaveBeenCalled()
  })
})
