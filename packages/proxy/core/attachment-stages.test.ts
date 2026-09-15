import { afterEach, describe, expect, it, vi } from "vitest"

import { AttachmentStageRegistry } from "./attachment-stages"
import type { ServerAttachmentStage } from "./runtime"

function stage(cleanup = vi.fn(async () => undefined)): ServerAttachmentStage {
  return { public: [], appendTo: (text) => text, cleanup }
}

describe("AttachmentStageRegistry", () => {
  afterEach(() => vi.useRealTimers())

  it("bounds retained bytes and outstanding stages per Session", () => {
    const registry = new AttachmentStageRegistry(10, 300_000, 10, 2)

    expect(registry.create("agent", "one", stage(), 4)).toBeDefined()
    expect(registry.create("agent", "one", stage(), 4)).toBeDefined()
    expect(registry.create("agent", "one", stage(), 1)).toBeUndefined()
    expect(registry.create("agent", "two", stage(), 3)).toBeUndefined()
    expect(registry.create("agent", "two", stage(), 2)).toBeDefined()
  })

  it("expires and cleans unused stages while preserving one-shot consumption", async () => {
    vi.useFakeTimers()
    const expiredCleanup = vi.fn(async () => undefined)
    const takenCleanup = vi.fn(async () => undefined)
    const registry = new AttachmentStageRegistry(2, 1_000, 10, 2)
    const expired = registry.create("agent", "session", stage(expiredCleanup), 5)
    const taken = registry.create("agent", "session", stage(takenCleanup), 5)

    expect(registry.take("agent", "session", taken!)).toBeDefined()
    expect(registry.take("agent", "session", taken!)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(registry.take("agent", "session", expired!)).toBeUndefined()
    expect(expiredCleanup).toHaveBeenCalledOnce()
    expect(takenCleanup).not.toHaveBeenCalled()
    expect(registry.create("agent", "session", stage(), 10)).toBeDefined()
  })
})
