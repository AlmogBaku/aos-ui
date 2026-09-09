import type { AppendMessage } from "@assistant-ui/react"
import type { OpenCodeThreadControllerLike } from "@assistant-ui/react-opencode"
import { describe, expect, it, vi } from "vitest"

import { createOpenCodeSessionQueue } from "./opencode-runtime-queue"

const message = (text: string): AppendMessage => ({
  role: "user",
  createdAt: new Date(0),
  metadata: { custom: {} },
  parentId: null,
  sourceId: null,
  runConfig: undefined,
  content: [{ type: "text", text }],
})

function controller() {
  return {
    sendMessage: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  } as unknown as OpenCodeThreadControllerLike
}

describe("OpenCode Session queue", () => {
  it("holds new input while native is already idle", async () => {
    const native = controller()
    const sessionQueue = createOpenCodeSessionQueue(native, () => ({}))
    const release = sessionQueue.hold()
    sessionQueue.adapter.enqueue(message("during undo"))

    expect(native.sendMessage).not.toHaveBeenCalled()
    expect(sessionQueue.adapter.items).toHaveLength(1)
    release()
    await vi.waitFor(() =>
      expect(native.sendMessage).toHaveBeenCalledExactlyOnceWith(
        message("during undo"),
        {}
      )
    )
  })

  it("waits through native busy and pending-interaction states", async () => {
    const native = controller()
    const sessionQueue = createOpenCodeSessionQueue(native, () => ({}))

    sessionQueue.syncBlocked(true)
    sessionQueue.adapter.enqueue(message("after approval"))
    expect(native.sendMessage).not.toHaveBeenCalled()

    sessionQueue.syncBlocked(false)
    await vi.waitFor(() => expect(native.sendMessage).toHaveBeenCalledOnce())
  })

  it("parks on cancel and re-arms only on the next explicit send", async () => {
    const native = controller()
    const sessionQueue = createOpenCodeSessionQueue(native, () => ({}))

    sessionQueue.syncBlocked(true)
    sessionQueue.adapter.enqueue(message("parked"))
    await sessionQueue.cancel()
    sessionQueue.syncBlocked(false)

    expect(native.cancel).toHaveBeenCalledOnce()
    expect(native.sendMessage).not.toHaveBeenCalled()
    expect(sessionQueue.adapter.items).toHaveLength(1)

    sessionQueue.adapter.enqueue(message("explicit"))
    await vi.waitFor(() => expect(native.sendMessage).toHaveBeenCalledOnce())
    expect(native.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [expect.objectContaining({ text: "parked" })],
      }),
      {}
    )
  })

  it("holds queued input through native idle until an idempotent release", async () => {
    const native = controller()
    const sessionQueue = createOpenCodeSessionQueue(native, () => ({}))
    sessionQueue.syncBlocked(true)
    sessionQueue.adapter.enqueue(message("after undo"))

    const release = sessionQueue.hold()
    const releaseNested = sessionQueue.hold()
    sessionQueue.syncBlocked(false)
    expect(native.sendMessage).not.toHaveBeenCalled()
    expect(sessionQueue.adapter.items).toHaveLength(1)

    release()
    release()
    expect(native.sendMessage).not.toHaveBeenCalled()
    releaseNested()
    releaseNested()
    await vi.waitFor(() =>
      expect(native.sendMessage).toHaveBeenCalledExactlyOnceWith(
        message("after undo"),
        {}
      )
    )
  })

  it("preserves Stop's parked queue across nested holds and releases", async () => {
    const native = controller()
    const sessionQueue = createOpenCodeSessionQueue(native, () => ({}))
    sessionQueue.syncBlocked(true)
    sessionQueue.adapter.enqueue(message("parked before edit"))
    await sessionQueue.cancel()
    sessionQueue.syncBlocked(false)

    const releaseFirst = sessionQueue.hold()
    const releaseSecond = sessionQueue.hold()
    sessionQueue.syncBlocked(false)
    releaseFirst()
    releaseFirst()
    releaseSecond()
    releaseSecond()

    expect(native.sendMessage).not.toHaveBeenCalled()
    expect(sessionQueue.adapter.items).toHaveLength(1)
    sessionQueue.adapter.enqueue(message("explicit send"))
    await vi.waitFor(() => expect(native.sendMessage).toHaveBeenCalled())
    expect(native.sendMessage).toHaveBeenNthCalledWith(
      1,
      message("parked before edit"),
      {}
    )
  })

  it.each(["enqueue", "steer"] as const)(
    "an explicit %s re-arms a parked queue only after the hold releases",
    async (action) => {
      const native = controller()
      const sessionQueue = createOpenCodeSessionQueue(native, () => ({}))
      sessionQueue.syncBlocked(true)
      sessionQueue.adapter.enqueue(message("parked"))
      await sessionQueue.cancel()
      sessionQueue.syncBlocked(false)

      const release = sessionQueue.hold()
      sessionQueue.adapter[action](message("explicit"))
      expect(native.sendMessage).not.toHaveBeenCalled()
      release()
      await vi.waitFor(() =>
        expect(native.sendMessage).toHaveBeenCalledTimes(2)
      )
      expect(native.sendMessage).toHaveBeenNthCalledWith(
        1,
        message(action === "enqueue" ? "parked" : "explicit"),
        {}
      )
      expect(sessionQueue.adapter.items).toHaveLength(0)
      expect(sessionQueue.adapter.steerItems).toHaveLength(0)
    }
  )
})
