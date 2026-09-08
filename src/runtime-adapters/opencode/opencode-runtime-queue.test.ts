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
})
