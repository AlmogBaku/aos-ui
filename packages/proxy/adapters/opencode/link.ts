import type { Clock, Logger } from "../../../lifecycle"
import {
  createLink,
  type Link,
  type LinkOptions,
  type LinkState,
  type ServerLink,
} from "../../core/link"
import { OpenCodeClientError } from "./client"
import { openCodeFailure } from "./failures"

type WatchOptions = Pick<LinkOptions, "dial" | "onError" | "bindings">

/**
 * A core link that keeps a drop it hears before it takes the dial, which core
 * would miss, and hears it once up, after `onReady`.
 */
function holdingLink(options: LinkOptions, onReady?: () => void): Link {
  let held: (() => void) | undefined
  const link = createLink({
    ...options,
    dial: (signal, lost) =>
      options.dial(signal, (cause) => {
        if (link.state() === "ready") lost(cause)
        else held = () => lost(cause)
      }),
  })
  link.subscribe((state) => {
    if (state !== "ready") return
    onReady?.()
    const drop = held
    held = undefined
    drop?.()
  })
  return link
}

/**
 * OpenCode's link, as its Sessions' event-stream watches meet it. Each watch
 * is one core link: redialed on backoff behind a breaker, and stopped once its
 * Session is gone or OpenCode refuses the password. A refused watch rides on
 * the credential, which is down while OpenCode refuses the password as it
 * reads now, so the watch redials once the password changes. The link is lost
 * while any watch is down, from its first failure until it is up again; a
 * gone Session says nothing of OpenCode, so its watch does not count.
 */
export class OpenCodeLink implements ServerLink {
  readonly #down = new Set<object>()
  readonly #stops = new Set<() => void>()
  readonly #listeners = new Set<(state: LinkState) => void>()
  readonly #credential: Link
  /** Takes the credential down, from its latest dial on. */
  #refuse: ((cause: unknown) => void) | undefined
  #closed = false

  constructor(
    private readonly options: Readonly<{
      logger: Logger
      clock: Clock
      credentialRefused: () => Promise<boolean>
    }>
  ) {
    this.#credential = holdingLink({
      dial: async (_signal, lost) => {
        // Before the check, so a refusal heard during it is not missed.
        this.#refuse = lost
        if (await options.credentialRefused())
          throw new OpenCodeClientError("authentication")
        return () => {
          this.#refuse = undefined
        }
      },
      // A refused password is waited out on backoff, never an end.
      publicError: () => undefined,
      logger: options.logger,
      clock: options.clock,
      bindings: { link: "credential" },
    })
  }

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
    const link = holdingLink(
      {
        dial: async (signal, lost) => {
          try {
            return await dial(signal, (cause) => {
              this.#heard(cause)
              lost(cause)
            })
          } catch (error) {
            this.#heard(error)
            throw error
          }
        },
        publicError: openCodeFailure,
        onError: (cause) => {
          this.#mark(watch, openCodeFailure(cause)?.kind !== "gone")
          onError?.(cause)
        },
        upstream: this.#credential,
        logger: this.options.logger,
        clock: this.options.clock,
        bindings,
      },
      () => this.#mark(watch, false)
    )
    const stop = () => {
      if (!this.#stops.delete(stop)) return
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
    this.#credential.dispose()
  }

  /** Takes the credential down on each failure that says OpenCode refused it. */
  #heard(cause: unknown) {
    if (openCodeFailure(cause)?.kind === "runtime_authentication_required")
      this.#refuse?.(cause)
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
