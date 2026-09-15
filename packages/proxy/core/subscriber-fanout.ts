type Waiter<T> = (result: IteratorResult<T>) => void

export type FanoutSubscription<T> = {
  readonly events: AsyncIterable<T>
  readonly closed: boolean
  close(): void
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
  project(value: T): T | undefined
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

  subscribe(
    project: ((value: T) => T | undefined) | undefined = undefined,
    onDetach?: () => void
  ): FanoutSubscription<T> {
    const subscriber: Subscriber<T> = {
      values: [],
      bytes: 0,
      waiters: [],
      closed: false,
      project: project ?? ((value) => value),
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
          if (subscriber.closed)
            return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => subscriber.waiters.push(resolve))
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
      let projected: T | undefined
      let bytes: number
      try {
        projected = subscriber.project(value)
        if (projected === undefined) continue
        bytes = this.options.sizeOf(projected)
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
        this.#detach(subscriber)
        continue
      }
      const waiter = subscriber.waiters.shift()
      if (waiter) waiter({ done: false, value: projected })
      else {
        subscriber.values.push({ value: projected, bytes })
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
      waiter({ done: true, value: undefined })
    subscriber.onDetach?.()
  }

  #detach(subscriber: Subscriber<T>) {
    if (subscriber.closed) return
    subscriber.closed = true
    this.#subscribers.delete(subscriber)
    subscriber.values.splice(0)
    subscriber.bytes = 0
    for (const waiter of subscriber.waiters.splice(0))
      waiter({ done: true, value: undefined })
    subscriber.onDetach?.()
  }
}
