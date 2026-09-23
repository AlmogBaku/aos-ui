import { TurnEventKind, type TurnEvent } from "../../core/events"
import { describe, expect, it } from "vitest"

import { EventQueue, startedTurnQueue } from "./event-queue"

async function drain(queue: EventQueue) {
  const events: TurnEvent[] = []
  for await (const event of queue) events.push(event)
  return events
}

describe("the bounded turn event queue", () => {
  it("opens the stream with the run's own TurnStarted", async () => {
    const queue = startedTurnQueue()
    queue.close()

    expect(await drain(queue)).toEqual([{ kind: TurnEventKind.TurnStarted }])
  })

  it("keeps TurnStarted and drops queued events when a terminal event arrives", async () => {
    const queue = startedTurnQueue()
    queue.push({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "partial",
    })

    queue.terminal({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes could not complete this run.",
      code: "AOS_PROVIDER_RUN_FAILED",
    })

    expect(await drain(queue)).toEqual([
      { kind: TurnEventKind.TurnStarted },
      {
        kind: TurnEventKind.TurnFailed,
        message: "Hermes could not complete this run.",
        code: "AOS_PROVIDER_RUN_FAILED",
      },
    ])
  })

  it("refuses an event past its byte bound and still delivers a terminal event", async () => {
    const queue = startedTurnQueue()

    const accepted = queue.push({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "x".repeat(4_194_305),
    })
    queue.terminal({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })

    expect(accepted).toBe(false)
    expect((await drain(queue)).at(-1)).toEqual({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })
  })

  it("publishes nothing more once it is closed", async () => {
    const queue = new EventQueue()
    queue.close()

    expect(queue.push({ kind: TurnEventKind.TurnStarted })).toBe(false)
    expect(await drain(queue)).toEqual([])
  })

  it("hands a parked reader the terminal event before it reports done", async () => {
    const queue = startedTurnQueue()
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: TurnEventKind.TurnStarted },
    })
    const parked = iterator.next()

    queue.terminal({
      kind: TurnEventKind.TurnFailed,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })

    await expect(parked).resolves.toEqual({
      done: false,
      value: {
        kind: TurnEventKind.TurnFailed,
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

    queue.push({ kind: TurnEventKind.TurnStarted })

    expect(await pending).toEqual({
      done: false,
      value: { kind: TurnEventKind.TurnStarted },
    })
  })
})
