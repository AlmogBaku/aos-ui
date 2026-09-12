import { describe, expect, it, vi } from "vitest"

import {
  createInvalidationConnection,
  type ClientEventFrame,
  type EventScope,
  type ServerEventFrame,
} from "./invalidation"

const scope: EventScope = {
  workspaceId: "workspace-1",
  agentId: "researcher",
  sessionId: "session-7",
}

function canonicalScope(value: EventScope) {
  return `ws1.${Buffer.from(value.workspaceId).toString("base64url")}.${Buffer.from(value.agentId).toString("base64url")}.${Buffer.from(value.sessionId).toString("base64url")}`
}

function frame(value: ClientEventFrame) {
  return JSON.stringify(value)
}

function harness(
  overrides: Partial<Parameters<typeof createInvalidationConnection>[0]> = {}
) {
  const sent: ServerEventFrame[] = []
  const closed: Array<{ code: number; reason: string }> = []
  const observerStops: Array<ReturnType<typeof vi.fn>> = []
  const scheduled: Array<{ delay: number; task: () => void; active: boolean }> =
    []
  let now = 10_000
  let invalidate: (() => void) | undefined
  let reset: (() => void) | undefined

  const connection = createInvalidationConnection({
    authorize: async ({ scope: requestedScope, streamId }) => ({
      binding: {
        deploymentId: "deployment-a",
        lane: "operator",
        principalId: "operator-42",
        authorizationRevision: "grant-9",
        scope: canonicalScope(requestedScope),
        agentId: requestedScope.agentId,
        sessionId: requestedScope.sessionId,
        bootEpoch: "boot-3",
        streamId,
      },
      expiresAt: now + 60_000,
    }),
    observe: async (request) => {
      invalidate = request.invalidate
      reset = request.reset
      const stop = vi.fn()
      observerStops.push(stop)
      return { stop }
    },
    cursor: {
      open: () => true,
      seal: () => "sealed-cursor",
    },
    send: (event) => sent.push(event),
    close: (code, reason) => closed.push({ code, reason }),
    now: () => now,
    schedule: (delay, task) => {
      const timer = { delay, task, active: true }
      scheduled.push(timer)
      return timer
    },
    cancel: (timer) => {
      timer.active = false
    },
    ...overrides,
  })

  return {
    connection,
    sent,
    closed,
    observerStops,
    scheduled,
    invalidate: () => invalidate?.(),
    reset: () => reset?.(),
    advanceTo(value: number) {
      now = value
    },
  }
}

describe("events invalidation connection", () => {
  it("establishes native observation before ready and wakes an authoritative reader for an overlapping invalidation", async () => {
    const sent: ServerEventFrame[] = []
    const connection = createInvalidationConnection({
      authorize: async ({ scope: requestedScope, streamId }) => ({
        binding: {
          deploymentId: "deployment-a",
          lane: "operator",
          principalId: "operator-42",
          authorizationRevision: "grant-9",
          scope: canonicalScope(requestedScope),
          agentId: requestedScope.agentId,
          sessionId: requestedScope.sessionId,
          bootEpoch: "boot-3",
          streamId,
        },
        expiresAt: Date.now() + 60_000,
      }),
      observe: async ({ invalidate }) => {
        invalidate()
        return { stop() {} }
      },
      cursor: { open: () => true, seal: () => "sealed-cursor" },
      send: (event) => sent.push(event),
      close() {},
    })

    await connection.receive(
      frame({ type: "subscribe", streamId: "stream-11", scope })
    )

    expect(sent).toEqual([
      {
        type: "ready",
        streamId: "stream-11",
        scope,
        read: "authoritative",
        cursor: "sealed-cursor",
      },
      { type: "invalidate", streamId: "stream-11", generation: 1 },
    ])
  })

  it("does not use a reconnect cursor to skip the next authoritative read", async () => {
    const state = harness()

    await state.connection.receive(
      frame({
        type: "subscribe",
        streamId: "stream-11",
        scope,
        cursor: "sealed-cursor",
      })
    )

    expect(state.sent).toEqual([
      {
        type: "ready",
        streamId: "stream-11",
        scope,
        read: "authoritative",
        cursor: "sealed-cursor",
      },
    ])
  })

  it("rejects an invalid cursor without exposing an observer", async () => {
    const state = harness({
      cursor: { open: () => false, seal: () => "sealed-cursor" },
    })

    await state.connection.receive(
      frame({
        type: "subscribe",
        streamId: "stream-11",
        scope,
        cursor: "not-a-real-cursor",
      })
    )

    expect(state.sent).toEqual([
      { type: "error", streamId: "stream-11", code: "invalid_cursor" },
    ])
    expect(state.observerStops).toHaveLength(0)
  })

  it("does not expose native event payloads in invalidation or reset frames", async () => {
    const state = harness()
    await state.connection.receive(
      frame({ type: "subscribe", streamId: "stream-11", scope })
    )

    state.invalidate()
    state.reset()

    expect(state.sent.slice(1)).toEqual([
      { type: "invalidate", streamId: "stream-11", generation: 1 },
      { type: "reset", streamId: "stream-11", generation: 2 },
    ])
  })

  it("closes the connection when a stream identifier is reused for another scope", async () => {
    const state = harness()
    await state.connection.receive(
      frame({ type: "subscribe", streamId: "stream-11", scope })
    )
    await state.connection.receive(
      frame({
        type: "subscribe",
        streamId: "stream-11",
        scope: { ...scope, sessionId: "session-8" },
      })
    )

    expect(state.closed).toEqual([
      { code: 1008, reason: "Invalid event stream" },
    ])
    expect(state.observerStops[0]).toHaveBeenCalledOnce()
  })

  it("stops an observation on unsubscribe and ignores its later wake", async () => {
    const state = harness()
    await state.connection.receive(
      frame({ type: "subscribe", streamId: "stream-11", scope })
    )
    await state.connection.receive(
      frame({ type: "unsubscribe", streamId: "stream-11" })
    )
    state.invalidate()

    expect(state.observerStops[0]).toHaveBeenCalledOnce()
    expect(state.sent).toHaveLength(1)
  })

  it("closes instead of retaining a native observation beyond authorization expiry", async () => {
    const state = harness()
    await state.connection.receive(
      frame({ type: "subscribe", streamId: "stream-11", scope })
    )

    const expiry = state.scheduled[0]
    expect(expiry.delay).toBe(60_000)
    state.advanceTo(70_000)
    expiry.task()

    expect(state.sent.slice(1)).toEqual([
      { type: "error", streamId: "stream-11", code: "authorization_expired" },
    ])
    expect(state.closed).toEqual([
      { code: 4401, reason: "Authorization expired" },
    ])
    expect(state.observerStops[0]).toHaveBeenCalledOnce()
  })

  it("closes on malformed or oversized frames before authorizing a scope", async () => {
    const state = harness()
    await state.connection.receive("{not-json")

    expect(state.closed).toEqual([
      { code: 1008, reason: "Invalid event frame" },
    ])

    const oversized = harness()
    await oversized.connection.receive("x".repeat(16_385))
    expect(oversized.closed).toEqual([
      { code: 1009, reason: "Event frame too large" },
    ])
  })

  it("closes instead of throwing when a binary frame is not valid UTF-8 JSON", async () => {
    const state = harness()

    await state.connection.receive(new Uint8Array([0xff, 0xfe, 0xfd]))

    expect(state.closed).toEqual([
      { code: 1008, reason: "Invalid event frame" },
    ])
  })
})
