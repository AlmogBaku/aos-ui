import { describe, expect, it, vi } from "vitest"

import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import type { ServerTurnEngine } from "../../core/runtime"
import { OpenCodeServerAdapter, type OpenCodeAdapterClient } from "./adapter"
import { OpenCodeClientError } from "./client"
import { openCodeArtifactReceipt } from "./content"

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
    expect(native.sessions.switchModel).toHaveBeenCalledTimes(1)
    await expect(
      adapter.context("research", "session-1")
    ).rejects.toMatchObject({
      name: "OpenCodeWorkspaceUnavailableError",
    })
  })

  it("uses ascending native message pages for exact-Agent authoritative history", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await expect(
      adapter.history("research", "session-1", 1, 1)
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
      offset: 1,
      nextOffset: 2,
    })
    expect(native.sessions.messages).toHaveBeenNthCalledWith(1, "session-1", {
      limit: 100,
      order: "asc",
    })
    expect(native.sessions.messages).toHaveBeenNthCalledWith(2, "session-1", {
      limit: 100,
      cursor: "second",
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

      const history = await adapter.history("research", "session-1", 1, 1)

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

  it("returns OpenCode capabilities accepted by the canonical workspace schema", async () => {
    const adapter = new OpenCodeServerAdapter({
      client: client(),
      turns: turnEngine,
    })

    const value = await adapter.workspaceCapabilities("research", "session-1")
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.safeParse(value).success
    ).toBe(true)
  })

  it("observes validated exact-Session invalidations and releases the SSE lease once", async () => {
    const native = client()
    let releaseStream!: () => void
    const abort = vi.fn(() => releaseStream())
    native.sessions.events = vi.fn(async () => ({
      abort,
      async *[Symbol.asyncIterator]() {
        yield {
          event: "session",
          id: "0",
          data: {
            id: "event-1",
            type: "session.next.prompt.admitted",
            durable: { aggregateID: "session-1", seq: 0, version: 1 },
            data: {
              sessionID: "session-1",
              timestamp: 1,
              messageID: "prompt-1",
              prompt: { text: "Hello" },
              delivery: "queue",
            },
          },
        }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
        })
      },
    }))
    const listener = vi.fn()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    const unsubscribe = await adapter.subscribeSessionInvalidation(
      "research",
      "session-1",
      listener
    )
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
    unsubscribe()
    unsubscribe()
    expect(abort).toHaveBeenCalledOnce()
  })

  it("resets an invalidation observer on a durable SSE sequence gap", async () => {
    const native = client()
    native.sessions.events = vi.fn(async () => ({
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (const seq of [0, 2]) {
          yield {
            event: "session",
            id: String(seq),
            data: {
              id: `event-${seq}`,
              type: "session.next.prompt.admitted",
              durable: { aggregateID: "session-1", seq, version: 1 },
              data: {
                sessionID: "session-1",
                timestamp: seq + 1,
                messageID: `prompt-${seq}`,
                prompt: { text: "Hello" },
                delivery: "queue",
              },
            },
          }
        }
      },
    }))
    const reset = vi.fn()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await adapter.subscribeSessionInvalidation(
      "research",
      "session-1",
      vi.fn(),
      reset
    )
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
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

  it("closes the provider facade only once", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      turns: turnEngine,
    })

    await Promise.all([adapter.close(), adapter.close()])
    expect(native.close).toHaveBeenCalledTimes(1)
  })

  describe("artifact reads", () => {
    const receipt = (path: string, filename: string, mimeType?: string) =>
      JSON.stringify({
        ok: true,
        type: "aos.artifact",
        artifact: { path, filename, ...(mimeType ? { mimeType } : {}) },
      })
    const artifactMessage = (callId: string, text: string) => ({
      id: `assistant-${callId}`,
      type: "assistant" as const,
      agent: "research",
      model: { providerID: "openai", id: "gpt-5" },
      time: { created: 3_000 },
      content: [
        {
          id: callId,
          type: "tool" as const,
          name: "aos-ui_present_artifact",
          time: { created: 3_000 },
          state: {
            status: "completed" as const,
            input: {},
            content: [{ type: "text", text }],
            structured: {},
          },
        },
      ],
    })

    function artifactClient(
      read: (path: string) => Promise<unknown>,
      messages: unknown[] = [
        artifactMessage(
          "call-pdf",
          receipt(
            "/workspaces/aos/out/report.pdf",
            "report.pdf",
            "application/pdf"
          )
        ),
        artifactMessage(
          "call-notes",
          receipt("/workspaces/aos/out/notes.md", "notes.md", "text/markdown")
        ),
      ]
    ) {
      const native = client()
      return {
        ...native,
        sessions: {
          ...native.sessions,
          messages: vi.fn(async () => ({ data: messages, cursor: {} })),
        },
        files: { read: vi.fn(read) },
      }
    }

    function idOf(callId: string, text: string) {
      return openCodeArtifactReceipt(callId, text)!.descriptor.id
    }

    it("decodes a base64 binary file and a text file named by the Session's receipts", async () => {
      const native = artifactClient(async (path) =>
        path.endsWith(".pdf")
          ? {
              type: "binary",
              content: Buffer.from([1, 2, 3]).toString("base64"),
              encoding: "base64",
              mimeType: "application/octet-stream",
            }
          : { type: "text", content: "# Notes" }
      )
      const adapter = new OpenCodeServerAdapter({
        client: native,
        turns: turnEngine,
      })

      await expect(
        adapter.artifact(
          "research",
          "session-1",
          idOf(
            "call-pdf",
            receipt(
              "/workspaces/aos/out/report.pdf",
              "report.pdf",
              "application/pdf"
            )
          )
        )
      ).resolves.toEqual({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
        filename: "report.pdf",
      })
      await expect(
        adapter.artifact(
          "research",
          "session-1",
          idOf(
            "call-notes",
            receipt("/workspaces/aos/out/notes.md", "notes.md", "text/markdown")
          )
        )
      ).resolves.toEqual({
        bytes: new TextEncoder().encode("# Notes"),
        mimeType: "text/markdown",
        filename: "notes.md",
      })
      expect(native.files.read).toHaveBeenCalledWith(
        "/workspaces/aos/out/report.pdf"
      )
    })

    it("reports a missing or denied file as unreadable", async () => {
      const id = idOf(
        "call-pdf",
        receipt(
          "/workspaces/aos/out/report.pdf",
          "report.pdf",
          "application/pdf"
        )
      )
      const missing = new OpenCodeServerAdapter({
        client: artifactClient(async () => ({ type: "text", content: "" })),
        turns: turnEngine,
      })
      const denied = new OpenCodeServerAdapter({
        client: artifactClient(async () => {
          throw new OpenCodeClientError("not_found")
        }),
        turns: turnEngine,
      })

      for (const adapter of [missing, denied]) {
        const failure = adapter.artifact("research", "session-1", id)
        await expect(failure).rejects.toMatchObject({
          name: "OpenCodeContentUnreadableError",
        })
        expect(
          adapter.publicError(await failure.catch((error) => error))
        ).toEqual({ code: "not_found", status: 404 })
      }
    })

    it("does not resolve an artifact id another Session published", async () => {
      const native = artifactClient(async () => ({
        type: "text",
        content: "never read",
      }))
      const adapter = new OpenCodeServerAdapter({
        client: native,
        turns: turnEngine,
      })

      await expect(
        adapter.artifact(
          "research",
          "session-1",
          idOf(
            "call-elsewhere",
            receipt("/workspaces/aos/out/other.pdf", "other.pdf")
          )
        )
      ).rejects.toMatchObject({ name: "OpenCodeWorkspaceScopeError" })
      expect(native.files.read).not.toHaveBeenCalled()
    })

    it("reports artifacts as available in the Session's capabilities", async () => {
      const adapter = new OpenCodeServerAdapter({
        client: client(),
        turns: turnEngine,
      })

      await expect(
        adapter.workspaceCapabilities("research", "session-1")
      ).resolves.toMatchObject({
        content: { artifacts: { status: "available", scope: "session" } },
      })
    })
  })
})
