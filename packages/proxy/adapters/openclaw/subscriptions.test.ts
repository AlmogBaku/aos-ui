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
        method === "sessions.messages.subscribe" ? { key: params.key } : {}
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
        params: { key: "agent:research:main", agentId: "research" },
      },
    ])

    await first.release()
    expect(calls).toHaveLength(1)
    await second.release()
    expect(calls).toEqual([
      calls[0],
      {
        method: "sessions.messages.unsubscribe",
        params: { key: "agent:research:main", agentId: "research" },
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

  it("retires stale socket generations, resubscribes demand, and requests authoritative reconciliation", async () => {
    const { calls, client } = requestClient()
    const subscriptions = new OpenClawSessionSubscriptions(client)
    const listener = vi.fn()
    const reconcile = vi.fn()
    await subscriptions.acquire(
      { agentId: "research", sessionKey: "agent:research:main" },
      listener,
      reconcile
    )
    const stale = subscriptions.generation

    await subscriptions.replaceGeneration("gap")
    expect(calls.filter(({ method }) => method.endsWith("subscribe"))).toEqual([
      {
        method: "sessions.messages.subscribe",
        params: { key: "agent:research:main", agentId: "research" },
      },
      {
        method: "sessions.messages.subscribe",
        params: { key: "agent:research:main", agentId: "research" },
      },
    ])
    expect(reconcile).toHaveBeenCalledExactlyOnceWith("gap")

    const event = {
      type: "event" as const,
      event: "chat",
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
    expect(listener).toHaveBeenCalledOnce()
  })
})
