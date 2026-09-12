import { describe, expect, it, vi } from "vitest"

import type { AosRemoteClient } from "./aos-client"
import { AosThreadListAdapter } from "./aos-thread-list"

describe("AOS remote thread-list adapter", () => {
  it("pages Agent-scoped Session catalogs only when assistant-ui requests more", async () => {
    const listSessionCatalog = vi.fn(async (limit: number, offset: number) => ({
      sessions: Array.from({ length: offset === 0 ? 50 : 1 }, (_, index) => ({
        id: `${index % 2 === 0 ? "beta" : "alpha"}-${offset + index}`,
        agentId: index % 2 === 0 ? "beta" : "alpha",
        title: `Session ${offset + index}`,
        archived: false,
        updatedAt: new Date(
          Date.UTC(2026, 0, 1, 0, 0, 51 - offset - index)
        ).toISOString(),
        status: "idle" as const,
      })),
      total: 51,
      limit,
      offset,
    }))
    const client = {
      listSessionCatalog,
    } as unknown as AosRemoteClient
    const adapter = new AosThreadListAdapter(client)

    const first = await adapter.list()
    expect(first.threads).toHaveLength(50)
    expect(first.threads.slice(0, 2).map(({ remoteId }) => remoteId)).toEqual([
      "beta-0",
      "alpha-1",
    ])
    expect(listSessionCatalog.mock.calls).toEqual([[50, 0]])

    await adapter.list({ after: first.nextCursor })
    expect(listSessionCatalog.mock.calls.slice(1)).toEqual([[50, 50]])
  })
})
