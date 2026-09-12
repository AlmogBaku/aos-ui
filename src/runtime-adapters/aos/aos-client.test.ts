import { describe, expect, it, vi } from "vitest"

import { AosRemoteClient } from "./aos-client"

const catalog = {
  revision: "profiles:researcher@hermes-bots:7",
  agents: [
    {
      summary: {
        kind: "ready" as const,
        id: "researcher",
        name: "Researcher",
        activity: "unknown" as const,
        visibility: "visible" as const,
      },
      visibility: "visible" as const,
      selectable: true,
      editable: true,
      revision: "hermes-bots:7",
    },
  ],
}

describe("provider-neutral AOS browser client", () => {
  it("reads only normalized same-origin auth/runtime/catalog endpoints", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const body = path.endsWith("/auth/operator")
        ? {
            status: "authenticated",
            operator: { id: "operator@example.test" },
          }
        : path.endsWith("/auth/runtime")
          ? { status: "authenticated" }
          : path.endsWith("/runtime")
            ? {
                runtime: { id: "hermes", name: "Hermes" },
                status: "ready",
                capabilities: {
                  agentCatalog: { status: "available" },
                  agentVisibility: {
                    status: "available",
                    concurrency: "revision",
                  },
                  sessionCatalog: {
                    status: "available",
                    scope: "workspace",
                    order: "recent",
                    defaultPageSize: 50,
                    maxPageSize: 100,
                    maxWindow: 1_000,
                  },
                  sessionHistory: {
                    status: "available",
                    order: "chronological",
                    compacted: true,
                    loading: "on-open",
                    defaultPageSize: 200,
                    maxPageSize: 500,
                  },
                  sessionDetail: { status: "available" },
                  sessionCreation: { status: "available" },
                  sessionTitle: { status: "available" },
                  sessionArchival: { status: "available" },
                  sessionDeletion: { status: "available" },
                  sessionRun: { status: "available" },
                  sessionStop: { status: "available" },
                },
              }
            : catalog
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const client = new AosRemoteClient({ fetcher })

    await expect(client.operatorAuth()).resolves.toMatchObject({
      status: "authenticated",
    })
    await expect(client.runtimeAuth()).resolves.toEqual({
      status: "authenticated",
    })
    await expect(client.runtimeInfo()).resolves.toMatchObject({
      status: "ready",
    })
    await expect(client.listAgentCatalog()).resolves.toEqual([
      {
        summary: catalog.agents[0].summary,
        visibility: "visible",
        selectable: true,
        editable: true,
      },
    ])

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/auth/operator",
      "/api/aos/v1/auth/runtime",
      "/api/aos/v1/runtime",
      "/api/aos/v1/agents",
    ])
  })

  it("reconciles only real opened Session reads and keeps control/catalog reads direct", async () => {
    const scopes: unknown[] = []
    const reconciler = {
      async read<T>(scope: unknown, operation: () => Promise<T>) {
        scopes.push(scope)
        return operation()
      },
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/auth/operator"))
        return Response.json({ status: "unauthenticated" })
      if (path.endsWith("/auth/runtime"))
        return Response.json({ status: "authentication-required" })
      if (path.endsWith("/agents")) return Response.json(catalog)
      if (path.endsWith("/runtime"))
        return Response.json({
          runtime: { id: "hermes", name: "Hermes" },
          status: "unavailable",
          capabilities: {
            agentCatalog: { status: "unavailable", reason: "offline" },
            agentVisibility: { status: "unavailable", reason: "offline" },
            sessionCatalog: { status: "unavailable", reason: "offline" },
            sessionHistory: { status: "unavailable", reason: "offline" },
            sessionDetail: { status: "unavailable", reason: "offline" },
            sessionCreation: { status: "unavailable", reason: "offline" },
            sessionTitle: { status: "unavailable", reason: "offline" },
            sessionArchival: { status: "unavailable", reason: "offline" },
            sessionDeletion: { status: "unavailable", reason: "offline" },
            sessionRun: { status: "unavailable", reason: "offline" },
            sessionStop: { status: "unavailable", reason: "offline" },
          },
        })
      if (path.endsWith("/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [
            {
              id: "hermes:researcher:stored",
              agentId: "researcher",
              title: "Research",
              archived: false,
              updatedAt: "2026-01-02T00:00:00.000Z",
              status: "idle",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        })
      if (path.endsWith("/sessions/hermes%3Aresearcher%3Astored"))
        return Response.json({
          id: "hermes:researcher:stored",
          agentId: "researcher",
          title: "Research",
          archived: false,
          updatedAt: "2026-01-02T00:00:00.000Z",
          status: "idle",
        })
      if (path.includes("/sessions/hermes%3Aresearcher%3Astored/history?"))
        return Response.json({
          sessionId: "hermes:researcher:stored",
          messages: [],
          total: 0,
          limit: 200,
          offset: 0,
          nextOffset: 0,
        })
      if (path.endsWith("/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [],
          total: 0,
          limit: 50,
          offset: 0,
        })
      throw new Error(`Unexpected path: ${path}`)
    })
    const client = new AosRemoteClient({ fetcher, reconciler })

    await client.operatorAuth()
    await client.runtimeAuth()
    await client.runtimeInfo()
    await client.listAgentCatalog()
    await client.listSessions("researcher")
    await client.listSessionCatalog()
    await client.getSession("hermes:researcher:stored")
    await client.loadHistory("hermes:researcher:stored")

    expect(scopes).toEqual([
      {
        workspaceId: "operator",
        agentId: "researcher",
        sessionId: "hermes:researcher:stored",
      },
      {
        workspaceId: "operator",
        agentId: "researcher",
        sessionId: "hermes:researcher:stored",
      },
    ])
  })

  it("sends the last observed Agent revision on visibility writes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(catalog), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            revision: "profiles:researcher@hermes-bots:8",
            agent: {
              ...catalog.agents[0],
              visibility: "hidden",
              selectable: false,
              revision: "hermes-bots:8",
              summary: {
                ...catalog.agents[0].summary,
                visibility: "hidden",
              },
            },
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
    const client = new AosRemoteClient({ fetcher })
    await client.listAgentCatalog()
    await client.updateAgentVisibility("researcher", "hidden")

    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/aos/v1/agents/researcher/visibility",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({
          visibility: "hidden",
          revision: "hermes-bots:7",
        }),
      })
    )
  })

  it("rejects malformed provider-shaped catalog data", async () => {
    const client = new AosRemoteClient({
      fetcher: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...catalog,
              agents: [{ ...catalog.agents[0], ui_meta: { path: "/private" } }],
            })
          )
      ),
    })
    await expect(client.listAgentCatalog()).rejects.toThrow(
      "Invalid AOS proxy response"
    )
  })

  it("manages normalized Session metadata and lifecycle by observed ownership", async () => {
    const session = {
      id: "opaque-session-1",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "idle" as const,
    }
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
          return Response.json({
            sessions: [session],
            total: 1,
            limit: 50,
            offset: 0,
          })
        if (
          path.endsWith("/agents/researcher/sessions") &&
          init?.method === "POST"
        )
          return Response.json(
            { session: { id: "opaque-session-2", agentId: "researcher" } },
            { status: 201 }
          )
        if (path.endsWith("/agents/researcher/sessions/opaque-session-1")) {
          if (init?.method === "PATCH" || init?.method === "DELETE")
            return new Response(null, { status: 204 })
          return Response.json(session)
        }
        if (path.endsWith("/agents/researcher/sessions/opaque-session-2"))
          return Response.json({
            ...session,
            id: "opaque-session-2",
            title: "New",
          })
        throw new Error(`Unexpected normalized request: ${path}`)
      }
    )
    const client = new AosRemoteClient({ fetcher })

    await expect(client.listSessions("researcher")).resolves.toMatchObject({
      sessions: [session],
    })
    await expect(
      client.getSessionMetadata(["opaque-session-1", "missing"])
    ).resolves.toEqual([
      {
        threadId: "opaque-session-1",
        agentId: "researcher",
        updatedAt: "2026-01-02T00:00:00.000Z",
        status: "idle",
      },
    ])
    await expect(
      client.createSession("researcher", { title: "New" })
    ).resolves.toEqual({ threadId: "opaque-session-2" })
    await expect(
      client.getSessionMetadata(["opaque-session-2"])
    ).resolves.toEqual([
      {
        threadId: "opaque-session-2",
        agentId: "researcher",
        updatedAt: "2026-01-02T00:00:00.000Z",
        status: "idle",
      },
    ])
    await expect(client.getSession("opaque-session-1")).resolves.toEqual(
      session
    )
    await client.renameSession("opaque-session-1", "Renamed")
    await client.archiveSession("opaque-session-1")
    await client.unarchiveSession("opaque-session-1")
    await client.deleteSession("opaque-session-1")
    await expect(client.archiveSession("unknown-session")).rejects.toThrow(
      "Session ownership is unknown"
    )

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/agents/researcher/sessions?limit=50&offset=0",
      "/api/aos/v1/agents/researcher/sessions",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-2",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
    ])
  })

  it("loads normalized chronological history pages without native disclosure", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [
            {
              id: "opaque-session-1",
              agentId: "researcher",
              title: "Research",
              archived: false,
              updatedAt: "2026-01-02T00:00:00.000Z",
              status: "idle",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        })
      const offset = path.endsWith("offset=0") ? 0 : 2
      return Response.json({
        sessionId: "opaque-session-1",
        messages: [
          {
            id: offset === 0 ? "message-1" : "message-2",
            role: offset === 0 ? "user" : "assistant",
            content: [
              {
                type: offset === 0 ? "text" : "reasoning",
                text: offset === 0 ? "Question" : "Thinking",
              },
            ],
            createdAt:
              offset === 0
                ? "2026-01-01T00:00:00.000Z"
                : "2026-01-01T00:00:01.000Z",
          },
        ],
        total: 3,
        limit: 200,
        offset,
        nextOffset: offset === 0 ? 2 : 3,
      })
    })
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")

    await expect(client.loadHistory("opaque-session-1")).resolves.toMatchObject(
      {
        sessionId: "opaque-session-1",
        messages: [{ id: "message-1" }, { id: "message-2" }],
      }
    )
    expect(fetcher.mock.calls.slice(1).map(([input]) => String(input))).toEqual(
      [
        "/api/aos/v1/agents/researcher/sessions/opaque-session-1/history?limit=200&offset=0",
        "/api/aos/v1/agents/researcher/sessions/opaque-session-1/history?limit=200&offset=2",
      ]
    )
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("/api/sessions")
  })

  it("sends deliberate Stop to the selected normalized Session route", async () => {
    const session = {
      id: "hermes:researcher:stored",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "running" as const,
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [session],
          total: 1,
          limit: 50,
          offset: 0,
        })
      if (
        path.endsWith(
          "/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/stop"
        )
      )
        return Response.json({ status: "stopping" }, { status: 202 })
      throw new Error(`Unexpected normalized request: ${path}`)
    })
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")

    await expect(client.stopRun("hermes:researcher:stored")).resolves.toEqual({
      status: "stopping",
    })
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/stop",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    )
  })
})
