import { describe, expect, it, vi } from "vitest"

import { createReconnectCursorCodec } from "./cursor"
import { createEventsSocket, type EventSocketServerFrame } from "./socket"

const NOW = 1_700_000_000_000
const scope = {
  workspaceId: "workspace-1",
  agentId: "researcher",
  sessionId: "session-7",
}

function canonicalScope(value: typeof scope) {
  return `ws1.${Buffer.from(value.workspaceId).toString("base64url")}.${Buffer.from(value.agentId).toString("base64url")}.${Buffer.from(value.sessionId).toString("base64url")}`
}

function subscribe(
  overrides: Partial<{
    streamId: string
    scope: typeof scope
    cursor: string
  }> = {}
) {
  return JSON.stringify({
    type: "aos.subscribe",
    streamId: overrides.streamId ?? "stream-11",
    scope: overrides.scope ?? scope,
    ...(overrides.cursor === undefined ? {} : { cursor: overrides.cursor }),
  })
}

function harness(
  overrides: Partial<Parameters<typeof createEventsSocket>[0]> = {}
) {
  const closed: Array<{ code: number; reason: string }> = []
  const order: string[] = []
  const stop = vi.fn()
  let invalidate: (() => void) | undefined
  let reset: (() => void) | undefined
  const cursor = createReconnectCursorCodec({
    activeKeyId: "key-1",
    keys: { "key-1": Buffer.alloc(32, 7) },
    now: () => NOW / 1_000,
  })
  const socket = createEventsSocket({
    authorize: async ({ scope: requestedScope, streamId }) => {
      order.push("authorize")
      return {
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
        expiresAt: NOW + 60_000,
      }
    },
    observe: async (request) => {
      order.push("observe")
      invalidate = request.invalidate
      reset = request.reset
      return { stop }
    },
    cursor,
    close: (code, reason) => closed.push({ code, reason }),
    now: () => NOW,
    schedule: () => ({ timer: true }),
    cancel() {},
    ...overrides,
  })
  const frames = () =>
    socket.drain().map((raw) => JSON.parse(raw) as EventSocketServerFrame)

  return {
    socket,
    cursor,
    closed,
    order,
    stop,
    frames,
    invalidate: () => invalidate?.(),
    reset: () => reset?.(),
  }
}

describe("normalized AOS events WebSocket core", () => {
  it("authorizes and observes an exact scope before inviting an authoritative read", async () => {
    const state = harness()

    await state.socket.receive(subscribe())

    expect(state.order).toEqual(["authorize", "observe"])
    const [ready] = state.frames()
    expect(ready).toMatchObject({
      type: "aos.ready",
      version: 1,
      streamId: "stream-11",
      scope,
      generation: 0,
      read: "authoritative",
    })
    if (ready?.type !== "aos.ready") throw new Error("Expected ready frame")
    expect(ready.cursor).toEqual(expect.any(String))
  })

  it("resumes a cursor in the same epoch but still requires a fresh read", async () => {
    const state = harness()
    const binding = {
      deploymentId: "deployment-a",
      lane: "operator" as const,
      principalId: "operator-42",
      authorizationRevision: "grant-9",
      scope: canonicalScope(scope),
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      bootEpoch: "boot-3",
      streamId: "stream-11",
    }
    const cursor = state.cursor.seal({
      ...binding,
      iat: NOW / 1_000,
      exp: NOW / 1_000 + 30,
    })

    await state.socket.receive(subscribe({ cursor }))

    expect(state.frames()).toEqual([
      expect.objectContaining({
        type: "aos.ready",
        generation: 0,
        read: "authoritative",
      }),
    ])
  })

  it("reconciles an expired or differently bound cursor without exposing why", async () => {
    const state = harness()
    const wrongScopeCursor = state.cursor.seal({
      deploymentId: "deployment-a",
      lane: "operator",
      principalId: "operator-42",
      authorizationRevision: "grant-9",
      scope: canonicalScope({ ...scope, sessionId: "other-session" }),
      agentId: scope.agentId,
      sessionId: "other-session",
      bootEpoch: "boot-3",
      streamId: "stream-11",
      iat: NOW / 1_000,
      exp: NOW / 1_000 + 30,
    })

    await state.socket.receive(subscribe({ cursor: wrongScopeCursor }))

    expect(state.frames()).toEqual([
      expect.objectContaining({
        type: "aos.ready",
        generation: 0,
        read: "authoritative",
      }),
      {
        type: "aos.reset",
        version: 1,
        streamId: "stream-11",
        scope,
        generation: 1,
        reason: "reconcile_required",
      },
    ])
    expect(state.order).toEqual(["authorize", "observe"])
  })

  it.each([
    ["deployment", { deploymentId: "deployment-b" }],
    ["principal", { principalId: "operator-99" }],
    [
      "scope",
      { scope: canonicalScope({ ...scope, workspaceId: "workspace-other" }) },
    ],
    ["epoch", { bootEpoch: "boot-previous" }],
  ])("reconciles a cursor bound to the wrong %s", async (_label, changed) => {
    const state = harness()
    const cursor = state.cursor.seal({
      deploymentId: "deployment-a",
      lane: "operator",
      principalId: "operator-42",
      authorizationRevision: "grant-9",
      scope: canonicalScope(scope),
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      bootEpoch: "boot-3",
      streamId: "stream-11",
      iat: NOW / 1_000,
      exp: NOW / 1_000 + 30,
      ...changed,
    })

    await state.socket.receive(subscribe({ cursor }))

    expect(state.frames().map((item) => item.type)).toEqual([
      "aos.ready",
      "aos.reset",
    ])
  })

  it("reconciles expired and wrong-lane cursors", async () => {
    const expired = harness()
    const expiredCursor = expired.cursor.seal({
      deploymentId: "deployment-a",
      lane: "operator",
      principalId: "operator-42",
      authorizationRevision: "grant-9",
      scope: canonicalScope(scope),
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      bootEpoch: "boot-3",
      streamId: "stream-11",
      iat: NOW / 1_000 - 31,
      exp: NOW / 1_000 - 1,
    })
    await expired.socket.receive(subscribe({ cursor: expiredCursor }))

    const wrongLane = harness()
    const guestCursor = wrongLane.cursor.seal({
      deploymentId: "deployment-a",
      lane: "guest",
      invitationId: "invite-3",
      authorizationRevision: "grant-9",
      scope: canonicalScope(scope),
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      bootEpoch: "boot-3",
      streamId: "stream-11",
      iat: NOW / 1_000,
      exp: NOW / 1_000 + 30,
    })
    await wrongLane.socket.receive(subscribe({ cursor: guestCursor }))

    expect(expired.frames().map((item) => item.type)).toEqual([
      "aos.ready",
      "aos.reset",
    ])
    expect(wrongLane.frames().map((item) => item.type)).toEqual([
      "aos.ready",
      "aos.reset",
    ])
  })

  it("reports an invalidation that overlaps observer setup after ready", async () => {
    const state = harness({
      observe: async ({ invalidate }) => {
        state.order.push("observe")
        invalidate()
        return { stop: state.stop }
      },
    })

    await state.socket.receive(subscribe())

    expect(state.frames()).toEqual([
      expect.objectContaining({ type: "aos.ready", generation: 0 }),
      {
        type: "aos.invalidate",
        version: 1,
        streamId: "stream-11",
        scope,
        generation: 1,
      },
    ])
  })

  it("never observes a scope rejected by the external authorization hook", async () => {
    const observe = vi.fn()
    const state = harness({ authorize: async () => null, observe })

    await state.socket.receive(subscribe())

    expect(observe).not.toHaveBeenCalled()
    expect(state.frames()).toEqual([
      {
        type: "aos.error",
        version: 1,
        streamId: "stream-11",
        code: "unauthorized",
      },
    ])
  })

  it("emits only scoped namespaced invalidations without native payloads or positions", async () => {
    const state = harness()
    await state.socket.receive(subscribe())
    state.frames()

    state.invalidate()
    state.reset()

    expect(state.frames()).toEqual([
      {
        type: "aos.invalidate",
        version: 1,
        streamId: "stream-11",
        scope,
        generation: 1,
      },
      {
        type: "aos.reset",
        version: 1,
        streamId: "stream-11",
        scope,
        generation: 2,
        reason: "reconcile_required",
      },
    ])
  })

  it("closes on malformed, oversized, or rate-excess input", async () => {
    const malformed = harness()
    await malformed.socket.receive("{bad-json")
    expect(malformed.closed).toEqual([
      { code: 1008, reason: "Invalid event frame" },
    ])

    const oversized = harness()
    await oversized.socket.receive(JSON.stringify("x".repeat(16_385)))
    expect(oversized.closed).toEqual([
      { code: 1009, reason: "Event frame too large" },
    ])

    const rateLimited = harness({ maxInputFramesPerWindow: 1 })
    await rateLimited.socket.receive(subscribe())
    await rateLimited.socket.receive(
      JSON.stringify({ type: "aos.unsubscribe", streamId: "stream-11" })
    )
    expect(rateLimited.closed).toEqual([
      { code: 1008, reason: "Event rate exceeded" },
    ])
    expect(rateLimited.stop).toHaveBeenCalledOnce()

    const byteLimited = harness({ maxInputBytesPerWindow: 1 })
    await byteLimited.socket.receive(subscribe())
    expect(byteLimited.closed).toEqual([
      { code: 1008, reason: "Event rate exceeded" },
    ])
  })

  it("closes duplicate subscriptions and releases every observer once", async () => {
    const state = harness()
    await state.socket.receive(subscribe())
    await state.socket.receive(subscribe())

    expect(state.closed).toEqual([
      { code: 1008, reason: "Invalid event stream" },
    ])
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it("closes and cleans up deterministically when output backpressure exceeds its bounds", async () => {
    const state = harness({ maxOutputFrames: 1 })

    await state.socket.receive(subscribe())
    state.invalidate()

    expect(state.closed).toEqual([
      { code: 1013, reason: "Event output overloaded" },
    ])
    expect(state.socket.drain()).toEqual([])
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it("bounds output by encoded bytes as well as queued frame count", async () => {
    const state = harness({ maxOutputBytes: 1 })

    await state.socket.receive(subscribe())

    expect(state.closed).toEqual([
      { code: 1013, reason: "Event output overloaded" },
    ])
    expect(state.socket.drain()).toEqual([])
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it("cleans up on peer close and ignores later native callbacks", async () => {
    const state = harness()
    await state.socket.receive(subscribe())
    state.frames()

    state.socket.close()
    state.invalidate()

    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.frames()).toEqual([])
    expect(state.closed).toEqual([])
  })
})
