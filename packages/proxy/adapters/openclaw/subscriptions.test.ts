import { describe, expect, it, vi } from "vitest"

import {
  OpenClawSessionSubscriptions,
  type OpenClawSubscriptionRequestClient,
} from "./subscriptions"

function requestClient() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client: OpenClawSubscriptionRequestClient = {
    async request<T>(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      return (
        method === "sessions.messages.subscribe"
          ? {
              key: params.key,
              approvalReplay: {
                sessionKey: params.key,
                updatedAtMs: 1,
                approvals: [],
                truncated: false,
              },
            }
          : {}
      ) as T
    },
  }
  return { calls, client }
}

describe("OpenClaw Session subscriptions", () => {
  it("leases one official targeted observer to local consumers without coupling release to execution", async () => {
    const { calls, client } = requestClient()
    const subscriptions = new OpenClawSessionSubscriptions(client)

    const first = await subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      vi.fn()
    )
    const second = await subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      vi.fn()
    )

    expect(calls).toEqual([
      {
        method: "sessions.messages.subscribe",
        params: {
          key: "agent:research:main",
          agentId: "research",
          includeApprovals: true,
        },
      },
      {
        method: "sessions.messages.subscribe",
        params: {
          key: "agent:research:main",
          agentId: "research",
          includeApprovals: true,
        },
      },
    ])

    await first.release()
    expect(calls).toHaveLength(2)
    await second.release()
    expect(calls).toEqual([
      calls[0],
      calls[1],
      {
        method: "sessions.messages.unsubscribe",
        params: {
          key: "agent:research:main",
          agentId: "research",
        },
      },
    ])
  })

  it("routes only validated native events for the exact Agent and Session", async () => {
    const { client } = requestClient()
    const subscriptions = new OpenClawSessionSubscriptions(client)
    const research = vi.fn()
    const writing = vi.fn()
    await subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      research
    )
    await subscriptions.acquire(
      { agentId: "writing", sessionKey: "agent:writing:main" },
      writing
    )

    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 1,
        payload: {
          runId: "native-run",
          sessionKey: "agent:research:main",
          agentId: "research",
          seq: 1,
          state: "delta",
          deltaText: "hello",
        },
      },
      subscriptions.generation
    )
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 2,
        payload: {
          runId: "foreign-agent",
          sessionKey: "agent:research:main",
          agentId: "writing",
          seq: 1,
          state: "delta",
          deltaText: "secret",
        },
      },
      subscriptions.generation
    )
    subscriptions.accept(
      { type: "event", event: "chat", payload: { sessionKey: 7 } },
      subscriptions.generation
    )

    expect(research).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "chat",
        payload: expect.objectContaining({ deltaText: "hello" }),
      })
    )
    expect(writing).not.toHaveBeenCalled()
  })

  it("fences acquisition with exact scoped approval transitions before the replay acknowledgement", async () => {
    const acknowledgement = deferred<unknown>()
    const request = vi.fn(
      async (method: string, params: Record<string, unknown>) =>
        method === "sessions.messages.subscribe"
          ? acknowledgement.promise
          : { key: params.key }
    )
    const subscriptions = new OpenClawSessionSubscriptions({ request })
    const listener = vi.fn()
    const acquiring = subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      listener
    )
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())

    const approval = {
      id: "approval-acquisition",
      urlPath: "/approvals/approval-acquisition",
      createdAtMs: 1,
      expiresAtMs: 1_900_000_000_000,
      status: "pending",
      sourceSessionKey: "agent:research:main",
      presentation: {
        kind: "plugin",
        title: "External action",
        description: "Allow the plugin action",
        severity: "warning",
        agentId: "research",
        allowedDecisions: ["allow-once", "deny"],
      },
    }
    subscriptions.accept(
      {
        type: "event",
        event: "session.approval",
        seq: 3,
        payload: {
          sessionKey: "agent:research:main",
          sourceSessionKey: "agent:research:main",
          updatedAtMs: 2,
          phase: "pending",
          approval,
        },
      },
      subscriptions.generation
    )
    subscriptions.accept(
      {
        type: "event",
        event: "session.approval",
        seq: 4,
        payload: {
          sessionKey: "agent:research:main",
          sourceSessionKey: "agent:research:main",
          updatedAtMs: 3,
          phase: "pending",
          approval: {
            ...approval,
            presentation: { ...approval.presentation, agentId: "writing" },
          },
        },
      },
      subscriptions.generation
    )
    subscriptions.accept(
      {
        type: "event",
        event: "session.approval",
        seq: 5,
        payload: {
          sessionKey: "agent:research:main",
          updatedAtMs: 4,
          phase: "terminal",
          approval: {
            id: approval.id,
            urlPath: approval.urlPath,
            createdAtMs: approval.createdAtMs,
            expiresAtMs: approval.expiresAtMs,
            presentation: approval.presentation,
            status: "allowed",
            decision: "allow-once",
            reason: "user",
            resolvedAtMs: 4,
          },
        },
      },
      subscriptions.generation
    )

    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "session.approval",
        payload: expect.objectContaining({ updatedAtMs: 2 }),
      })
    )
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "session.approval",
        payload: expect.objectContaining({ updatedAtMs: 4 }),
      })
    )
    acknowledgement.resolve({
      key: "agent:research:main",
      approvalReplay: {
        sessionKey: "agent:research:main",
        updatedAtMs: 4,
        approvals: [],
        truncated: false,
      },
    })
    await acquiring
  })

  it("retires stale socket generations, resubscribes demand, and requests authoritative reconciliation", async () => {
    const { calls, client } = requestClient()
    const subscriptions = new OpenClawSessionSubscriptions(client)
    const listener = vi.fn()
    let releaseFirstReconcile = () => {}
    const firstReconcile = new Promise<void>((resolve) => {
      releaseFirstReconcile = resolve
    })
    const reconcile = vi.fn(async () => {
      if (reconcile.mock.calls.length === 1) await firstReconcile
    })
    await subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      listener,
      reconcile
    )
    const stale = subscriptions.generation

    const replacing = subscriptions.replaceGeneration("gap")
    expect(subscriptions.generation).toBe(stale + 1)
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce())

    const event = {
      type: "event" as const,
      event: "chat",
      seq: 5,
      payload: {
        runId: "native-run",
        sessionKey: "agent:research:main",
        agentId: "research",
        seq: 1,
        state: "delta",
        deltaText: "new",
      },
    }
    subscriptions.accept(event, stale)
    subscriptions.accept(event, subscriptions.generation)
    expect(listener).not.toHaveBeenCalled()

    releaseFirstReconcile()
    await replacing
    expect(calls.filter(({ method }) => method.endsWith("subscribe"))).toEqual([
      {
        method: "sessions.messages.subscribe",
        params: {
          key: "agent:research:main",
          agentId: "research",
          includeApprovals: true,
        },
      },
      {
        method: "sessions.messages.subscribe",
        params: {
          key: "agent:research:main",
          agentId: "research",
          includeApprovals: true,
        },
      },
    ])
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(reconcile.mock.calls[0]?.[0]).toBe("gap")
    expect(reconcile.mock.calls[1]?.[0]).toBe("gap")

    subscriptions.accept(
      {
        ...event,
        seq: 6,
        payload: { ...event.payload, seq: 2, deltaText: "fresh" },
      },
      subscriptions.generation
    )
    expect(listener).toHaveBeenCalledOnce()
  })

  it("repeats global reconciliation when an earlier Session dirties during a later lease read", async () => {
    const { client } = requestClient()
    const subscriptions = new OpenClawSessionSubscriptions(client)
    const releaseWriting = deferred<void>()
    const research = vi.fn(async () => {})
    const writing = vi.fn(async () => {
      if (writing.mock.calls.length === 1) await releaseWriting.promise
    })
    await subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      vi.fn(),
      research
    )
    await subscriptions.acquire(
      { agentId: "writing", sessionKey: "agent:writing:main" },
      vi.fn(),
      writing
    )

    const replacing = subscriptions.replaceGeneration("reconnect")
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce())
    subscriptions.accept(
      {
        type: "event",
        event: "chat",
        seq: 7,
        payload: {
          runId: "research-run",
          sessionKey: "agent:research:main",
          agentId: "research",
          seq: 0,
          state: "final",
        },
      },
      subscriptions.generation
    )
    releaseWriting.resolve(undefined)
    await replacing

    expect(research).toHaveBeenCalledTimes(2)
  })

  it("exposes only a validated approval replay from the current socket generation", async () => {
    const replay = {
      sessionKey: "agent:research:main",
      updatedAtMs: 1,
      approvals: [],
      truncated: true,
    }
    const client: OpenClawSubscriptionRequestClient = {
      request: vi.fn(async (method, params) =>
        method === "sessions.messages.subscribe"
          ? { key: params.key, approvalReplay: replay }
          : {}
      ),
    }
    const subscriptions = new OpenClawSessionSubscriptions(client)
    const lease = await subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      vi.fn()
    )

    expect(lease.approvalReplay()).toEqual({
      generation: subscriptions.generation,
      replay,
    })

    const replacing = subscriptions.replaceGeneration("reconnect")
    expect(lease.approvalReplay()).toBeUndefined()
    await replacing
    expect(lease.approvalReplay()).toEqual({
      generation: subscriptions.generation,
      replay,
    })

    const invalid = new OpenClawSessionSubscriptions({
      request: vi.fn(async () => ({
        key: "agent:research:main",
        approvalReplay: { ...replay, sessionKey: "agent:foreign:main" },
      })),
    })
    await expect(
      invalid.acquire(
        { agentId: "research", sessionKey: "agent:research:main" },
        vi.fn()
      )
    ).rejects.toThrow("approval replay")
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
