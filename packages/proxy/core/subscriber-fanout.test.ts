import { describe, expect, it, vi } from "vitest"

import { SubscriberFanout } from "./subscriber-fanout"

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

  it("projects an event before it enters a subscriber queue", async () => {
    const order: string[] = []
    const fanout = new SubscriberFanout<string>({
      maxEvents: 1,
      maxBytes: 4,
      sizeOf: (value) => {
        order.push(`size:${value}`)
        return value.length
      },
    })
    const guest = fanout.subscribe((value) => {
      order.push(`project:${value}`)
      return value === "private-value" ? "safe" : undefined
    })

    fanout.publish("private-value")

    await expect(next(guest.events)).resolves.toEqual({
      done: false,
      value: "safe",
    })
    expect(order).toEqual(["project:private-value", "size:safe"])
  })

  it("detaches only a subscriber whose bounded queue overflows", async () => {
    const detached = vi.fn()
    const fanout = new SubscriberFanout<string>({
      maxEvents: 1,
      maxBytes: 64,
      sizeOf: (value) => value.length,
    })
    const slow = fanout.subscribe(undefined, detached)
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
    await expect(next(fast.events)).resolves.toEqual({
      done: false,
      value: "two",
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
