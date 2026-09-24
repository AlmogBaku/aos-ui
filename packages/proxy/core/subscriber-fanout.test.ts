import { describe, expect, it, vi } from "vitest"

import { FanoutOverflowError, SubscriberFanout } from "./subscriber-fanout"

async function next<T>(events: AsyncIterable<T>) {
  return events[Symbol.asyncIterator]().next()
}

describe("SubscriberFanout", () => {
  it("delivers one source event independently to every subscriber", async () => {
    const fanout = new SubscriberFanout<string>({
      maxEvents: 4,
      maxBytes: 64,
      sizeOf: (value) => value.length,
    })
    const first = fanout.subscribe()
    const second = fanout.subscribe()

    fanout.publish("one")
    fanout.publish("two")

    await expect(next(first.events)).resolves.toEqual({
      done: false,
      value: "one",
    })
    await expect(next(second.events)).resolves.toEqual({
      done: false,
      value: "one",
    })
  })

  it("detaches only a subscriber whose bounded queue overflows", async () => {
    const detached = vi.fn()
    const fanout = new SubscriberFanout<string>({
      maxEvents: 1,
      maxBytes: 64,
      sizeOf: (value) => value.length,
    })
    const slow = fanout.subscribe(detached)
    const fast = fanout.subscribe()

    fanout.publish("one")
    await expect(next(fast.events)).resolves.toEqual({
      done: false,
      value: "one",
    })
    fanout.publish("two")

    expect(detached).toHaveBeenCalledOnce()
    expect(slow.closed).toBe(true)
    expect(fanout.size).toBe(1)
    // The dropped subscriber missed "two", so its stream fails rather than
    // reporting the end a closed source reports.
    const overflow = await next(slow.events).catch((cause: unknown) => cause)
    expect(overflow).toBeInstanceOf(FanoutOverflowError)
    expect(overflow).toMatchObject({ events: 1, bytes: 3 })
    await expect(next(fast.events)).resolves.toEqual({
      done: false,
      value: "two",
    })
  })

  it("fails a waiting consumer when one event alone exceeds its bytes", async () => {
    const fanout = new SubscriberFanout<string>({
      maxEvents: 4,
      maxBytes: 8,
      sizeOf: (value) => value.length,
    })
    const subscriber = fanout.subscribe()
    const waiting = next(subscriber.events)

    fanout.publish("longer than eight bytes")

    await expect(waiting).rejects.toBeInstanceOf(FanoutOverflowError)
    expect(fanout.size).toBe(0)
  })

  it("ends a stream cleanly when the subscriber or the source closes it", async () => {
    const fanout = new SubscriberFanout<string>({
      maxEvents: 2,
      maxBytes: 64,
      sizeOf: (value) => value.length,
    })
    const first = fanout.subscribe()
    const second = fanout.subscribe()

    first.close()
    fanout.close()

    await expect(next(first.events)).resolves.toEqual({
      done: true,
      value: undefined,
    })
    await expect(next(second.events)).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it("closing one subscriber leaves every other subscriber attached", async () => {
    const fanout = new SubscriberFanout<string>({
      maxEvents: 2,
      maxBytes: 64,
      sizeOf: (value) => value.length,
    })
    const first = fanout.subscribe()
    const second = fanout.subscribe()

    first.close()
    fanout.publish("still-running")

    expect(fanout.size).toBe(1)
    await expect(next(second.events)).resolves.toEqual({
      done: false,
      value: "still-running",
    })
  })
})
