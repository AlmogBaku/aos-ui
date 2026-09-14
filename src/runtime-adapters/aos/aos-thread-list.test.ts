import { describe, expect, it, vi } from "vitest"

import type { AosRemoteClient } from "./aos-client"
import { AosDraftRegistry } from "./aos-drafts"
import { AosThreadListAdapter } from "./aos-thread-list"

describe("AOS remote thread-list adapter", () => {
  it("creates a selected Agent's remote Session only when its local draft initializes", async () => {
    const createSession = vi.fn(async (agentId: string) => ({
      threadId: `${agentId}-remote-session`,
    }))
    const fetch = vi.fn(async () => {
      throw new Error("A local draft must not fetch remote metadata")
    })
    const drafts = new AosDraftRegistry()
    drafts.record("local-draft-1", "researcher")
    const adapter = new AosThreadListAdapter(
      { createSession, fetch } as unknown as AosRemoteClient,
      drafts
    )

    await expect(adapter.initialize("local-draft-1")).resolves.toEqual({
      remoteId: "researcher-remote-session",
      externalId: "researcher-remote-session",
    })

    expect(createSession).toHaveBeenCalledWith("researcher")
    expect(fetch).not.toHaveBeenCalled()
    expect(adapter.agentFor("researcher-remote-session")).toBe("researcher")
  })

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

  it("marks an active native Session for assistant-ui reload recovery without resending a prompt", async () => {
    const loadHistory = vi.fn(async () => ({
      sessionId: "session-1",
      messages: [],
      total: 0,
      limit: 200,
      offset: 0,
      nextOffset: 0,
      execution: { status: "running" as const, runId: "restored-run" },
    }))
    const reconnectRun = vi.fn(async function* () {
      yield {
        type: "TEXT_MESSAGE_CONTENT" as const,
        messageId: "assistant-1",
        delta: "Recovered",
      }
      yield {
        type: "RUN_FINISHED" as const,
        threadId: "session-1",
        runId: "restored-run",
        outcome: { type: "success" as const },
      }
    })
    const adapter = new AosThreadListAdapter({
      loadHistory,
      reconnectRun,
    } as unknown as AosRemoteClient)
    const history = adapter.historyFor("session-1")

    await expect(history.load()).resolves.toMatchObject({
      unstable_resume: true,
    })
    const updates = []
    for await (const update of history.resume!({
      abortSignal: new AbortController().signal,
    } as Parameters<NonNullable<typeof history.resume>>[0]))
      updates.push(update)

    expect(reconnectRun).toHaveBeenCalledWith(
      "session-1",
      "restored-run",
      expect.any(AbortSignal)
    )
    expect(updates.at(-1)).toEqual({
      content: [{ type: "text", text: "Recovered" }],
      status: { type: "complete", reason: "stop" },
    })
  })

  it("restores waiting AG-UI interrupts from the authoritative Session snapshot", async () => {
    const adapter = new AosThreadListAdapter({
      loadHistory: async () => ({
        sessionId: "session-1",
        messages: [
          {
            id: "assistant-question",
            role: "assistant" as const,
            content: [],
            createdAt: "2026-01-02T00:00:00.000Z",
            status: {
              type: "requires-action" as const,
              reason: "interrupt" as const,
            },
            metadata: {
              custom: {
                agui: {
                  interrupts: [
                    {
                      id: "approval-1",
                      reason: "confirmation",
                      message: "May I continue?",
                      responseSchema: {
                        type: "string",
                        enum: ["once", "deny"],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
        nextOffset: 1,
        execution: {
          status: "waiting-for-input" as const,
          runId: "waiting-segment",
        },
      }),
    } as unknown as AosRemoteClient)

    const history = await adapter.historyFor("session-1").load()

    expect(history.unstable_resume).toBeUndefined()
    expect(history.messages.at(-1)?.message).toMatchObject({
      role: "assistant",
      status: { type: "requires-action", reason: "interrupt" },
      metadata: {
        custom: {
          agui: { interrupts: [{ id: "approval-1" }] },
        },
      },
    })
  })
})
