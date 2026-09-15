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

  it("adopts the provider-generated title and refreshes its Session metadata", async () => {
    const getSession = vi.fn(async () => ({
      id: "remote-session",
      agentId: "researcher",
      title: "Investigate runtime drafts",
      archived: false,
      updatedAt: "2026-09-15T18:00:00.000Z",
      status: "idle" as const,
    }))
    const adapter = new AosThreadListAdapter({
      getSession,
    } as unknown as AosRemoteClient)

    const stream = await adapter.generateTitle("remote-session")
    const chunks = []
    const reader = stream.getReader()
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }

    expect(chunks).toEqual([
      { type: "part-start", path: [0], part: { type: "text" } },
      {
        type: "text-delta",
        path: [0],
        textDelta: "Investigate runtime drafts",
      },
      { type: "part-finish", path: [0] },
    ])
  })

  it("does not poll while the provider title is still the Session ID", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({
        id: "remote-session",
        agentId: "researcher",
        title: "remote-session",
        archived: false,
        updatedAt: "1970-01-01T00:00:00.000Z",
        status: "idle" as const,
      })
      .mockResolvedValueOnce({
        id: "remote-session",
        agentId: "researcher",
        title: "Provider title",
        archived: false,
        updatedAt: "2026-09-15T18:00:00.000Z",
        status: "idle" as const,
      })
    const adapter = new AosThreadListAdapter({
      getSession,
    } as unknown as AosRemoteClient)

    const stream = await adapter.generateTitle("remote-session")
    const chunks = []
    const reader = stream.getReader()
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }

    expect(chunks).toEqual([])
    expect(getSession).toHaveBeenCalledTimes(1)
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

  it("replaces the partial history assistant with the replayed active run", async () => {
    const loadHistory = vi.fn(async () => ({
      sessionId: "session-1",
      messages: [
        {
          id: "user-1",
          role: "user" as const,
          content: [{ type: "text" as const, text: "Question" }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "partial-assistant",
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Partial" }],
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      total: 2,
      limit: 200,
      offset: 0,
      nextOffset: 2,
      execution: { status: "running" as const, runId: "run-1" },
    }))
    const reconnectRun = vi.fn(async function* () {
      yield {
        type: "TEXT_MESSAGE_CONTENT" as const,
        messageId: "assistant-1",
        delta: "Complete answer",
      }
      yield {
        type: "RUN_FINISHED" as const,
        threadId: "session-1",
        runId: "run-1",
        outcome: { type: "success" as const },
      }
    })
    const adapter = new AosThreadListAdapter({
      loadHistory,
      reconnectRun,
    } as unknown as AosRemoteClient)
    const history = adapter.historyFor("session-1")

    const loaded = await history.load()
    expect(loaded.messages.map(({ message }) => message.id)).toEqual(["user-1"])
    expect(loaded.headId).toBe("user-1")
    expect(loaded.unstable_resume).toBe(true)

    const updates = []
    for await (const update of history.resume!({
      abortSignal: new AbortController().signal,
    } as Parameters<NonNullable<typeof history.resume>>[0]))
      updates.push(update)
    expect(updates.at(-1)).toEqual({
      content: [{ type: "text", text: "Complete answer" }],
      status: { type: "complete", reason: "stop" },
    })
  })

  it("reloads authoritative history once when the active journal is unavailable", async () => {
    const historyPage = {
      sessionId: "session-1",
      messages: [
        {
          id: "user-1",
          role: "user" as const,
          content: [{ type: "text" as const, text: "Question" }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "partial-assistant",
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Partial" }],
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      total: 2,
      limit: 200,
      offset: 0,
      nextOffset: 2,
    }
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce({
        ...historyPage,
        execution: { status: "running" as const, runId: "run-1" },
      })
      .mockResolvedValueOnce({
        ...historyPage,
        messages: [
          historyPage.messages[0],
          {
            ...historyPage.messages[1],
            id: "final-assistant",
            content: [{ type: "text" as const, text: "Final answer" }],
          },
        ],
        execution: { status: "idle" as const },
      })
    const reconnectRun = vi.fn(async function* () {
      yield {
        type: "RUN_ERROR" as const,
        code: "AOS_RESET_REQUIRED",
        message: "Reload history",
      }
    })
    const adapter = new AosThreadListAdapter({
      loadHistory,
      reconnectRun,
    } as unknown as AosRemoteClient)
    const history = adapter.historyFor("session-1")
    await history.load()

    const updates = []
    for await (const update of history.resume!({
      abortSignal: new AbortController().signal,
    } as Parameters<NonNullable<typeof history.resume>>[0]))
      updates.push(update)

    expect(loadHistory).toHaveBeenCalledTimes(2)
    expect(reconnectRun).toHaveBeenCalledOnce()
    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Final answer" }],
        status: { type: "complete", reason: "stop" },
      },
    ])
  })

  it("stops recovery after one history reload when the provider still reports the run as active", async () => {
    const historyPage = {
      sessionId: "session-1",
      messages: [
        {
          id: "user-1",
          role: "user" as const,
          content: [{ type: "text" as const, text: "Question" }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "partial-assistant",
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Still working" }],
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      total: 2,
      limit: 200,
      offset: 0,
      nextOffset: 2,
      execution: { status: "running" as const, runId: "run-1" },
    }
    const loadHistory = vi.fn(async () => historyPage)
    const reconnectRun = vi.fn(async function* () {
      yield {
        type: "RUN_ERROR" as const,
        code: "AOS_RESET_REQUIRED",
        message: "Reload history",
      }
    })
    const adapter = new AosThreadListAdapter({
      loadHistory,
      reconnectRun,
    } as unknown as AosRemoteClient)
    const history = adapter.historyFor("session-1")
    await history.load()

    const updates = []
    for await (const update of history.resume!({
      abortSignal: new AbortController().signal,
    } as Parameters<NonNullable<typeof history.resume>>[0]))
      updates.push(update)

    expect(loadHistory).toHaveBeenCalledTimes(2)
    expect(reconnectRun).toHaveBeenCalledOnce()
    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Still working" }],
        status: {
          type: "incomplete",
          reason: "error",
          error: "Reload history",
        },
      },
    ])
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
