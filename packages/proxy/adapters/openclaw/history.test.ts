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
      subscribeSession: async () => () => undefined,
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

  it("[CL1-HISTORY-003] fails closed when the official scoped subscription is unavailable", async () => {
    const history = createOpenClawHistory({
      authority: authority(),
      client: { request: async () => ({ messages: [] }) },
    })

    await expect(
      history.history("analyst", "agent:analyst:main", 1, 0)
    ).rejects.toMatchObject({ name: "OpenClawHistoryUnavailableError" })
    await expect(
      history.activity("analyst", "agent:analyst:main")
    ).rejects.toMatchObject({ name: "OpenClawHistoryUnavailableError" })
  })

  it("[CL1-HISTORY-004] advances by native rows when tool records are not browser history", async () => {
    const history = createOpenClawHistory({
      authority: authority(),
      client: {
        request: async () => ({
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tool-1",
                  name: "read",
                  arguments: { path: "/private" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "tool-1",
              content: "token=secret",
            },
            { id: "user-2", role: "user", content: "Continue" },
          ],
        }),
      },
      subscribeSession: async () => () => undefined,
    })

    await expect(
      history.history("analyst", "agent:analyst:main", 3, 7)
    ).resolves.toMatchObject({
      messages: [{ id: "assistant-1", content: [] }, { id: "user-2" }],
      total: 11,
      nextOffset: 10,
    })
  })

  it("[CL1-HISTORY-005] never projects native system, thinking, tool arguments, or tool results", async () => {
    const history = createOpenClawHistory({
      authority: authority(),
      client: {
        request: async () => ({
          messages: [
            {
              id: "system",
              role: "system",
              content: "token=secret /private/system",
            },
            {
              id: "assistant",
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "token=secret /private/reasoning",
                },
                {
                  type: "toolCall",
                  id: "tool",
                  name: "read",
                  arguments: { path: "/private/tool", token: "secret" },
                },
                { type: "text", text: "Safe final answer" },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "tool",
              content: "token=secret /private/result",
            },
          ],
        }),
      },
      subscribeSession: async () => () => undefined,
    })

    const result = await history.history("analyst", "agent:analyst:main", 3, 0)
    expect(result.messages).toEqual([
      expect.objectContaining({
        id: "assistant",
        content: [{ type: "text", text: "Safe final answer" }],
      }),
    ])
    expect(JSON.stringify(result)).not.toMatch(
      /secret|\/private|thinking|toolCall|system/u
    )
  })

  it("[CL1-HISTORY-006] retries an activity read that overlaps a scoped Session event", async () => {
    let changed: (() => void) | undefined
    let reads = 0
    const history = createOpenClawHistory({
      authority: authority(),
      client: {
        request: async () => {
          reads++
          if (reads === 1) changed?.()
          return reads === 1
            ? { messages: [], sessionInfo: { activeRunIds: [] } }
            : {
                messages: [],
                sessionInfo: { activeRunIds: ["native-run"] },
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
      history.activity("analyst", "agent:analyst:main")
    ).resolves.toEqual({ state: "running" })
    expect(reads).toBe(2)
  })
})

describe("OpenClaw history AOS tools and artifacts", () => {
  const receipt = {
    ok: true,
    type: "aos.artifact",
    artifact: { path: "/workspace/report.pdf", filename: "report.pdf" },
  }

  function historyOf(messages: unknown[]) {
    return createOpenClawHistory({
      authority: authority(),
      client: { request: async () => ({ messages }) },
      subscribeSession: async () => () => undefined,
    })
  }

  function publishRows(path = receipt.artifact.path) {
    const published = { ...receipt, artifact: { ...receipt.artifact, path } }
    return [
      {
        id: "assistant",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "publish",
            name: "aos-ui__present_artifact",
            arguments: { path, title: "report.pdf" },
          },
          {
            type: "toolCall",
            id: "chart",
            name: "aos-ui__render_chart",
            arguments: { title: "Sales" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "publish",
        toolName: "aos-ui__present_artifact",
        content: [{ type: "text", text: JSON.stringify(published) }],
        details: { structuredContent: published },
      },
    ]
  }

  it("replays AOS tool calls canonically with the receipt's artifact and no native path", async () => {
    const result = await historyOf(publishRows()).history(
      "analyst",
      "agent:analyst:main",
      200,
      0
    )

    const content = result.messages[0]!.content
    expect(content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "publish",
        toolName: "present_artifact",
        args: { title: "report.pdf" },
        result: {
          ok: true,
          type: "aos.artifact",
          artifact: { id: expect.any(String), filename: "report.pdf" },
        },
      }),
      {
        type: "data",
        name: "aos.artifact",
        data: expect.objectContaining({
          id: expect.stringMatching(/^openclaw-artifact-/u),
          filename: "report.pdf",
        }),
      },
      expect.objectContaining({
        type: "tool-call",
        toolName: "render_chart",
        args: { title: "Sales" },
      }),
    ])
    expect(JSON.stringify(result)).not.toContain("/workspace")
  })

  it("replays no artifact for a receipt with an unsafe path", async () => {
    const result = await historyOf(publishRows("/workspace/.env")).history(
      "analyst",
      "agent:analyst:main",
      200,
      0
    )

    expect(
      result.messages[0]!.content.some((part) => part.type === "data")
    ).toBe(false)
  })

  it("lists a native media block under OpenClaw's own artifact id", async () => {
    const result = await historyOf([
      {
        id: "assistant",
        role: "assistant",
        content: [
          { type: "text", text: "Here it is" },
          {
            type: "image",
            artifactId: "artifact_managed_image_abc",
            url: "/api/chat/media/outgoing/private",
            alt: "chart.png",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ],
      },
    ]).history("analyst", "agent:analyst:main", 200, 0)

    expect(result.messages[0]!.content).toEqual([
      { type: "text", text: "Here it is" },
      {
        type: "data",
        name: "aos.artifact",
        data: {
          id: "artifact_managed_image_abc",
          filename: "chart.png",
          mimeType: "image/png",
          sizeBytes: 12,
          source: { type: "provider", reference: "artifact_managed_image_abc" },
        },
      },
    ])
    expect(JSON.stringify(result)).not.toContain("/api/")
  })

  it("resolves a published receipt only from its own Session's rows", async () => {
    const history = historyOf(publishRows())
    const page = await history.history("analyst", "agent:analyst:main", 200, 0)
    const id = (
      page.messages[0]!.content.find((part) => part.type === "data") as {
        data: { id: string }
      }
    ).data.id

    await expect(
      history.publishedArtifact("analyst", "agent:analyst:main", id)
    ).resolves.toMatchObject({ path: "/workspace/report.pdf" })
    await expect(
      historyOf([]).publishedArtifact("analyst", "agent:analyst:main", id)
    ).resolves.toBeUndefined()
  })
})
