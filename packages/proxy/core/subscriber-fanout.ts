type Waiter<T> = {
  resolve(result: IteratorResult<T>): void
  reject(cause: unknown): void
}

export type FanoutSubscription<T> = {
  readonly events: AsyncIterable<T>
  readonly closed: boolean
  close(): void
}

/**
 * A subscriber the fanout dropped because it fell behind its own bounds. Its
 * iterator rejects with this rather than reporting the end a closed source
 * reports: a consumer that cannot tell the two apart treats every missed event
 * as a stream that finished normally.
 */
export class FanoutOverflowError extends Error {
  constructor(
    /** The backlog the dropped subscriber held: its events, and their bytes. */
    readonly events: number,
    readonly bytes: number
  ) {
    super("Subscriber queue overflowed")
    this.name = "FanoutOverflowError"
  }
}

export type SubscriberFanoutOptions<T> = {
  maxEvents: number
  maxBytes: number
  sizeOf(value: T): number
}

type Subscriber<T> = {
  values: Array<{ value: T; bytes: number }>
  bytes: number
  waiters: Waiter<T>[]
  closed: boolean
  /** Set when the queue overflowed, which is the one unclean end. */
  failure?: FanoutOverflowError
  onDetach?(): void
}

/** One source stream with an independent bounded queue for each subscriber. */
export class SubscriberFanout<T> {
  readonly #subscribers = new Set<Subscriber<T>>()
  #closed = false

  constructor(private readonly options: SubscriberFanoutOptions<T>) {
    if (
      !Number.isSafeInteger(options.maxEvents) ||
      options.maxEvents < 1 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1
    )
      throw new Error("Invalid subscriber bounds")
  }

  get size() {
    return this.#subscribers.size
  }

  subscribe(onDetach?: () => void): FanoutSubscription<T> {
    const subscriber: Subscriber<T> = {
      values: [],
      bytes: 0,
      waiters: [],
      closed: false,
      ...(onDetach ? { onDetach } : {}),
    }
    if (this.#closed) subscriber.closed = true
    else this.#subscribers.add(subscriber)

    const close = () => this.#detach(subscriber)
    const events: AsyncIterable<T> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const next = subscriber.values.shift()
          if (next) {
            subscriber.bytes -= next.bytes
            return Promise.resolve({ done: false, value: next.value })
          }
          if (subscriber.failure) return Promise.reject(subscriber.failure)
          if (subscriber.closed)
            return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve, reject) =>
            subscriber.waiters.push({ resolve, reject })
          )
        },
        return: async () => {
          close()
          return { done: true, value: undefined }
        },
      }),
    }
    return {
      events,
      get closed() {
        return subscriber.closed
      },
      close,
    }
  }

  publish(value: T) {
    if (this.#closed) return
    for (const subscriber of [...this.#subscribers]) {
      let bytes: number
      try {
        bytes = this.options.sizeOf(value)
      } catch {
        this.#detach(subscriber)
        continue
      }
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > this.options.maxBytes ||
        subscriber.values.length >= this.options.maxEvents ||
        subscriber.bytes + bytes > this.options.maxBytes
      ) {
        this.#detach(
          subscriber,
          new FanoutOverflowError(subscriber.values.length, subscriber.bytes)
        )
        continue
      }
      const waiter = subscriber.waiters.shift()
      if (waiter) waiter.resolve({ done: false, value })
      else {
        subscriber.values.push({ value, bytes })
        subscriber.bytes += bytes
      }
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const subscriber of [...this.#subscribers]) this.#finish(subscriber)
  }

  #finish(subscriber: Subscriber<T>) {
    if (subscriber.closed) return
    subscriber.closed = true
    this.#subscribers.delete(subscriber)
    for (const waiter of subscriber.waiters.splice(0))
      waiter.resolve({ done: true, value: undefined })
    subscriber.onDetach?.()
  }

  /** Abandons one subscriber's queue: cleanly, or reporting an overflow. */
  #detach(subscriber: Subscriber<T>, overflow?: FanoutOverflowError) {
    if (subscriber.closed) return
    subscriber.closed = true
    this.#subscribers.delete(subscriber)
    subscriber.values.splice(0)
    subscriber.bytes = 0
    if (overflow) subscriber.failure = overflow
    for (const waiter of subscriber.waiters.splice(0))
      if (overflow) waiter.reject(overflow)
      else waiter.resolve({ done: true, value: undefined })
    subscriber.onDetach?.()
  }
}
