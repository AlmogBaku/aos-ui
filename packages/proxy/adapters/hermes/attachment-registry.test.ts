import { describe, expect, it, vi } from "vitest"

import {
  HermesAttachmentRegistry,
  type AttachmentSignal,
} from "./attachment-registry"
import {
  HermesRpcRejectedError,
  HermesUnavailableError,
  type HermesConnectionHandler,
} from "./gateway"
import { nativeTurn } from "./test-utils/native-events"

const scope = { agentId: "research", sessionId: "stored", threadId: "thread" }

/**
 * The registry only needs the gateway's observation hooks. This fake records
 * how many subscriptions it holds so a test can prove the registry subscribes
 * exactly once, and lets a test drive the connection lifecycle directly.
 */
function fakeGateway() {
  const listeners = new Set<(event: unknown) => void>()
  const handlers = new Set<HermesConnectionHandler>()
  return {
    transport: {
      onEvent(listener: (event: unknown) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onConnection(handler: HermesConnectionHandler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    },
    get eventSubscriptions() {
      return listeners.size
    },
    get connectionSubscriptions() {
      return handlers.size
    },
    publish(event: unknown) {
      for (const listener of [...listeners]) listener(event)
    },
    async restored() {
      for (const handler of [...handlers]) await handler.restored?.()
    },
    lost() {
      for (const handler of [...handlers]) handler.lost?.()
    },
    epochChanged() {
      for (const handler of [...handlers]) handler.epochChanged?.()
    },
  }
}

describe("HermesAttachmentRegistry", () => {
  it("single-flights session resume and routes events by live Session", async () => {
    const gateway = fakeGateway()
    const resume = vi.fn(async (value: typeof scope) => ({
      liveSessionId: `live-${value.sessionId}`,
    }))
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    const second = { ...scope, sessionId: "other" }
    const [firstAttachment] = await Promise.all([
      registry.ensure(scope),
      registry.ensure(scope),
    ])
    await registry.ensure(second)
    const first = vi.fn()
    const other = vi.fn()
    const stopFirst = await registry.subscribe(scope, first)
    const stopOther = await registry.subscribe(second, other)

    const event = {
      session_id: firstAttachment.liveSessionId,
      type: "message.delta",
    }
    gateway.publish(event)
    gateway.publish({ session_id: "live-other", type: "message.delta" })

    expect(resume).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith({ kind: "event", event })
    expect(other).toHaveBeenCalledTimes(1)
    stopFirst()
    stopOther()
  })

  it("holds one native event subscription and delivers each frame once per observer across two heals", async () => {
    const gateway = fakeGateway()
    const registry = new HermesAttachmentRegistry(
      {
        resume: async () => ({ liveSessionId: "live-stored" }),
        close: async () => undefined,
      },
      gateway.transport
    )
    const observer = vi.fn()
    const stop = await registry.subscribe(scope, observer)
    const turn = nativeTurn("live-stored")

    await gateway.restored()
    await gateway.restored()
    gateway.publish(turn.delta("one"))
    gateway.publish(turn.delta("two"))

    expect(gateway.eventSubscriptions).toBe(1)
    expect(gateway.connectionSubscriptions).toBe(1)
    expect(
      observer.mock.calls.filter(
        ([signal]: [AttachmentSignal]) => signal.kind === "event"
      )
    ).toHaveLength(2)
    stop()
    await registry.close()
    expect(gateway.eventSubscriptions).toBe(0)
    expect(gateway.connectionSubscriptions).toBe(0)
  })

  it("signals only a reattachment when a heal returns the same live Session", async () => {
    const gateway = fakeGateway()
    const resume = vi.fn(async () => ({ liveSessionId: "live-stored" }))
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    const observer = vi.fn()
    await registry.subscribe(scope, observer)
    observer.mockClear()

    await gateway.restored()

    expect(resume).toHaveBeenCalledTimes(2)
    expect(observer.mock.calls).toEqual([[{ kind: "reattached" }]])
  })

  it("remaps the routing table and signals a rebound loss when a heal returns a new live Session", async () => {
    const gateway = fakeGateway()
    const ids = ["live-first", "live-second"]
    const resume = vi.fn(async () => ({ liveSessionId: ids.shift()! }))
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    const observer = vi.fn()
    await registry.subscribe(scope, observer)
    observer.mockClear()

    await gateway.restored()
    expect(observer.mock.calls).toEqual([[{ kind: "lost", reason: "rebound" }]])

    observer.mockClear()
    gateway.publish({ session_id: "live-first", type: "message.delta" })
    const event = { session_id: "live-second", type: "message.delta" }
    gateway.publish(event)

    expect(observer.mock.calls).toEqual([[{ kind: "event", event }]])
    await expect(
      registry.subscribeLive("live-first", vi.fn())
    ).rejects.toThrow()
  })

  it("invalidates a stale binding and re-resumes when a heal is rejected as gone", async () => {
    const gateway = fakeGateway()
    const resume = vi
      .fn<() => Promise<{ liveSessionId: string }>>()
      .mockResolvedValueOnce({ liveSessionId: "live-first" })
      .mockRejectedValueOnce(new HermesRpcRejectedError(4001))
      .mockResolvedValueOnce({ liveSessionId: "live-second" })
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    const observer = vi.fn()
    await registry.subscribe(scope, observer)
    observer.mockClear()

    await gateway.restored()

    expect(observer.mock.calls).toEqual([[{ kind: "lost", reason: "rebound" }]])
    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
    expect(resume).toHaveBeenCalledTimes(3)
  })

  it("resumes again on the next ensure after a heal it could not rebind", async () => {
    const gateway = fakeGateway()
    const resume = vi
      .fn<() => Promise<{ liveSessionId: string }>>()
      .mockResolvedValueOnce({ liveSessionId: "live-stored" })
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce({ liveSessionId: "live-healed" })
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport,
      { log: { warn: vi.fn() } }
    )
    const observer = vi.fn()
    await registry.subscribe(scope, observer)
    observer.mockClear()

    await gateway.restored()
    expect(observer).not.toHaveBeenCalled()

    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-healed",
    })
    expect(resume).toHaveBeenCalledTimes(3)
    expect(observer.mock.calls).toEqual([[{ kind: "lost", reason: "rebound" }]])
  })

  it("resumes again on the next ensure for a binding the heal skipped", async () => {
    const gateway = fakeGateway()
    const ids = ["live-first", "live-second"]
    const resume = vi.fn(async () => ({ liveSessionId: ids.shift()! }))
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    await registry.ensure(scope)

    // Nobody observes or retains this Session, so the heal leaves it alone.
    await gateway.restored()
    expect(resume).toHaveBeenCalledTimes(1)

    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it("signals a disconnected loss without clearing bindings", async () => {
    const gateway = fakeGateway()
    const resume = vi.fn(async () => ({ liveSessionId: "live-stored" }))
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    const observer = vi.fn()
    await registry.subscribe(scope, observer)
    observer.mockClear()

    gateway.lost()

    expect(observer.mock.calls).toEqual([
      [{ kind: "lost", reason: "disconnected" }],
    ])
    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-stored",
    })
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it("clears every binding and signals a restart loss when Hermes restarts", async () => {
    const gateway = fakeGateway()
    const resume = vi.fn(async (value: typeof scope) => ({
      liveSessionId: `live-${value.sessionId}`,
    }))
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    const second = { ...scope, sessionId: "other" }
    const first = vi.fn()
    const other = vi.fn()
    await registry.subscribe(scope, first)
    await registry.subscribe(second, other)
    first.mockClear()
    other.mockClear()

    gateway.epochChanged()

    expect(first.mock.calls).toEqual([[{ kind: "lost", reason: "restart" }]])
    expect(other.mock.calls).toEqual([[{ kind: "lost", reason: "restart" }]])
    await expect(
      registry.subscribeLive("live-stored", vi.fn())
    ).rejects.toThrow()
    await registry.ensure(scope)
    expect(resume).toHaveBeenCalledTimes(3)
  })

  it("joins an in-flight heal instead of handing out the replaced live Session", async () => {
    const gateway = fakeGateway()
    const ids = ["live-first", "live-second"]
    let releaseHeal: (() => void) | undefined
    const resume = vi.fn(async () => {
      const liveSessionId = ids.shift()!
      if (liveSessionId === "live-second")
        await new Promise<void>((resolve) => {
          releaseHeal = resolve
        })
      return { liveSessionId }
    })
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    await registry.subscribe(scope, vi.fn())

    const healed = gateway.restored()
    const during = registry.ensure(scope)
    releaseHeal?.()
    await healed

    await expect(during).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it("re-resumes after an explicit invalidation", async () => {
    const gateway = fakeGateway()
    const ids = ["live-first", "live-second"]
    const resume = vi.fn(async () => ({ liveSessionId: ids.shift()! }))
    const registry = new HermesAttachmentRegistry(
      { resume, close: async () => undefined },
      gateway.transport
    )
    await registry.ensure(scope)

    registry.invalidate("live-first")

    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it("closes only an idle exact native Session", async () => {
    vi.useFakeTimers()
    const gateway = fakeGateway()
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry(
      {
        resume: async (value) => ({ liveSessionId: `live-${value.sessionId}` }),
        close,
      },
      gateway.transport,
      { idleMs: 300_000 }
    )
    await registry.ensure(scope)
    await registry.ensure({ ...scope, sessionId: "other" })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(close).toHaveBeenCalledWith("live-stored")
    expect(close).toHaveBeenCalledWith("live-other")
    vi.useRealTimers()
  })

  it("does not idle-close while a retainer is held", async () => {
    vi.useFakeTimers()
    const gateway = fakeGateway()
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry(
      { resume: async () => ({ liveSessionId: "live-stored" }), close },
      gateway.transport,
      { idleMs: 300_000 }
    )
    const release = await registry.retain(scope, "active")
    await vi.advanceTimersByTimeAsync(300_000)
    expect(close).not.toHaveBeenCalled()
    release()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(close).toHaveBeenCalledWith("live-stored")
    vi.useRealTimers()
  })

  it("keeps a pending question attachment past its idle deadline", async () => {
    vi.useFakeTimers()
    const gateway = fakeGateway()
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry(
      { resume: async () => ({ liveSessionId: "live-stored" }), close },
      gateway.transport,
      { idleMs: 300_000 }
    )
    const answerOrExpiry = await registry.retain(scope, "interaction")

    await vi.advanceTimersByTimeAsync(600_000)
    expect(close).not.toHaveBeenCalled()

    answerOrExpiry()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(close).toHaveBeenCalledWith("live-stored")
    vi.useRealTimers()
  })

  it("keeps a running native Session past its idle deadline until it reports idle", async () => {
    vi.useFakeTimers()
    const gateway = fakeGateway()
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry(
      { resume: async () => ({ liveSessionId: "live-stored" }), close },
      gateway.transport,
      { idleMs: 300_000 }
    )
    await registry.ensure(scope)
    const turn = nativeTurn("live-stored")

    gateway.publish(turn.messageStart("msg-1"))
    await vi.advanceTimersByTimeAsync(450_000)
    expect(close).not.toHaveBeenCalled()

    gateway.publish(turn.idle())
    await vi.advanceTimersByTimeAsync(300_000)
    expect(close).toHaveBeenCalledWith("live-stored")
    vi.useRealTimers()
  })

  it("stops holding a running attachment Hermes never reports on again", async () => {
    vi.useFakeTimers()
    const gateway = fakeGateway()
    const close = vi.fn(async () => undefined)
    const ids = ["live-first", "live-second"]
    const resume = vi.fn(async () => ({ liveSessionId: ids.shift()! }))
    const registry = new HermesAttachmentRegistry(
      { resume, close },
      gateway.transport,
      { idleMs: 300_000 }
    )
    const release = await registry.retain(scope, "active")
    gateway.publish(nativeTurn("live-first").messageStart("msg-1"))
    release()

    await vi.advanceTimersByTimeAsync(600_000)

    expect(close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
    vi.useRealTimers()
  })

  it("registers no observer when a subscription cannot be retained", async () => {
    const gateway = fakeGateway()
    let resumes = 0
    const registry = new HermesAttachmentRegistry(
      {
        resume: async () => {
          resumes += 1
          if (resumes === 1) throw new HermesUnavailableError()
          return { liveSessionId: "live-stored" }
        },
        close: async () => undefined,
      },
      gateway.transport
    )
    const rejected = vi.fn()
    const observer = vi.fn()

    await expect(registry.subscribe(scope, rejected)).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
    await registry.subscribe(scope, observer)
    gateway.publish(nativeTurn("live-stored").messageStart("msg-1"))

    // The rejected subscriber got no unsubscribe handle, so it must never have
    // joined the entry the next binding signals.
    expect(rejected).not.toHaveBeenCalled()
    expect(observer).toHaveBeenCalledTimes(1)
    await registry.close()
  })

  it("shutdown detaches retained and running Sessions and closes only idle attachments", async () => {
    const gateway = fakeGateway()
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry(
      {
        resume: async (value) => ({ liveSessionId: `live-${value.sessionId}` }),
        close,
      },
      gateway.transport
    )
    const release = await registry.retain(scope, "waiting-for-input")
    await registry.ensure({ ...scope, sessionId: "running" })
    await registry.ensure({ ...scope, sessionId: "idle" })
    gateway.publish(nativeTurn("live-running").messageStart("msg-1"))

    await registry.close()

    expect(close).toHaveBeenCalledWith("live-idle")
    expect(close).not.toHaveBeenCalledWith("live-stored")
    expect(close).not.toHaveBeenCalledWith("live-running")
    release()
  })
})
