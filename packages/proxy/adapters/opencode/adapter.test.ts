import { describe, expect, it, vi } from "vitest"

import type { ServerTurnEngine } from "../../core/runtime"
import { OpenCodeServerAdapter, type OpenCodeAdapterClient } from "./adapter"

const turnEngine: ServerTurnEngine = {
  async start() {
    throw new Error("run engine is not exercised by this adapter test")
  },
  async recover() {
    throw new Error("run engine is not exercised by this adapter test")
  },
}

function message(id: string, created: number) {
  return {
    id,
    type: "user" as const,
    text: id,
    time: { created },
  }
}

function client(): OpenCodeAdapterClient {
  return {
    catalog: {
      agents: async () => ({
        data: [
          {
            id: "research",
            description: "Researches",
            mode: "primary",
            hidden: false,
            permissions: [],
            request: {},
          },
        ],
      }),
      models: async () => ({
        data: [
          {
            id: "gpt-5",
            providerID: "openai",
            name: "GPT-5",
            enabled: true,
            status: "active",
            limit: { context: 128_000, output: 16_000 },
          },
        ],
      }),
    },
    sessions: {
      list: async () => ({
        data: [
          {
            id: "session-1",
            agent: "research",
            title: "Research notes",
            time: { created: 1_000, updated: 2_000 },
          },
        ],
        cursor: {},
      }),
      get: async () => ({
        id: "session-1",
        agent: "research",
        model: { providerID: "openai", modelID: "gpt-5" },
        title: "Research notes",
        time: { created: 1_000, updated: 2_000 },
      }),
      create: async () => ({
        id: "created",
        agent: "research",
        title: "New session",
        time: { created: 1_000 },
      }),
      update: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      messages: vi.fn(async (_sessionId, options) => {
        if (options?.cursor === "second")
          return { data: [message("message-2", 2_000)], cursor: {} }
        if (options?.cursor === "older")
          return { data: [message("message-1", 1_000)], cursor: {} }
        if (options?.order === "desc")
          return {
            data: [message("message-2", 2_000)],
            cursor: { next: "older" },
          }
        return {
          data: [message("message-1", 1_000)],
          cursor: { next: "second" },
        }
      }),
      switchModel: vi.fn(async () => {}),
      context: async () => ({ data: [] }),
      todos: vi.fn(async () => [
        {
          content: "Read the adapter",
          status: "in_progress",
          priority: "high",
        },
        { content: "Write the test", status: "cancelled", priority: "low" },
      ]),
      questions: { reply: async () => {}, reject: async () => {} },
      permissions: { reply: async () => {} },
    },
    files: {
      read: vi.fn(async () => {
        throw new Error("files are not read by this test")
      }),
    },
    close: vi.fn(async () => {}),
  }
}

describe("OpenCode server adapter", () => {
  it("projects native enabled models and switches only an exact owned Session model", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await expect(adapter.models("research", "session-1")).resolves.toEqual({
      selectedId: '["openai","gpt-5"]',
      options: [{ id: '["openai","gpt-5"]', label: "GPT-5", group: "openai" }],
    })
    await expect(
      adapter.updateModel("research", "session-1", {
        selectedId: '["openai","gpt-5"]',
      })
    ).resolves.toEqual({ selectedId: '["openai","gpt-5"]' })
    expect(native.sessions.switchModel).toHaveBeenCalledWith("session-1", {
      providerID: "openai",
      id: "gpt-5",
    })
    // OpenCode reports no reasoning ladder, so an effort is never settled here.
    await expect(
      adapter.updateModel("research", "session-1", { effortId: "high" })
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceUnavailableError" })
    const unknown = await adapter
      .updateModel("research", "session-1", {
        selectedId: '["openai","unknown"]',
      })
      .catch((error: unknown) => error)
    expect(adapter.publicError(unknown)?.kind).toBe("invalid_request")
    expect(native.sessions.switchModel).toHaveBeenCalledTimes(1)
    await expect(
      adapter.context("research", "session-1")
    ).rejects.toMatchObject({
      name: "OpenCodeWorkspaceUnavailableError",
    })
  })

  it("lists a Session's model by its id when the catalog no longer has it", async () => {
    const native = client()
    native.catalog.models = async () => ({ data: [] })
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await expect(adapter.models("research", "session-1")).resolves.toEqual({
      selectedId: '["openai","gpt-5"]',
      options: [{ id: '["openai","gpt-5"]', label: "gpt-5", group: "openai" }],
    })
  })

  it("uses newest-first native message pages for exact-Agent authoritative history", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await expect(
      adapter.history("research", "session-1", 1, 0)
    ).resolves.toEqual({
      sessionId: "session-1",
      messages: [
        {
          id: "message-2",
          role: "user",
          createdAt: "1970-01-01T00:33:20.000Z",
          content: [{ type: "text", text: "message-2" }],
        },
        {
          id: "aos-plan:session-1",
          role: "activity",
          activityType: "PLAN",
          content: {
            todos: [
              { id: "0", label: "Read the adapter", status: "active" },
              { id: "1", label: "Write the test", status: "failed" },
            ],
          },
        },
      ],
      total: 2,
      limit: 1,
      offset: 0,
      nextOffset: 1,
    })
    expect(native.sessions.messages).toHaveBeenNthCalledWith(1, "session-1", {
      limit: 100,
      order: "desc",
    })
    expect(native.sessions.messages).toHaveBeenNthCalledWith(2, "session-1", {
      limit: 100,
      cursor: "older",
    })
    // One authoritative native Todo read per history load, and no second one.
    expect(native.sessions.todos).toHaveBeenCalledTimes(1)
    expect(native.sessions.todos).toHaveBeenCalledWith("session-1")
  })

  it("loads history without a plan when the native Todo read fails or is unreadable", async () => {
    for (const todos of [
      vi.fn(async () => {
        throw new Error("native todo read failed")
      }),
      vi.fn(async () => "not a list" as unknown as unknown[]),
    ]) {
      const native = client()
      native.sessions.todos = todos
      const adapter = new OpenCodeServerAdapter({
        client: native,
        turns: turnEngine,
      })

      const history = await adapter.history("research", "session-1", 1, 0)

      expect(history.messages).toEqual([
        {
          id: "message-2",
          role: "user",
          createdAt: "1970-01-01T00:33:20.000Z",
          content: [{ type: "text", text: "message-2" }],
        },
      ])
      expect(todos).toHaveBeenCalledTimes(1)
    }
  })

  describe("newest-first history pages", () => {
    const assistant = (id: string, created: number) => ({
      id,
      type: "assistant" as const,
      agent: "research",
      model: { providerID: "openai", id: "gpt-5" },
      time: { created },
      content: [{ id: `${id}-text`, type: "text" as const, text: id }],
    })

    /** Serves a chronological store in either native order behind a cursor. */
    function transcriptClient(store: readonly unknown[]) {
      const native = client()
      const messages = vi.fn(
        async (
          _sessionId: string,
          options?: { limit?: number; order?: string; cursor?: string }
        ) => {
          const [order, from] = options?.cursor?.split(":") ?? [
            options?.order ?? "asc",
            "0",
          ]
          const ordered = order === "desc" ? [...store].reverse() : store
          const start = Number(from)
          const next = start + (options?.limit ?? 100)
          return {
            data: ordered.slice(start, next),
            cursor: next < ordered.length ? { next: `${order}:${next}` } : {},
          }
        }
      )
      return { ...native, sessions: { ...native.sessions, messages } }
    }

    const conversation = [
      message("u1", 1_000),
      assistant("a1", 2_000),
      message("u2", 3_000),
      assistant("a2", 4_000),
      message("u3", 5_000),
      assistant("a3", 6_000),
    ]

    it("reads offset 0 as the newest messages and offset N as the ones before", async () => {
      const native = transcriptClient(conversation)
      const adapter = new OpenCodeServerAdapter({
        client: native,
        turns: turnEngine,
      })
      const ids = async (offset: number) => {
        const page = await adapter.history("research", "session-1", 2, offset)
        return [page.messages.map(({ id }) => id), page.nextOffset, page.total]
      }

      expect(await ids(0)).toEqual([["u3", "a3", "aos-plan:session-1"], 2, 6])
      expect(await ids(2)).toEqual([["u2", "a2"], 4, 6])
      expect(await ids(4)).toEqual([["u1", "a1"], 6, 6])
      expect(native.sessions.messages).toHaveBeenCalledWith("session-1", {
        limit: 100,
        order: "desc",
      })
      // The plan is the Session's current one, read for the newest page alone.
      expect(native.sessions.todos).toHaveBeenCalledTimes(1)
    })

    it("snaps a page to its first user message unless it reached the start or holds none", async () => {
      const adapter = new OpenCodeServerAdapter({
        client: transcriptClient([
          message("u1", 1_000),
          assistant("a1", 2_000),
          assistant("a1b", 3_000),
          message("u2", 4_000),
          assistant("a2", 5_000),
        ]),
        turns: turnEngine,
      })

      const newest = await adapter.history("research", "session-1", 3, 0)
      const oldest = await adapter.history("research", "session-1", 3, 2)
      const longTurn = await adapter.history("research", "session-1", 2, 2)

      expect(newest.messages.map(({ id }) => id)).toEqual([
        "u2",
        "a2",
        "aos-plan:session-1",
      ])
      expect(newest.nextOffset).toBe(2)
      expect(oldest.messages.map(({ id }) => id)).toEqual(["u1", "a1", "a1b"])
      expect(oldest).toMatchObject({ nextOffset: 5, total: 5 })
      expect(longTurn.messages.map(({ id }) => id)).toEqual(["a1", "a1b"])
      expect(longTurn.nextOffset).toBe(4)
    })

    it("reports older history as truncated past the native read reach", async () => {
      const adapter = new OpenCodeServerAdapter({
        client: transcriptClient(
          Array.from({ length: 400 }, (_, index) =>
            message(`m${index}`, index + 1)
          )
        ),
        turns: turnEngine,
        // Three native pages of 100 reach the newest 300 messages.
        maxHistoryPages: 3,
      })

      const edge = await adapter.history("research", "session-1", 1, 299)
      const beyond = await adapter.history("research", "session-1", 1, 300)

      expect(edge.messages.map(({ id }) => id)).toEqual(["m100"])
      expect(edge).toMatchObject({ nextOffset: 300, truncated: true })
      expect(beyond).toMatchObject({ messages: [], truncated: true })
    })

    it("counts a response's thought toward the messages a read needs", async () => {
      const thinking = (id: string, created: number) => ({
        ...assistant(id, created),
        content: [
          { id: `${id}-reason`, type: "reasoning" as const, text: id },
          ...assistant(id, created).content,
        ],
      })
      const native = transcriptClient(
        Array.from({ length: 150 }, (_, index) =>
          thinking(`a${index}`, index + 1)
        )
      )
      const adapter = new OpenCodeServerAdapter({
        client: native,
        turns: turnEngine,
      })

      // One native page of 100 already projects to the 152 messages needed.
      const page = await adapter.history("research", "session-1", 1, 150)

      expect(page.messages.map(({ id }) => id)).toEqual(["a74"])
      expect(native.sessions.messages).toHaveBeenCalledTimes(1)
    })
  })

  it("renames, archives, pins, and deletes an owned Session through the native routes", async () => {
    const native = client()
    native.sessions.get = async () => ({
      id: "session-1",
      agent: "research",
      title: "Research notes",
      time: { created: 1_000, updated: 2_000 },
      metadata: { "native.label": "keep me" },
    })
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await adapter.updateSession("research", "session-1", {
      title: "Renamed",
    })
    expect(native.sessions.update).toHaveBeenNthCalledWith(1, "session-1", {
      title: "Renamed",
    })
    await adapter.updateSession("research", "session-1", {
      archived: true,
    })
    expect(native.sessions.update).toHaveBeenNthCalledWith(2, "session-1", {
      time: { archived: expect.any(Number) },
    })
    await adapter.updateSession("research", "session-1", {
      archived: false,
    })
    expect(native.sessions.update).toHaveBeenNthCalledWith(3, "session-1", {
      time: {},
    })
    await adapter.updateSession("research", "session-1", {
      pinned: true,
    })
    // A pin write merges into native metadata instead of replacing it.
    expect(native.sessions.update).toHaveBeenNthCalledWith(4, "session-1", {
      metadata: { "native.label": "keep me", "aos.pinned": true },
    })
    await adapter.updateSession("research", "session-1", {
      pinned: false,
    })
    expect(native.sessions.update).toHaveBeenNthCalledWith(5, "session-1", {
      metadata: { "native.label": "keep me", "aos.pinned": false },
    })
    await adapter.deleteSession("research", "session-1")
    expect(native.sessions.delete).toHaveBeenCalledWith("session-1")
    await expect(
      adapter.getSession("research", "session-1")
    ).resolves.toMatchObject({ pinned: false })
    await expect(adapter.runtimeInfo()).resolves.toMatchObject({
      status: "ready",
      capabilities: {
        sessionTitle: { status: "available" },
        sessionArchival: { status: "available" },
        sessionPin: { status: "available" },
        sessionDeletion: { status: "available" },
      },
    })
  })

  it("keeps unsupported native lifecycle operations unavailable and maps safe provider errors", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    // The provider has no native read state to write.
    await expect(
      adapter.updateSession("research", "session-1", { unread: false })
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceUnavailableError" })
    expect(native.sessions.update).not.toHaveBeenCalled()
    await expect(
      adapter.artifact("research", "session-1", "artifact-1")
    ).rejects.toMatchObject({
      name: "OpenCodeWorkspaceScopeError",
    })
    expect(
      adapter.publicError(
        new Error("native secret must not cross the boundary")
      )
    ).toBeUndefined()
    await expect(adapter.runtimeInfo()).resolves.toMatchObject({
      status: "ready",
      capabilities: {
        agentVisibility: {
          status: "unavailable",
          reason: "native-agent-catalog-read-only",
        },
        sessionSteer: {
          status: "unavailable",
          reason: "native-steering-unproven",
        },
        sessionReadState: {
          status: "unavailable",
          reason: "native-session-read-state-unavailable",
        },
      },
    })
  })

  it("refuses every Agent update as unsupported and marks no Agent avatarEditable", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    const catalog = await adapter.listAgents()
    expect(catalog.agents.map((agent) => agent.avatarEditable)).toEqual([false])
    const revision = catalog.agents[0]!.revision
    for (const patch of [
      { avatar: "ring/blue" },
      { avatar: null },
      { visibility: "hidden" as const },
    ])
      await expect(
        adapter.updateAgent("research", patch, revision)
      ).rejects.toMatchObject({ name: "ServerAgentUpdateUnsupportedError" })
    expect(native.sessions.update).not.toHaveBeenCalled()
  })

  it("reports every Session lifecycle operation as temporarily unavailable when the catalog cannot be read", async () => {
    const native = client()
    native.catalog.agents = async () => {
      throw new Error("native catalog is unreachable")
    }
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await expect(adapter.runtimeInfo()).resolves.toMatchObject({
      status: "unavailable",
      capabilities: {
        sessionTitle: {
          status: "unavailable",
          reason: "temporarily-unavailable",
        },
        sessionArchival: {
          status: "unavailable",
          reason: "temporarily-unavailable",
        },
        sessionPin: {
          status: "unavailable",
          reason: "temporarily-unavailable",
        },
        sessionDeletion: {
          status: "unavailable",
          reason: "temporarily-unavailable",
        },
      },
    })
  })

  it("refuses attachment staging for a foreign Agent before accepting file data", async () => {
    const adapter = new OpenCodeServerAdapter({
      client: client(),
      turns: turnEngine,
    })

    await expect(
      adapter.stageAttachments("other-agent", "session-1", [
        { type: "file", dataUrl: "data:text/plain;base64,SGVsbG8=" },
      ])
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceScopeError" })
  })

  describe("artifact reads", () => {
    it("reports artifacts as available in the Session's capabilities", async () => {
      const adapter = new OpenCodeServerAdapter({
        client: client(),
        turns: turnEngine,
      })

      await expect(
        adapter.workspaceCapabilities("research", "session-1")
      ).resolves.toMatchObject({
        content: { artifacts: { status: "unavailable" } },
      })
    })
  })
})
