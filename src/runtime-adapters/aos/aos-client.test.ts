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
        : path.endsWith("/auth/hermes")
          ? { status: "authenticated", method: "static-token" }
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
                  sessionCreation: {
                    status: "unavailable",
                    reason: "not-implemented",
                  },
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
      method: "static-token",
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
      "/api/aos/v1/auth/hermes",
      "/api/aos/v1/runtime",
      "/api/aos/v1/agents",
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
})
