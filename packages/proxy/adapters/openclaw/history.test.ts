import { describe, expect, it } from "vitest"

import { createOpenClawHistory } from "./history"

function authority() {
  return {
    getSession: async (agentId: string, sessionId: string) => ({
      id: sessionId,
      agentId,
      title: "Session",
      archived: false,
      updatedAt: "2026-09-15T00:00:00.000Z",
      status: "idle" as const,
    }),
  }
}

describe("OpenClaw authoritative history", () => {
  it("[CL1-HISTORY-001] subscribes before history and retries a dirty read without treating tasks as Todos", async () => {
    const requests: Array<{ method: string; params: unknown }> = []
    let changed: (() => void) | undefined
    let reads = 0
    const history = createOpenClawHistory({
      authority: authority(),
      client: {
        request: async (method, params) => {
          requests.push({ method, params })
          reads++
          if (reads === 1) changed?.()
          return {
            messages: [
              {
                id: "message-1",
                role: "assistant",
                content: [{ type: "text", text: "Saved" }],
                timestamp: 1_789_430_400_000,
              },
            ],
            sessionInfo: { activeRunIds: [] },
            tasks: [{ id: "native-task", title: "Do not project" }],
          }
        },
      },
      subscribeSession: async (_agentId, _sessionKey, listener) => {
        changed = listener
        return () => {
          changed = undefined
        }
      },
    })

    await expect(
      history.history("analyst", "agent:analyst:main", 200, 0)
    ).resolves.toEqual({
      sessionId: "agent:analyst:main",
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: [{ type: "text", text: "Saved" }],
          createdAt: "2026-09-15T00:00:00.000Z",
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
      nextOffset: 1,
      execution: { status: "idle" },
    })
    expect(requests).toEqual([
      {
        method: "chat.history",
        params: {
          agentId: "analyst",
          sessionKey: "agent:analyst:main",
          limit: 200,
          offset: 0,
        },
      },
      {
        method: "chat.history",
        params: {
          agentId: "analyst",
          sessionKey: "agent:analyst:main",
          limit: 200,
          offset: 0,
        },
      },
    ])
  })

  it("[CL1-HISTORY-002] projects aggregate context and provider models only after exact ownership verification", async () => {
    const history = createOpenClawHistory({
      authority: authority(),
      client: {
        request: async (method) => {
          if (method === "models.list")
            return {
              models: [
                {
                  id: "sonnet",
                  name: "Sonnet",
                  provider: "anthropic",
                  contextWindow: 200_000,
                },
              ],
            }
          return {
            sessions: [
              {
                key: "agent:analyst:main",
                agentId: "analyst",
                model: "sonnet",
                modelProvider: "anthropic",
                totalTokens: 50,
                contextTokens: 200_000,
              },
            ],
          }
        },
      },
    })

    await expect(
      history.models("analyst", "agent:analyst:main")
    ).resolves.toEqual({
      selectedId: '["anthropic","sonnet"]',
      options: [
        { id: '["anthropic","sonnet"]', label: "Sonnet", group: "anthropic" },
      ],
    })
    await expect(
      history.context("analyst", "agent:analyst:main")
    ).resolves.toEqual({
      usedTokens: 50,
      maxTokens: 200_000,
      source: "provider-usage",
    })
  })
})
