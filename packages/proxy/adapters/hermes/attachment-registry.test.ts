import { describe, expect, it, vi } from "vitest"

import { HermesAttachmentRegistry } from "./attachment-registry"

const scope = { agentId: "research", sessionId: "stored", threadId: "thread" }

describe("HermesAttachmentRegistry", () => {
  it("single-flights session resume and routes events by live Session", async () => {
    let publish: ((event: unknown) => void) | undefined
    const resume = vi.fn(async (value: typeof scope) => ({
      liveSessionId: `live-${value.sessionId}`,
    }))
    const registry = new HermesAttachmentRegistry({
      resume,
      close: async () => undefined,
      observe: async (listener) => {
        publish = listener
        return () => undefined
      },
    })
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

    publish?.({
      session_id: firstAttachment.liveSessionId,
      type: "message.delta",
    })
    publish?.({ session_id: "live-other", type: "message.delta" })
    expect(resume).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
    stopFirst()
    stopOther()
  })

  it("closes only an idle exact native Session", async () => {
    vi.useFakeTimers()
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry({
      resume: async (value) => ({ liveSessionId: `live-${value.sessionId}` }),
      close,
      observe: async () => () => undefined,
      idleMs: 300_000,
    })
    await registry.ensure(scope)
    await registry.ensure({ ...scope, sessionId: "other" })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(close).toHaveBeenCalledWith("live-stored")
    expect(close).toHaveBeenCalledWith("live-other")
    vi.useRealTimers()
  })

  it("does not idle-close while a retainer is held", async () => {
    vi.useFakeTimers()
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry({
      resume: async () => ({ liveSessionId: "live-stored" }),
      close,
      observe: async () => () => undefined,
      idleMs: 300_000,
    })
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
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry({
      resume: async () => ({ liveSessionId: "live-stored" }),
      close,
      observe: async () => () => undefined,
      idleMs: 300_000,
    })
    const answerOrExpiry = await registry.retain(scope, "interaction")

    await vi.advanceTimersByTimeAsync(600_000)
    expect(close).not.toHaveBeenCalled()

    answerOrExpiry()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(close).toHaveBeenCalledWith("live-stored")
    vi.useRealTimers()
  })

  it("shutdown detaches retained Sessions and closes only idle attachments", async () => {
    const close = vi.fn(async () => undefined)
    const registry = new HermesAttachmentRegistry({
      resume: async (value) => ({ liveSessionId: `live-${value.sessionId}` }),
      close,
      observe: async () => () => undefined,
    })
    const release = await registry.retain(scope, "waiting-for-input")
    await registry.ensure({ ...scope, sessionId: "idle" })

    await registry.close()

    expect(close).toHaveBeenCalledWith("live-idle")
    expect(close).not.toHaveBeenCalledWith("live-stored")
    release()
  })
})
