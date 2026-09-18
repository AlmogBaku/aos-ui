import { EventType, type AGUIEvent } from "@ag-ui/core"
import { describe, expect, it } from "vitest"

import { EventQueue, startedQueue } from "./event-queue"

const scope = {
  agentId: "research",
  sessionId: "stored-session",
  threadId: "hermes:research:stored-session",
}

async function drain(queue: EventQueue) {
  const events: AGUIEvent[] = []
  for await (const event of queue) events.push(event)
  return events
}

describe("the bounded run event queue", () => {
  it("opens the stream with the run's own RUN_STARTED", async () => {
    const queue = startedQueue(scope, "run-1")
    queue.close()

    expect(await drain(queue)).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
    ])
  })

  it("keeps RUN_STARTED and drops queued events when a terminal event arrives", async () => {
    const queue = startedQueue(scope, "run-1")
    queue.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "partial",
    })

    queue.terminal({
      type: EventType.RUN_ERROR,
      message: "Hermes could not complete this run.",
      code: "AOS_PROVIDER_RUN_FAILED",
    })

    expect(await drain(queue)).toEqual([
      { type: EventType.RUN_STARTED, threadId: scope.threadId, runId: "run-1" },
      {
        type: EventType.RUN_ERROR,
        message: "Hermes could not complete this run.",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("refuses an event past its byte bound and still delivers a terminal event", async () => {
    const queue = startedQueue(scope, "run-1")

    const accepted = queue.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "x".repeat(4_194_305),
    })
    queue.terminal({
      type: EventType.RUN_ERROR,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })

    expect(accepted).toBe(false)
    expect((await drain(queue)).at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })
  })

  it("publishes nothing more once it is closed", async () => {
    const queue = new EventQueue()
    queue.close()

    expect(
      queue.push({
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      })
    ).toBe(false)
    expect(await drain(queue)).toEqual([])
  })

  it("hands a parked reader the terminal event before it reports done", async () => {
    const queue = startedQueue(scope, "run-1")
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: EventType.RUN_STARTED },
    })
    const parked = iterator.next()

    queue.terminal({
      type: EventType.RUN_ERROR,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })

    await expect(parked).resolves.toEqual({
      done: false,
      value: {
        type: EventType.RUN_ERROR,
        message: "Hermes produced more events than AOS can safely buffer.",
        code: "AOS_STREAM_OVERFLOW",
      },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it("hands a pending reader the next event without queueing it", async () => {
    const queue = new EventQueue()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()

    queue.push({
      type: EventType.RUN_STARTED,
      threadId: scope.threadId,
      runId: "run-1",
    })

    expect(await pending).toEqual({
      done: false,
      value: {
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: "run-1",
      },
    })
  })
})
