import { describe, expect, it, vi } from "vitest"

import { HermesAgentNotFoundError, HermesSessionNotFoundError } from "./adapter"
import {
  HermesWorkspaceScopeError,
  HermesWorkspaceUnavailableError,
  createHermesWorkspaceOperations,
} from "./workspace"

const scope = {
  agentId: "research",
  sessionId: "hermes:research:stored-1",
  liveSessionId: "live-private-1",
  attached: true,
  active: true,
}

const reasoningLadder = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]

/** A Hermes catalog whose only model reports reasoning it cannot disable. */
function modelOptions(method: string) {
  if (method !== "model.options") return undefined
  return {
    provider: "native",
    model: "small",
    providers: [
      {
        slug: "native",
        models: ["small"],
        capabilities: { small: { fast: false, reasoning: true } },
      },
    ],
  }
}

function harness(overrides?: {
  scope?: Partial<typeof scope>
  /** The failure the authority raises instead of answering with a scope. */
  scopeFailure?: unknown
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
  const requireSession = vi.fn(async () => {
    if (overrides?.scopeFailure) throw overrides.scopeFailure
    return { ...scope, ...overrides?.scope }
  })
  const history = vi.fn(async () => overrides?.history ?? [])
  // The retained Session info the adapter holds, write-through included.
  let retained = overrides?.sessionInfo
  const sessionInfo = vi.fn(async () => retained)
  const recordSessionInfo = vi.fn(
    (_scope: unknown, patch: Readonly<Record<string, unknown>>) => {
      retained = {
        ...(typeof retained === "object" && retained !== null ? retained : {}),
        ...patch,
      }
    }
  )
  return {
    request,
    requireSession,
    history,
    recordSessionInfo,
    /** Stands in for a Hermes `session.info` push replacing the record. */
    setSessionInfo: (value: unknown) => {
      retained = value
    },
    operations: createHermesWorkspaceOperations({
      authority: { requireSession },
      transport: {
        request,
        ...(overrides?.historyAvailable === false ? {} : { history }),
        ...(overrides?.sessionInfo === undefined
          ? {}
          : { sessionInfo, recordSessionInfo }),
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
        source: "provider-session-state",
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

  it("offers the model a Session already runs even when Hermes omits it", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "native",
            model: "retired",
            providers: [
              {
                slug: "native",
                name: "Native models",
                authenticated: true,
                models: ["small"],
              },
            ],
          }
      },
    })

    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      selectedId: '["native","retired"]',
      options: [
        { id: '["native","retired"]', label: "retired", group: "native" },
        { id: '["native","small"]', label: "small", group: "Native models" },
      ],
    })
  })

  it("changes a Session's model with Hermes' own Session-scoped config key", async () => {
    const { operations, request } = harness({
      request(method) {
        if (method === "config.set")
          return { key: "model", scope: "session", value: "large" }
      },
      sessionInfo: { provider: "native", model: "small" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
      })
    ).resolves.toEqual({ selectedId: '["native","large"]' })
    // The id is the pair this module minted, so the write never pays for the
    // catalog handler only to split it again.
    expect(request.mock.calls).toEqual([
      [
        "config.set",
        {
          session_id: "live-private-1",
          key: "model",
          value: "large --provider native --session",
        },
      ],
    ])
  })

  it("reports the model Hermes resolved a pick to over the requested one", async () => {
    const { operations } = harness({
      request(method) {
        // Hermes answers with its own canonical name for the chosen model.
        if (method === "config.set")
          return { key: "model", scope: "session", value: "large-2026-09" }
      },
      sessionInfo: { provider: "native", model: "small" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
      })
    ).resolves.toEqual({ selectedId: '["native","large-2026-09"]' })
  })

  it("reports the applied pick when Hermes retains no Session info", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "config.set")
          return { key: "model", scope: "session", value: "large" }
      },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
      })
    ).resolves.toEqual({ selectedId: '["native","large"]' })
  })

  it.each([
    '["native","large"]junk',
    "native/large",
    '["native"]',
    '["native","large","extra"]',
    '["native","large --session"]',
    '["native lab","large"]',
  ])(
    "does not pass the malformed model identifier %s to Hermes",
    async (selectedId) => {
      const { operations, request } = harness({
        sessionInfo: { provider: "native", model: "small" },
      })

      await expect(
        operations.updateModel("research", "hermes:research:stored-1", {
          selectedId,
          // Neither half is written when the other is rejected.
          effortId: "high",
        })
      ).rejects.toBeInstanceOf(HermesWorkspaceUnavailableError)
      expect(request).not.toHaveBeenCalled()
    }
  )

  it("answers a guarded model pick rather than reporting a failed switch", async () => {
    const { operations, request } = harness({
      request(method, params) {
        if (method !== "config.set") return undefined
        // Hermes guards some picks and switches nothing until one is answered.
        if (params.confirm_expensive_model !== true)
          return {
            key: "model",
            value: "large",
            confirm_required: true,
            confirm_message: "This model is billed per token. Continue?",
          }
        return { key: "model", scope: "session", value: "large" }
      },
      sessionInfo: { provider: "native", model: "small" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
      })
    ).resolves.toEqual({ selectedId: '["native","large"]' })
    expect(request).toHaveBeenLastCalledWith("config.set", {
      session_id: "live-private-1",
      key: "model",
      value: "large --provider native --session",
      confirm_expensive_model: true,
    })
  })

  it("does not report a switch Hermes withholds after it is confirmed", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "config.set")
          return { key: "model", value: "large", confirm_required: true }
      },
      sessionInfo: { provider: "native", model: "small" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
      })
    ).rejects.toBeInstanceOf(HermesWorkspaceUnavailableError)
  })

  it("accepts a pick Hermes defers to the next turn of a streaming Session", async () => {
    const { operations } = harness({
      request(method) {
        // A pick made mid-turn is stashed, and its answer names the model the
        // Session is on from here.
        if (method === "config.set")
          return {
            key: "model",
            scope: "session",
            value: "large",
            deferred: true,
          }
      },
      sessionInfo: { provider: "native", model: "small" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
      })
    ).resolves.toEqual({ selectedId: '["native","large"]' })
  })

  it("reports a reasoning ladder only for models Hermes says support reasoning", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [
              {
                slug: "native",
                name: "Native models",
                models: ["small", "large", "plain", "fast-only", "vague"],
                capabilities: {
                  small: {
                    fast: true,
                    reasoning: true,
                    can_disable_reasoning: true,
                  },
                  large: { fast: false, reasoning: true },
                  "fast-only": { fast: true, reasoning: false },
                  vague: { fast: true, reasoning: "yes" },
                  unlisted: { fast: false, reasoning: true },
                },
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
          efforts: ["none", ...reasoningLadder],
        },
        {
          id: '["native","large"]',
          label: "large",
          group: "Native models",
          efforts: reasoningLadder,
        },
        { id: '["native","plain"]', label: "plain", group: "Native models" },
        {
          id: '["native","fast-only"]',
          label: "fast-only",
          group: "Native models",
        },
        { id: '["native","vague"]', label: "vague", group: "Native models" },
      ],
    })
  })

  it("offers the Session's own model when Hermes omits its provider row", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "openai-codex",
            model: "gpt-5.6-terra",
            providers: [
              {
                slug: "native",
                name: "Native models",
                models: ["small"],
                capabilities: { small: { fast: true, reasoning: true } },
              },
            ],
          }
      },
    })

    // Without this the picker holds a value no option carries and renders blank.
    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      selectedId: '["openai-codex","gpt-5.6-terra"]',
      options: [
        {
          id: '["openai-codex","gpt-5.6-terra"]',
          label: "gpt-5.6-terra",
          group: "openai-codex",
        },
        {
          id: '["native","small"]',
          label: "small",
          group: "Native models",
          efforts: reasoningLadder,
        },
      ],
    })
  })

  it("reports the model the Session is on over the one its live agent holds", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [
              {
                slug: "native",
                name: "Native models",
                models: ["small", "large"],
                capabilities: {
                  small: { fast: true, reasoning: false },
                  large: { fast: false, reasoning: true },
                },
              },
            ],
          }
      },
      // Hermes stashes a pick made while a turn streams for the next turn start,
      // so its catalog still names the model the Session is leaving.
      sessionInfo: { model: "large", provider: "native" },
    })

    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).resolves.toMatchObject({ selectedId: '["native","large"]' })
  })

  it("keeps the catalog's model when Hermes names none for the Session", async () => {
    const withoutModel = harness({
      request: modelOptions,
      sessionInfo: { running: false },
    })
    const withoutReader = harness({ request: modelOptions })

    await expect(
      withoutModel.operations.models("research", "hermes:research:stored-1")
    ).resolves.toMatchObject({ selectedId: '["native","small"]' })
    await expect(
      withoutReader.operations.models("research", "hermes:research:stored-1")
    ).resolves.toMatchObject({ selectedId: '["native","small"]' })
  })

  it("reports the reasoning effort Hermes holds for the Session", async () => {
    const { operations } = harness({
      request: modelOptions,
      sessionInfo: { reasoning_effort: "high" },
    })

    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).resolves.toMatchObject({ effortId: "high" })
  })

  it("omits a Session reasoning effort Hermes leaves default or does not name", async () => {
    const providerDefault = harness({
      request: modelOptions,
      sessionInfo: { reasoning_effort: "" },
    })
    const unknownLevel = harness({
      request: modelOptions,
      sessionInfo: { reasoning_effort: "bogus" },
    })

    await expect(
      providerDefault.operations.models("research", "hermes:research:stored-1")
    ).resolves.not.toHaveProperty("effortId")
    await expect(
      unknownLevel.operations.models("research", "hermes:research:stored-1")
    ).resolves.not.toHaveProperty("effortId")
  })

  it("changes the Session reasoning effort to a level on Hermes' ladder", async () => {
    const { operations, request } = harness({
      request(method) {
        if (method === "config.set") return { key: "reasoning", value: "high" }
      },
      sessionInfo: { provider: "native", model: "small", reasoning_effort: "" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        effortId: "high",
      })
    ).resolves.toEqual({ selectedId: '["native","small"]', effortId: "high" })
    expect(request.mock.calls).toEqual([
      [
        "config.set",
        { session_id: "live-private-1", key: "reasoning", value: "high" },
      ],
    ])
  })

  it("still names the model after an effort write Hermes accepted", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "config.set") return { key: "reasoning", value: "high" }
        return modelOptions(method)
      },
      // Hermes names no model for this Session, and a write it accepted must
      // not be reported as a failure.
      sessionInfo: { running: false },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        effortId: "high",
      })
    ).resolves.toEqual({ selectedId: '["native","small"]', effortId: "high" })
  })

  it("does not pass an off-ladder reasoning effort through to Hermes", async () => {
    const { operations, request } = harness({
      sessionInfo: { provider: "native", model: "small" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        effortId: "turbo",
      })
    ).rejects.toBeInstanceOf(HermesWorkspaceUnavailableError)
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects a Hermes reasoning confirmation for a different effort", async () => {
    const { operations } = harness({
      request(method) {
        if (method === "config.set") return { key: "reasoning", value: "low" }
      },
      sessionInfo: { provider: "native", model: "small" },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        effortId: "high",
      })
    ).rejects.toBeInstanceOf(HermesWorkspaceUnavailableError)
  })

  it("applies both halves of one model update in the order it received them", async () => {
    const { operations, request } = harness({
      request(method, params) {
        if (method !== "config.set") return undefined
        return params.key === "model"
          ? { key: "model", scope: "session", value: "large" }
          : { key: "reasoning", value: "max" }
      },
      sessionInfo: {
        provider: "native",
        model: "small",
        reasoning_effort: "low",
      },
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
        effortId: "max",
      })
    ).resolves.toEqual({ selectedId: '["native","large"]', effortId: "max" })
    expect(request.mock.calls).toEqual([
      [
        "config.set",
        {
          session_id: "live-private-1",
          key: "model",
          value: "large --provider native --session",
        },
      ],
      [
        "config.set",
        { session_id: "live-private-1", key: "reasoning", value: "max" },
      ],
    ])
  })

  it("names what it applied when Hermes pushes older info between the writes", async () => {
    const olderInfo = {
      provider: "native",
      model: "small",
      reasoning_effort: "low",
    }
    const { operations, request, setSessionInfo } = harness({
      sessionInfo: olderInfo,
    })
    request.mockImplementation(async (method, params) => {
      if (method !== "config.set") return modelOptions(method)
      if (params.key === "model")
        return { key: "model", scope: "session", value: "large" }
      // A push for an unrelated event lands between the two writes, still
      // carrying the model the Session is leaving.
      setSessionInfo({ ...olderInfo, running: true })
      return { key: "reasoning", value: "high" }
    })

    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
        effortId: "high",
      })
    ).resolves.toEqual({ selectedId: '["native","large"]', effortId: "high" })
  })

  it("reports the Session state Hermes settled on after a write", async () => {
    const { operations, recordSessionInfo } = harness({
      request(method, params) {
        if (method !== "config.set") return modelOptions(method)
        return params.key === "model"
          ? { key: "model", scope: "session", value: "large-2026-09" }
          : { key: "reasoning", value: "xhigh" }
      },
      sessionInfo: {
        provider: "native",
        model: "small",
        reasoning_effort: "low",
      },
    })

    // A read taken before Hermes echoes `session.info` must already report the
    // state this write settled on, or the browser snaps back to the old model.
    await expect(
      operations.updateModel("research", "hermes:research:stored-1", {
        selectedId: '["native","large"]',
        effortId: "xhigh",
      })
    ).resolves.toEqual({
      selectedId: '["native","large-2026-09"]',
      effortId: "xhigh",
    })
    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).resolves.toMatchObject({
      selectedId: '["native","large-2026-09"]',
      effortId: "xhigh",
    })
    expect(recordSessionInfo).toHaveBeenCalledTimes(2)
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

  it("truncates a native Todo result no person could read", async () => {
    const { operations } = harness({
      history: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call-1", function: { name: "todo", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          tool_name: "todo",
          content: {
            todos: Array.from({ length: 5_000 }, (_unused, index) => ({
              id: `todo-${index}`,
              content: `Step ${index}`,
              status: "pending",
            })),
          },
        },
      ],
    })

    const todos = await operations.todos("research", "hermes:research:stored-1")

    expect(todos).toHaveLength(256)
    expect(todos?.at(0)).toEqual({
      id: "todo-0",
      label: "Step 0",
      status: "pending",
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
                status: "in_progress",
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

  it("projects the Todo list a batched native tool_call envelope wrote", async () => {
    const { operations } = harness({
      history: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_batched",
              type: "function",
              function: {
                name: "tool_call",
                arguments: JSON.stringify({
                  calls: [
                    {
                      name: "todo_list",
                      arguments: {
                        todos: [
                          {
                            id: "preflight",
                            content: "Run preflight",
                            status: "in_progress",
                          },
                        ],
                      },
                    },
                  ],
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_batched",
          tool_name: "todo_list",
          content:
            '{"todos": [{"id": "preflight", "content": "Run preflight", "status": "in_progress"}]}',
        },
      ],
    })

    await expect(
      operations.todos("research", "hermes:research:stored-1")
    ).resolves.toEqual([
      { id: "preflight", label: "Run preflight", status: "active" },
    ])
  })

  it("does not read a batched envelope that selected no Todo tool as a Todo result", async () => {
    const { operations } = harness({
      history: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_read",
              function: {
                name: "tool_call",
                arguments: JSON.stringify({
                  calls: [
                    { name: "read_file", arguments: { path: "plan.json" } },
                  ],
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_read",
          tool_name: "read_file",
          content: '{"todos": [{"id": "read", "content": "Not a plan"}]}',
        },
      ],
    })

    await expect(
      operations.todos("research", "hermes:research:stored-1")
    ).resolves.toEqual([])
  })

  it("keeps the last published plan when a later batched Todo row failed", async () => {
    const batchedCall = (id: string, todoId: string) => ({
      role: "assistant",
      tool_calls: [
        {
          id,
          function: {
            name: "tool_call",
            arguments: JSON.stringify({
              calls: [
                { name: "todo_list", arguments: { todos: [{ id: todoId }] } },
              ],
            }),
          },
        },
      ],
    })
    const { operations } = harness({
      history: [
        batchedCall("call_ok", "kept"),
        {
          role: "tool",
          tool_call_id: "call_ok",
          tool_name: "todo_list",
          content: { todos: [{ id: "kept", content: "Kept", status: "done" }] },
        },
        batchedCall("call_failed", "ignored"),
        {
          role: "tool",
          tool_call_id: "call_failed",
          tool_name: "todo_list",
          is_error: true,
          content: { todos: [{ id: "ignored", content: "Ignored" }] },
        },
      ],
    })

    await expect(
      operations.todos("research", "hermes:research:stored-1")
    ).resolves.toEqual([{ id: "kept", label: "Kept", status: "pending" }])
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

  it("reports an attached idle Session as available and idle", async () => {
    const { operations, request } = harness({
      scope: { attached: true, active: false },
      sessionInfo: { running: false },
    })

    await expect(
      operations.activity("research", "hermes:research:stored-1")
    ).resolves.toEqual({
      status: "available",
      scope: "attached-active-session",
      coverage: "active-session-only",
      state: "idle",
    })
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects an authority result for another Agent before any Hermes I/O", async () => {
    const { operations, request } = harness({ scope: { agentId: "other" } })

    await expect(
      operations.models("research", "hermes:research:stored-1")
    ).rejects.toBeInstanceOf(HermesWorkspaceScopeError)
    expect(request).not.toHaveBeenCalled()
  })

  it("reports a Session the authority does not know as out of scope", async () => {
    const { operations, request } = harness({
      scopeFailure: new HermesSessionNotFoundError(),
    })

    await expect(
      operations.context("research", "hermes:research:stored-1")
    ).rejects.toBeInstanceOf(HermesWorkspaceScopeError)
    expect(request).not.toHaveBeenCalled()
  })

  it("reports an Agent the authority does not know as out of scope", async () => {
    const { operations } = harness({
      scopeFailure: new HermesAgentNotFoundError(),
    })

    await expect(
      operations.context("research", "hermes:research:stored-1")
    ).rejects.toBeInstanceOf(HermesWorkspaceScopeError)
  })

  it("reports a Session the authority cannot reach as unavailable", async () => {
    const { operations, request } = harness({
      scopeFailure: new Error("attach did not settle"),
    })

    // A Session that cannot be reached is not a Session that does not exist:
    // reporting it as out of scope would turn one outage into a 404.
    await expect(
      operations.context("research", "hermes:research:stored-1")
    ).rejects.toBeInstanceOf(HermesWorkspaceUnavailableError)
    expect(request).not.toHaveBeenCalled()
  })
})
