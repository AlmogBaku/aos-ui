import { describe, expect, it, vi } from "vitest"

import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import type { ServerRunEngine } from "../../core/runtime"
import { OpenCodeServerAdapter, type OpenCodeAdapterClient } from "./adapter"

const runEngine: ServerRunEngine = {
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
      questions: { reply: async () => {}, reject: async () => {} },
      permissions: { reply: async () => {} },
    },
    close: vi.fn(async () => {}),
  }
}

describe("OpenCode server adapter", () => {
  it("projects native enabled models and switches only an exact owned Session model", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      runs: runEngine,
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
      runs: runEngine,
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
  })

  it("keeps unsupported native lifecycle operations unavailable and maps safe provider errors", async () => {
    const native = client()
    const adapter = new OpenCodeServerAdapter({
      client: native,
      runs: runEngine,
    })

    await expect(
      adapter.mutateSession("research", "session-1", "DELETE")
    ).rejects.toMatchObject({
      name: "OpenCodeWorkspaceUnavailableError",
    })
    await expect(
      adapter.mutateSession("research", "session-1", "PATCH", { unread: false })
    ).rejects.toMatchObject({
      name: "OpenCodeWorkspaceUnavailableError",
    })
    await expect(
      adapter.artifact("research", "session-1", "artifact-1")
    ).rejects.toMatchObject({
      name: "OpenCodeContentUnavailableError",
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
        sessionTitle: {
          status: "unavailable",
          reason: "native-session-title-unavailable",
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

  it("returns OpenCode capabilities accepted by the canonical workspace schema", async () => {
    const adapter = new OpenCodeServerAdapter({
      client: client(),
      runs: runEngine,
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
      runs: runEngine,
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
      runs: runEngine,
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
      runs: runEngine,
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
      runs: runEngine,
    })

    await Promise.all([adapter.close(), adapter.close()])
    expect(native.close).toHaveBeenCalledTimes(1)
  })
})
