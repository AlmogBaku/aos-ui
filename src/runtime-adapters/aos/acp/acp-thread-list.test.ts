import type { SessionInfo } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"

import { AosDraftRegistry } from "../aos-drafts"
import {
  createAcpThreadListAdapter,
  type AcpThreadListOptions,
} from "./acp-thread-list"

function sessionInfo({
  sessionId,
  agentId,
  title,
  updatedAt,
  archived = false,
}: {
  sessionId: string
  agentId: string
  title?: string
  updatedAt?: string
  archived?: boolean
}): SessionInfo {
  return {
    sessionId,
    cwd: "/workspaces/demo",
    ...(title === undefined ? {} : { title }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    _meta: { aos: { agentId, status: "idle", archived } },
  }
}

function harness(
  overrides: Partial<AcpThreadListOptions["connection"]> = {},
  options: Partial<Omit<AcpThreadListOptions, "connection">> = {}
) {
  const connection = {
    listSessions: vi.fn(async () => ({ sessions: [] })),
    newSession: vi.fn(async () => ({ sessionId: "remote-session" })),
    updateSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    ...overrides,
  }
  const drafts = options.drafts ?? new AosDraftRegistry()
  const titleFor = options.titleFor ?? (() => undefined)
  const adapter = createAcpThreadListAdapter({
    connection,
    drafts,
    titleFor,
    ...(options.agentIdFor ? { agentIdFor: options.agentIdFor } : {}),
    ...(options.agentScope ? { agentScope: options.agentScope } : {}),
  })
  return { adapter, connection, drafts }
}

async function chunksOf(stream: ReadableStream<unknown>) {
  const reader = stream.getReader()
  const chunks: unknown[] = []
  for (;;) {
    const result = await reader.read()
    if (result.done) return chunks
    chunks.push(result.value)
  }
}

describe("ACP remote thread-list adapter", () => {
  it("projects the Session catalog and remembers each Session's Agent", async () => {
    const { adapter, connection } = harness({
      listSessions: vi.fn(async () => ({
        sessions: [
          sessionInfo({
            sessionId: "session-1",
            agentId: "researcher",
            title: "Investigate drafts",
            updatedAt: "2026-09-15T18:00:00.000Z",
          }),
          sessionInfo({
            sessionId: "session-2",
            agentId: "builder",
            archived: true,
          }),
        ],
      })),
    })

    const page = await adapter.list()

    expect(connection.listSessions).toHaveBeenCalledWith({}, undefined)
    expect(page).toEqual({
      threads: [
        {
          status: "regular",
          remoteId: "session-1",
          title: "Investigate drafts",
          lastMessageAt: new Date("2026-09-15T18:00:00.000Z"),
        },
        {
          status: "archived",
          remoteId: "session-2",
          title: undefined,
          lastMessageAt: undefined,
        },
      ],
    })
    expect(adapter.agentFor("session-1")).toBe("researcher")
    expect(adapter.agentFor("session-2")).toBe("builder")
  })

  it("surfaces the provider cursor only while pages remain", async () => {
    const listSessions = vi.fn(async (_meta: unknown, cursor?: string) =>
      cursor === undefined
        ? {
            sessions: [sessionInfo({ sessionId: "session-1", agentId: "one" })],
            nextCursor: "cursor-2",
          }
        : {
            sessions: [sessionInfo({ sessionId: "session-2", agentId: "two" })],
          }
    )
    const { adapter } = harness({ listSessions })

    const first = await adapter.list()
    expect(first.nextCursor).toBe("cursor-2")

    const second = await adapter.list({ after: first.nextCursor })
    expect(listSessions).toHaveBeenLastCalledWith({}, "cursor-2")
    expect(second.nextCursor).toBeUndefined()
    expect(second.threads.map(({ remoteId }) => remoteId)).toEqual([
      "session-2",
    ])
  })

  describe("scoped to the selected Agent", () => {
    const pinned = sessionInfo({ sessionId: "aster-pinned", agentId: "aster" })
    // Every Agent's page one and Aster's own pages, as the proxy serves them.
    function scopedCatalog(asterPages: SessionInfo[][]) {
      return vi.fn(
        async (meta: { agentId?: string }, cursor?: string) => {
          if (meta.agentId === undefined)
            return {
              sessions: [
                sessionInfo({ sessionId: "willow-1", agentId: "willow" }),
                pinned,
              ],
              nextCursor: "every-agent-2",
            }
          const index = cursor === undefined ? 0 : Number(cursor)
          return {
            sessions: asterPages[index] ?? [],
            ...(index + 1 < asterPages.length
              ? { nextCursor: String(index + 1) }
              : {}),
          }
        }
      )
    }

    it("loads more of that Agent's Sessions only, with the Agent in the list meta", async () => {
      const listSessions = scopedCatalog([
        [sessionInfo({ sessionId: "aster-1", agentId: "aster" }), pinned],
        [sessionInfo({ sessionId: "aster-2", agentId: "aster" }), pinned],
      ])
      const { adapter } = harness(
        { listSessions },
        { agentScope: () => "aster" }
      )

      const first = await adapter.list()
      // Other Agents keep their page one; the pinned Session is listed once.
      expect(first.threads.map(({ remoteId }) => remoteId)).toEqual([
        "aster-1",
        "aster-pinned",
        "willow-1",
      ])
      expect(first.nextCursor).toBe("1")

      listSessions.mockClear()
      const second = await adapter.list({ after: first.nextCursor })

      expect(listSessions.mock.calls).toEqual([[{ agentId: "aster" }, "1"]])
      expect(second.threads.map(({ remoteId }) => remoteId)).toEqual([
        "aster-2",
        "aster-pinned",
      ])
      expect(second.nextCursor).toBeUndefined()
    })

    it("offers no further page to an Agent whose Sessions all fit", async () => {
      const { adapter } = harness(
        {
          listSessions: scopedCatalog([
            [sessionInfo({ sessionId: "aster-1", agentId: "aster" })],
          ]),
        },
        { agentScope: () => "aster" }
      )

      await expect(adapter.list()).resolves.not.toHaveProperty("nextCursor")
    })

    it("ends the cursor at a page that adds no Session", async () => {
      const { adapter } = harness(
        {
          listSessions: vi.fn(async () => ({
            sessions: [],
            nextCursor: "still-more",
          })),
        },
        { agentScope: () => "aster" }
      )

      await expect(
        adapter.list({ after: "more" })
      ).resolves.not.toHaveProperty("nextCursor")
    })

    it("resolves an unlisted Session from that Agent's own pages", async () => {
      const listSessions = scopedCatalog([
        [sessionInfo({ sessionId: "aster-1", agentId: "aster" })],
        [sessionInfo({ sessionId: "aster-2", agentId: "aster" })],
      ])
      const { adapter } = harness(
        { listSessions },
        { agentScope: () => "aster" }
      )

      await expect(adapter.fetch("aster-2")).resolves.toMatchObject({
        remoteId: "aster-2",
      })
      expect(listSessions.mock.calls).toEqual([
        [{ agentId: "aster" }, undefined],
        [{ agentId: "aster" }, "1"],
      ])
    })
  })

  it("rejects a Session the proxy described without AOS metadata", async () => {
    const { adapter } = harness({
      listSessions: vi.fn(async () => ({
        sessions: [{ sessionId: "session-1", cwd: "/workspaces/demo" }],
      })),
    })

    await expect(adapter.list()).rejects.toThrow()
  })

  it("creates the drafted Agent's Session once when its local thread initializes", async () => {
    const drafts = new AosDraftRegistry()
    drafts.record("local-draft-1", "researcher")
    const { adapter, connection } = harness({}, { drafts })

    const [first, second] = await Promise.all([
      adapter.initialize("local-draft-1"),
      adapter.initialize("local-draft-1"),
    ])

    expect(connection.newSession).toHaveBeenCalledTimes(1)
    expect(connection.newSession).toHaveBeenCalledWith({
      agentId: "researcher",
    })
    expect(first).toEqual({ remoteId: "remote-session" })
    expect(second).toEqual({ remoteId: "remote-session" })
    expect(adapter.agentFor("remote-session")).toBe("researcher")
  })

  it("resolves a Session it has not listed from a later catalog page", async () => {
    const pages = [
      [sessionInfo({ sessionId: "session-1", agentId: "researcher" })],
      [
        sessionInfo({
          sessionId: "session-9",
          agentId: "builder",
          title: "Bookmarked",
          updatedAt: "2026-09-10T08:00:00.000Z",
        }),
      ],
    ]
    const listSessions = vi.fn(async (_meta: unknown, cursor?: string) => {
      const index = cursor === undefined ? 0 : Number(cursor)
      return {
        sessions: pages[index] ?? [],
        ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
      }
    })
    const { adapter } = harness({ listSessions })

    await expect(adapter.fetch("session-9")).resolves.toEqual({
      status: "regular",
      remoteId: "session-9",
      title: "Bookmarked",
      lastMessageAt: new Date("2026-09-10T08:00:00.000Z"),
    })
    expect(adapter.agentFor("session-9")).toBe("builder")
    expect(listSessions).toHaveBeenCalledTimes(2)

    // The resolved Session is remembered, so opening it again costs no read.
    await expect(adapter.fetch("session-9")).resolves.toMatchObject({
      remoteId: "session-9",
    })
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it("reports a Session the catalog does not carry", async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [sessionInfo({ sessionId: "session-1", agentId: "one" })],
    }))
    const { adapter } = harness({ listSessions })

    await expect(adapter.fetch("session-missing")).rejects.toThrow()
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it("initializes an already listed Session without a remote write", async () => {
    const { adapter, connection } = harness({
      listSessions: vi.fn(async () => ({
        sessions: [sessionInfo({ sessionId: "session-1", agentId: "one" })],
      })),
    })
    await adapter.list()

    await expect(adapter.initialize("session-1")).resolves.toEqual({
      remoteId: "session-1",
    })
    expect(connection.newSession).not.toHaveBeenCalled()
    await expect(adapter.initialize("unknown-session")).rejects.toThrow()
  })

  it("writes one Session intent per rename, archive, unarchive, and delete", async () => {
    // The catalog is what a Session exists in, so a deleted one leaves it.
    const catalog = new Map([
      [
        "session-1",
        sessionInfo({
          sessionId: "session-1",
          agentId: "one",
          title: "Before",
        }),
      ],
    ])
    const { adapter, connection } = harness({
      listSessions: vi.fn(async () => ({ sessions: [...catalog.values()] })),
      deleteSession: vi.fn(async (sessionId: string) => {
        catalog.delete(sessionId)
      }),
    })
    await adapter.list()

    await adapter.rename("session-1", "After")
    expect(connection.updateSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      title: "After",
    })
    await expect(adapter.fetch("session-1")).resolves.toMatchObject({
      title: "After",
    })

    await adapter.archive("session-1")
    expect(connection.updateSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      archived: true,
    })
    await expect(adapter.fetch("session-1")).resolves.toMatchObject({
      status: "archived",
    })

    await adapter.unarchive("session-1")
    expect(connection.updateSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      archived: false,
    })
    await expect(adapter.fetch("session-1")).resolves.toMatchObject({
      status: "regular",
    })

    await adapter.delete("session-1")
    expect(connection.deleteSession).toHaveBeenCalledWith("session-1")
    await expect(adapter.fetch("session-1")).rejects.toThrow()
    expect(adapter.agentFor("session-1")).toBeUndefined()
  })

  it("streams the tracked provider title and nothing before one exists", async () => {
    const titles = new Map([
      ["titled-session", "  Investigate runtime drafts  "],
      ["untitled-session", "untitled-session"],
    ])
    const { adapter } = harness({}, { titleFor: (id) => titles.get(id) })

    await expect(
      adapter.generateTitle("titled-session", []).then(chunksOf)
    ).resolves.toEqual([
      { type: "part-start", path: [0], part: { type: "text" } },
      {
        type: "text-delta",
        path: [0],
        textDelta: "Investigate runtime drafts",
      },
      { type: "part-finish", path: [0] },
    ])

    await expect(
      adapter.generateTitle("untitled-session", []).then(chunksOf)
    ).resolves.toEqual([])
    await expect(
      adapter.generateTitle("unknown-session", []).then(chunksOf)
    ).resolves.toEqual([])
  })

  it("falls back to the workspace Agent index for Sessions it never listed", async () => {
    const { adapter } = harness(
      {},
      {
        agentIdFor: (remoteId) =>
          remoteId === "live-session" ? "beta" : undefined,
      }
    )

    expect(adapter.agentFor("live-session")).toBe("beta")
    expect(adapter.agentFor("other-session")).toBeUndefined()
  })
})
