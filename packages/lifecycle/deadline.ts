import { defaultClock, type Clock } from "./clock"

/**
 * A signal that aborts `ms` from now on the injected clock, or as soon as
 * `parent` aborts. The timer is cleared once the deadline aborts, clears or
 * is disposed, so nothing outlives the call it bounds.
 */
export class Deadline implements Disposable {
  readonly #controller = new AbortController()
  readonly signal = this.#controller.signal
  readonly #clock: Clock
  readonly #parent: AbortSignal | undefined
  readonly #timer: unknown
  readonly #onParentAbort = () => this.#abort(this.#parent!.reason)

  constructor(ms: number, clock: Clock = defaultClock, parent?: AbortSignal) {
    this.#clock = clock
    this.#parent = parent
    this.#timer = clock.setTimeout(
      () => this.#abort(new DOMException("Deadline passed", "TimeoutError")),
      ms
    )
    parent?.addEventListener("abort", this.#onParentAbort, { once: true })
    if (parent?.aborted) this.#onParentAbort()
  }

  #abort(reason: unknown) {
    this.clear()
    this.#controller.abort(reason)
  }

  /** Stop the clock without aborting. */
  clear() {
    this.#clock.clearTimeout(this.#timer)
    this.#parent?.removeEventListener("abort", this.#onParentAbort)
  }

  [Symbol.dispose]() {
    this.clear()
  }

  /**
   * Settle with `work`, or reject with the abort reason the moment the
   * signal aborts, discarding any later result; the deadline clears either way.
   */
  run<T>(work: (signal: AbortSignal) => PromiseLike<T> | T) {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason)
      if (this.signal.aborted) return onAbort()
      this.signal.addEventListener("abort", onAbort, { once: true })
      Promise.resolve()
        .then(() => work(this.signal))
        .then(resolve, reject)
        .finally(() => {
          this.signal.removeEventListener("abort", onAbort)
          this.clear()
        })
    })
  }
}
