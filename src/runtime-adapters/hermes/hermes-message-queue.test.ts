import type { AppendMessage } from "@assistant-ui/react"
import { describe, expect, it, vi } from "vitest"

import { createHermesMessageQueue } from "./hermes-message-queue"

const message = (text: string): AppendMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  attachments: [],
  metadata: { custom: {} },
  createdAt: new Date(0),
  parentId: null,
  sourceId: null,
  runConfig: undefined,
})

describe("Hermes message queue", () => {
  it("parks dispatch when an idle Session becomes unobservable", () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const queue = createHermesMessageQueue({ submit }, "thread-1")
    queue.sync({ running: false, status: "idle" } as never)
    queue.sync({ running: false, status: "unknown" } as never)
    queue.controller.adapter.enqueue(message("wait for native status"))
    expect(submit).not.toHaveBeenCalled()
    queue.sync({ running: false, status: "idle" } as never)
    expect(submit).toHaveBeenCalledOnce()
  })
  it("parks later prompts after an uncertain native submit failure", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("outcome uncertain"))
    const onError = vi.fn()
    const queue = createHermesMessageQueue({ submit }, "thread-1", onError)

    queue.controller.adapter.enqueue(message("first"))
    queue.controller.adapter.enqueue(message("second"))
    queue.sync({ running: false, status: "idle" } as never)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    queue.sync({ running: false, status: "unknown" } as never)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(queue.controller.adapter.items).toHaveLength(1)
  })

  it("does not dispatch from initial unknown or pending-approval state", () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const queue = createHermesMessageQueue({ submit }, "thread-1")
    queue.controller.adapter.enqueue(message("parked"))
    queue.sync({ running: false, status: "unknown" } as never)
    queue.sync({
      running: false,
      status: "idle",
      approval: { requestId: "approval-1" },
    } as never)
    expect(submit).not.toHaveBeenCalled()
    expect(queue.controller.adapter.items).toHaveLength(1)

    queue.sync({ running: false, status: "idle" } as never)
    expect(submit).toHaveBeenCalledOnce()
    expect(queue.controller.adapter.items).toHaveLength(0)
  })

  it("does not dispatch while a clarification is pending", () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const queue = createHermesMessageQueue({ submit }, "thread-1")
    queue.controller.adapter.enqueue(message("parked"))
    queue.sync({
      running: false,
      status: "idle",
      clarification: { requestId: "clarify-1" },
    } as never)
    expect(submit).not.toHaveBeenCalled()

    queue.sync({ running: false, status: "idle" } as never)
    expect(submit).toHaveBeenCalledOnce()
  })
})
