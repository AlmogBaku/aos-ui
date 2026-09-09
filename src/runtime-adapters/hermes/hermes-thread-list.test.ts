import { describe, expect, it, vi } from "vitest"

import { HermesThreadListAdapter } from "./hermes-thread-list"

describe("HermesThreadListAdapter", () => {
  it("projects native archive status and delegates lifecycle mutations", async () => {
    const session = {
      threadId: "hermes:research:one",
      agentId: "research",
      profile: "research",
      storedSessionId: "one",
      title: "Archived",
      archived: true,
      updatedAt: "2026-09-09T00:00:00.000Z",
      status: "idle" as const,
      messages: [],
      running: false,
      loading: false,
    }
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      getSnapshot: () => ({ sessions: [session] }),
      session: () => session,
      renameSession: vi.fn().mockResolvedValue(undefined),
      archiveSession: vi.fn().mockResolvedValue(undefined),
      unarchiveSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = new HermesThreadListAdapter(client as never)

    await expect(adapter.list()).resolves.toEqual({
      threads: [expect.objectContaining({ status: "archived" })],
    })
    await adapter.rename(session.threadId, "Renamed")
    await adapter.archive(session.threadId)
    await adapter.unarchive(session.threadId)
    await adapter.delete(session.threadId)
    expect(client.renameSession).toHaveBeenCalledWith(
      session.threadId,
      "Renamed"
    )
    expect(client.archiveSession).toHaveBeenCalledWith(session.threadId)
    expect(client.unarchiveSession).toHaveBeenCalledWith(session.threadId)
    expect(client.deleteSession).toHaveBeenCalledWith(session.threadId)
  })
})
