import { describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../../test/support/fake-clock"
import {
  HermesAttachmentRegistry,
  HermesSessionGoneError,
  REBIND_BACKOFF,
  type AttachmentSignal,
} from "./attachment-registry"
import { HermesUnavailableError, type HermesConnectionHandler } from "./gateway"
import { nativeTurn } from "./test-utils/native-events"

const scope = {
  agentId: "research",
  providerSessionId: "stored",
  sessionId: "thread",
}

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
      subscribeEvents(listener: (event: unknown) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      subscribeConnection(handler: HermesConnectionHandler) {
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

type RegistryOptions = ConstructorParameters<typeof HermesAttachmentRegistry>[2]
type Resume = ConstructorParameters<
  typeof HermesAttachmentRegistry
>[0]["resume"]

/** A registry over a fresh fake gateway whose native close is recorded. */
function attach(resume: Resume, options?: RegistryOptions) {
  const gateway = fakeGateway()
  const close = vi.fn<(liveSessionId: string) => Promise<void>>(
    async () => undefined
  )
  const registry = new HermesAttachmentRegistry(
    { resume, close },
    gateway.transport,
    options
  )
  return { gateway, close, registry }
}

/** Always resumes the same live Session. */
const liveStored = () => vi.fn(async () => ({ liveSessionId: "live-stored" }))

/** Hands out the next live id on each resume. */
const inOrder = (...ids: string[]) =>
  vi.fn(async () => ({ liveSessionId: ids.shift()! }))

/** Derives the live id from the durable id; a `draft*` id is unsaved. */
const byScope = () =>
  vi.fn(async (value: typeof scope) => ({
    liveSessionId: `live-${value.providerSessionId}`,
    saved: !value.providerSessionId.startsWith("draft"),
  }))

describe("HermesAttachmentRegistry", () => {
  it("re-resumes a bound Session when a caller needs it reconciled", async () => {
    const resume = liveStored()
    const { registry } = attach(resume)

    await registry.ensure(scope)
    await registry.ensure(scope)
    expect(resume).toHaveBeenCalledTimes(1)

    await registry.ensure(scope, { refresh: true })
    expect(resume).toHaveBeenCalledTimes(2)

    // A refresh still joins an in-flight resume rather than issuing its own.
    const first = registry.ensure(scope, { refresh: true })
    const second = registry.ensure(scope, { refresh: true })
    await Promise.all([first, second])
    expect(resume).toHaveBeenCalledTimes(3)
    await registry.close()
  })

  it("reports the durable scope a bound live Session id belongs to", async () => {
    const { registry } = attach(byScope())

    expect(registry.scopeFor("live-stored")).toBeUndefined()
    await registry.ensure(scope)

    expect(registry.scopeFor("live-stored")).toEqual(scope)
    expect(registry.scopeFor("live-other")).toBeUndefined()

    registry.invalidate("live-stored")

    expect(registry.scopeFor("live-stored")).toBeUndefined()
    await registry.close()
  })

  it("single-flights session resume and routes events by live Session", async () => {
    const resume = byScope()
    const { gateway, registry } = attach(resume)
    const second = { ...scope, providerSessionId: "other" }
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
    const { gateway, registry } = attach(liveStored())
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
    const resume = liveStored()
    const { gateway, registry } = attach(resume)
    const observer = vi.fn()
    await registry.subscribe(scope, observer)
    observer.mockClear()

    await gateway.restored()

    expect(resume).toHaveBeenCalledTimes(2)
    expect(observer.mock.calls).toEqual([[{ kind: "reattached" }]])
  })

  it("remaps the routing table and signals a rebound loss when a heal returns a new live Session", async () => {
    const { gateway, registry } = attach(inOrder("live-first", "live-second"))
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

  it("drops a binding whose heal finds the durable Session gone", async () => {
    const resume = vi
      .fn<() => Promise<{ liveSessionId: string }>>()
      .mockResolvedValueOnce({ liveSessionId: "live-first" })
      .mockRejectedValueOnce(new HermesSessionGoneError())
      .mockResolvedValueOnce({ liveSessionId: "live-second" })
    const { gateway, registry } = attach(resume)
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

  it("retries a heal it could not rebind until the binding is rebound", async () => {
    const clock = useFakeClock()
    const resume = vi
      .fn<() => Promise<{ liveSessionId: string }>>()
      .mockResolvedValueOnce({ liveSessionId: "live-stored" })
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce({ liveSessionId: "live-healed" })
    const { gateway, registry } = attach(resume, { log: { warn: vi.fn() } })
    const observer = vi.fn()
    await registry.subscribe(scope, observer)
    observer.mockClear()

    await gateway.restored()
    expect(observer).not.toHaveBeenCalled()

    // The first retry fires within its full-jitter ceiling.
    await clock.advance(REBIND_BACKOFF.baseMs)
    expect(resume).toHaveBeenCalledTimes(3)
    expect(observer.mock.calls).toEqual([[{ kind: "lost", reason: "rebound" }]])

    // Rebound on this socket: the next caller takes the binding as it stands.
    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-healed",
    })
    expect(resume).toHaveBeenCalledTimes(3)
    await registry.close()
  })

  it("resumes again on the next ensure for a binding the heal skipped", async () => {
    const resume = inOrder("live-first", "live-second")
    const { gateway, registry } = attach(resume)
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
    const resume = liveStored()
    const { gateway, registry } = attach(resume)
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
    const resume = byScope()
    const { gateway, registry } = attach(resume)
    const second = { ...scope, providerSessionId: "other" }
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
    const { gateway, registry } = attach(resume)
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
    const resume = inOrder("live-first", "live-second")
    const { registry } = attach(resume)
    await registry.ensure(scope)

    registry.invalidate("live-first")

    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it("accepts a binding Hermes answered inside the caller's freshness window", async () => {
    const resume = liveStored()
    let clock = 1_000
    const { registry } = attach(resume, { now: () => clock })

    await registry.ensure(scope, { refresh: true, freshForMs: 3_000 })
    clock += 2_999
    await registry.ensure(scope, { refresh: true, freshForMs: 3_000 })
    expect(resume).toHaveBeenCalledTimes(1)

    clock += 1
    await registry.ensure(scope, { refresh: true, freshForMs: 3_000 })
    expect(resume).toHaveBeenCalledTimes(2)

    await registry.ensure(scope, { refresh: true })
    expect(resume).toHaveBeenCalledTimes(3)
  })

  it("closes only an idle exact native Session and drops an unsaved draft", async () => {
    const clock = useFakeClock()
    const resume = byScope()
    const { gateway, close, registry } = attach(resume, { idleMs: 300_000 })
    await registry.ensure(scope)
    await clock.advance(200_000)
    // Using the cached binding restarts its idle window rather than ending it.
    await registry.ensure(scope)
    await registry.ensure({ ...scope, providerSessionId: "other" })
    await registry.ensure({ ...scope, providerSessionId: "draft" })
    await registry.ensure({ ...scope, providerSessionId: "draft-sent" })
    // Hermes commits a turn before completing it, so the draft is now stored.
    gateway.publish(nativeTurn("live-draft-sent").complete("msg-1", "done"))
    await clock.advance(300_000)
    expect(close).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledWith("live-stored")
    expect(close).toHaveBeenCalledWith("live-other")
    expect(close).toHaveBeenCalledWith("live-draft-sent")
    // Closing a draft natively would delete it; it is only unbound.
    expect(close).not.toHaveBeenCalledWith("live-draft")
    await registry.ensure({ ...scope, providerSessionId: "draft" })
    expect(resume).toHaveBeenCalledTimes(5)
  })

  it.each([
    { held: "a retainer is held", reason: "active", heldForMs: 300_000 },
    {
      held: "a pending question waits past its idle deadline",
      reason: "interaction",
      heldForMs: 600_000,
    },
  ] as const)(
    "does not idle-close while $held",
    async ({ reason, heldForMs }) => {
      const clock = useFakeClock()
      const { close, registry } = attach(liveStored(), { idleMs: 300_000 })
      const release = await registry.retain(scope, reason)
      await clock.advance(heldForMs)
      expect(close).not.toHaveBeenCalled()
      release()
      await clock.advance(300_000)
      expect(close).toHaveBeenCalledWith("live-stored")
    }
  )

  it("keeps a running native Session past its idle deadline until it reports idle", async () => {
    const clock = useFakeClock()
    const { gateway, close, registry } = attach(liveStored(), {
      idleMs: 300_000,
    })
    await registry.ensure(scope)
    const turn = nativeTurn("live-stored")

    gateway.publish(turn.messageStart("msg-1"))
    await clock.advance(450_000)
    expect(close).not.toHaveBeenCalled()

    gateway.publish(turn.idle())
    await clock.advance(300_000)
    expect(close).toHaveBeenCalledWith("live-stored")
  })

  it("stops holding a running attachment Hermes never reports on again", async () => {
    const clock = useFakeClock()
    const { gateway, close, registry } = attach(
      inOrder("live-first", "live-second"),
      { idleMs: 300_000 }
    )
    const release = await registry.retain(scope, "active")
    gateway.publish(nativeTurn("live-first").messageStart("msg-1"))
    release()

    await clock.advance(600_000)

    expect(close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await expect(registry.ensure(scope)).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
  })

  it("keeps no record of a Session whose turns settled, however its binding ended", async () => {
    const clock = useFakeClock()
    const gateway = fakeGateway()
    const forget = vi.fn()
    const registry = new HermesAttachmentRegistry(
      {
        resume: async (value) => {
          if (value.providerSessionId === "refused")
            throw new HermesUnavailableError()
          return {
            liveSessionId: `live-${value.providerSessionId}`,
            saved: value.providerSessionId !== "draft",
          }
        },
        close: async () => undefined,
        forget,
      },
      gateway.transport,
      { idleMs: 1_000 }
    )
    const [stored, draft, restarted] = await Promise.all(
      ["stored", "draft", "restarted"].map((id) =>
        registry.subscribe({ ...scope, providerSessionId: id }, vi.fn())
      )
    )

    // Two turns settle and go idle: one is closed, the draft only unbound.
    stored!()
    draft!()
    await clock.advance(1_000)
    // Hermes restarts under a running turn, which then settles.
    gateway.epochChanged()
    restarted!()
    await expect(
      registry.ensure({ ...scope, providerSessionId: "refused" })
    ).rejects.toThrow(HermesUnavailableError)

    expect(registry.size).toBe(0)
    expect(
      forget.mock.calls.map(([value]) => value.providerSessionId).sort()
    ).toEqual(["draft", "refused", "restarted", "stored"])
  })

  it("registers no observer when a subscription cannot be retained", async () => {
    let resumes = 0
    const { gateway, registry } = attach(async () => {
      resumes += 1
      if (resumes === 1) throw new HermesUnavailableError()
      return { liveSessionId: "live-stored" }
    })
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

  it("shutdown detaches retained, running, and draft Sessions and closes only idle attachments", async () => {
    const { gateway, close, registry } = attach(byScope())
    const release = await registry.retain(scope, "waiting-for-input")
    await registry.ensure({ ...scope, providerSessionId: "running" })
    await registry.ensure({ ...scope, providerSessionId: "idle" })
    await registry.ensure({ ...scope, providerSessionId: "draft" })
    gateway.publish(nativeTurn("live-running").messageStart("msg-1"))

    await registry.close()

    expect(close).toHaveBeenCalledWith("live-idle")
    expect(close).not.toHaveBeenCalledWith("live-stored")
    expect(close).not.toHaveBeenCalledWith("live-running")
    expect(close).not.toHaveBeenCalledWith("live-draft")
    release()
  })
})
