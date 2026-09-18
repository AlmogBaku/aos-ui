/**
 * The bounded AG-UI event stream one run publishes.
 *
 * A consumer that stops reading must not be able to grow the queue without
 * bound, and a terminal event must always be deliverable: reaching the bound is
 * therefore refused at the push, and a terminal event replaces whatever is
 * still queued behind the run's own RUN_STARTED.
 */
import { EventType, type AGUIEvent } from "@ag-ui/core"

import type { SessionScope } from "../../core/runtime"
import { boundedNativeBytes } from "./native"

const MAX_QUEUED_EVENTS = 4_096
const MAX_QUEUED_BYTES = 4_194_304

type QueueWaiter = {
  resolve(result: IteratorResult<AGUIEvent>): void
}

export class EventQueue implements AsyncIterable<AGUIEvent> {
  readonly #values: { event: AGUIEvent; bytes: number }[] = []
  readonly #waiters: QueueWaiter[] = []
  #bytes = 0
  #closed = false

  push(value: AGUIEvent) {
    if (this.#closed) return false
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else {
      if (this.#values.length >= MAX_QUEUED_EVENTS) return false
      const bytes = boundedNativeBytes(value, MAX_QUEUED_BYTES - this.#bytes)
      if (bytes === undefined) return false
      this.#values.push({ event: value, bytes })
      this.#bytes += bytes
    }
    return true
  }

  terminal(value: AGUIEvent) {
    if (this.#closed) return
    const started =
      this.#values[0]?.event.type === EventType.RUN_STARTED
        ? this.#values[0]
        : undefined
    this.#values.splice(0, this.#values.length)
    this.#bytes = 0
    if (started) {
      this.#values.push(started)
      this.#bytes += started.bytes
    }
    const terminalBytes = boundedNativeBytes(
      value,
      MAX_QUEUED_BYTES - this.#bytes
    )
    if (terminalBytes !== undefined) {
      this.#values.push({ event: value, bytes: terminalBytes })
      this.#bytes += terminalBytes
    }
    // A reader parked in its own `next()` is served before the queue reports
    // done: closing first would end the stream with no terminal event at all.
    while (this.#waiters.length > 0 && this.#values.length > 0) {
      const waiter = this.#waiters.shift()!
      const entry = this.#values.shift()!
      this.#bytes -= entry.bytes
      waiter.resolve({ done: false, value: entry.event })
    }
    this.close()
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AGUIEvent> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value) {
          this.#bytes -= value.bytes
          return Promise.resolve({ done: false, value: value.event })
        }
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.#waiters.push({ resolve }))
      },
    }
  }
}

/** Every run's stream opens with its own RUN_STARTED. */
export function startedQueue(scope: SessionScope, runId: string) {
  const queue = new EventQueue()
  queue.push({
    type: EventType.RUN_STARTED,
    threadId: scope.threadId,
    runId,
  })
  return queue
}
