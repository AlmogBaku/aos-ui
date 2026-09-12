import type { RunAgentInput } from "@ag-ui/client"
import { describe, expect, it, vi } from "vitest"

import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import type { AosEventScope } from "./aos-reconciliation"

const scope = {
  workspaceId: "guest",
  agentId: "researcher",
  sessionId: "hermes:researcher:stored-session",
}

function collect(
  agent: ReturnType<typeof createAosRunAgent>,
  input: RunAgentInput
) {
  return new Promise<void>((resolve, reject) => {
    agent.run(input).subscribe({
      error: reject,
      complete: resolve,
    })
  })
}

describe("AOS guest transport configuration", () => {
  it("sends authoritative reads through the configured lane with the invitation bearer", async () => {
    const readScopes: AosEventScope[] = []
    const reconciler = {
      async read<T>(target: AosEventScope, operation: () => Promise<T>) {
        readScopes.push(target)
        return operation()
      },
    }
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        sessionId: scope.sessionId,
        messages: [],
        total: 0,
        limit: 200,
        offset: 0,
        nextOffset: 0,
      })
    )
    const client = new AosRemoteClient({
      fetcher,
      reconciler,
      basePath: "/api/guest/v1",
      authorization: "Bearer invitation.jwt",
      scope,
    })

    await expect(client.loadHistory(scope.sessionId)).resolves.toMatchObject({
      sessionId: scope.sessionId,
      messages: [],
    })

    expect(readScopes).toEqual([scope])
    expect(fetcher).toHaveBeenCalledWith(
      "/api/guest/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored-session/history?limit=200&offset=0",
      expect.objectContaining({
        credentials: "same-origin",
      })
    )
    const historyHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(historyHeaders.get("accept")).toBe("application/json")
    expect(historyHeaders.get("authorization")).toBe("Bearer invitation.jwt")
  })

  it("streams runs through the configured guest path with the same bearer", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        `data: ${JSON.stringify({
          type: "RUN_FINISHED",
          threadId: scope.sessionId,
          runId: "run-1",
          outcome: { type: "success" },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      )
    )
    const agent = createAosRunAgent({
      agentId: scope.agentId,
      threadId: scope.sessionId,
      fetcher,
      basePath: "/api/guest/v1",
      authorization: "Bearer invitation.jwt",
    })

    await collect(agent, {
      threadId: scope.sessionId,
      runId: "run-1",
      state: {},
      messages: [{ id: "message-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(fetcher).toHaveBeenCalledWith(
      "/api/guest/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored-session/runs",
      expect.objectContaining({
        credentials: "same-origin",
      })
    )
    const runHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(runHeaders.get("authorization")).toBe("Bearer invitation.jwt")
  })
})
