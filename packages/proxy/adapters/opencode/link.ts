import type { Clock, Logger } from "../../../lifecycle"
import {
  createLink,
  type LinkOptions,
  type LinkState,
  type ServerLink,
} from "../../core/link"
import { openCodeFailure } from "./failures"

type WatchOptions = Pick<LinkOptions, "dial" | "onError" | "bindings">

/**
 * OpenCode's link, as its Sessions' event-stream watches meet it. Each watch
 * is one core link: redialed on backoff behind a breaker, and stopped once its
 * Session is gone or OpenCode refuses the password. The link is lost while
 * any watch is down, from its first failure until it is up again; a gone
 * Session says nothing of OpenCode, so its watch does not count.
 */
export class OpenCodeLink implements ServerLink {
  readonly #down = new Set<object>()
  readonly #stops = new Set<() => void>()
  readonly #listeners = new Set<(state: LinkState) => void>()
  #closed = false

  constructor(
    private readonly options: Readonly<{ logger: Logger; clock: Clock }>
  ) {}

  state(): LinkState {
    return this.#down.size > 0 ? "lost" : "ready"
  }

  subscribe(listener: (state: LinkState) => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Keeps one watch up until the returned stop, which may run more than once. */
  watch({ dial, onError, bindings }: WatchOptions) {
    if (this.#closed) return () => {}
    const watch = {}
    /** A drop the link heard before it took the dial, which it hears once up. */
    let held: (() => void) | undefined
    const link = createLink({
      dial: (signal, lost) =>
        dial(signal, (cause) => {
          if (link.state() === "ready") lost(cause)
          else held = () => lost(cause)
        }),
      publicError: openCodeFailure,
      onError: (cause) => {
        this.#mark(watch, openCodeFailure(cause)?.kind !== "gone")
        onError?.(cause)
      },
      logger: this.options.logger,
      clock: this.options.clock,
      bindings,
    })
    const unsubscribe = link.subscribe((state) => {
      if (state !== "ready") return
      this.#mark(watch, false)
      const drop = held
      held = undefined
      drop?.()
    })
    const stop = () => {
      if (!this.#stops.delete(stop)) return
      unsubscribe()
      link.dispose()
      this.#mark(watch, false)
    }
    this.#stops.add(stop)
    return stop
  }

  /** Stops every watch, so none of them dials again. */
  close() {
    this.#closed = true
    for (const stop of [...this.#stops]) stop()
  }

  #mark(watch: object, down: boolean) {
    const before = this.state()
    if (down) this.#down.add(watch)
    else this.#down.delete(watch)
    const after = this.state()
    if (after === before) return
    for (const listener of [...this.#listeners]) listener(after)
  }
}
