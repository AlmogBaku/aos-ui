import type { SessionScope } from "./runtime"

/** Takes one reading. It never rejects: it reports its own delivery failure. */
export type ReadingListener<T> = (reading: T) => Promise<void>

type Reporting<T> = {
  scope: SessionScope
  listeners: Map<string, ReadingListener<T>>
  /** The subscribers the next reading is owed to. */
  owed: Set<string>
  /** Which report is live; a report a newer one replaced stops. */
  chain: number
  retry?: ReturnType<typeof setTimeout>
}

export type SessionReporterOptions<T, C> = {
  /** One reading of the Session, which throws while it is unreadable. */
  read(scope: SessionScope, cause: C): Promise<T>
  /** What an unreadable Session waits before each re-read, in order. */
  retryDelaysMs: readonly number[]
}

/**
 * One reading of each Session that its subscribers are owed once per change.
 * A report owes the reading to the subscribers it names, or to every one; a
 * later report replaces whatever the earlier one left deferred, so one Session
 * never has two readings in flight and nobody is sent the same change twice.
 *
 * A Session that stays unreadable leaves the last reading standing: an unknown
 * value is not an empty one, and the budget is bounded.
 */
export class SessionReporter<T, C = void> {
  readonly #sessions = new Map<string, Reporting<T>>()

  constructor(private readonly options: SessionReporterOptions<T, C>) {}

  /**
   * Adds one subscriber, which is owed nothing until a report names it. `key`
   * is the Session's, as its coordinator keys it.
   */
  subscribe(
    key: string,
    scope: SessionScope,
    id: string,
    listener: ReadingListener<T>
  ) {
    const reporting = this.#sessions.get(key) ?? {
      scope,
      listeners: new Map(),
      owed: new Set<string>(),
      chain: 0,
    }
    this.#sessions.set(key, reporting)
    reporting.listeners.set(id, listener)
    return () => {
      if (reporting.listeners.get(id) !== listener) return
      reporting.listeners.delete(id)
      reporting.owed.delete(id)
      if (reporting.owed.size === 0) this.#cancel(reporting)
      if (reporting.listeners.size === 0) this.#sessions.delete(key)
    }
  }

  /**
   * Owes the named subscribers, or every one, a fresh reading. Resolves once
   * the first attempt has delivered or deferred it.
   */
  async report(key: string, cause: C, ids?: Iterable<string>) {
    const reporting = this.#sessions.get(key)
    if (!reporting) return
    for (const id of ids ?? reporting.listeners.keys())
      if (reporting.listeners.has(id)) reporting.owed.add(id)
    if (reporting.owed.size === 0) return
    this.#cancel(reporting)
    await this.#attempt(reporting, reporting.chain, cause, 0)
  }

  async #attempt(
    reporting: Reporting<T>,
    chain: number,
    cause: C,
    attempt: number
  ) {
    const reading = await this.options
      .read(reporting.scope, cause)
      .then((value) => ({ value }))
      .catch(() => undefined)
    if (chain !== reporting.chain) return
    if (!reading) {
      this.#defer(reporting, chain, cause, attempt)
      return
    }
    const owed = [...reporting.owed].flatMap(
      (id) => reporting.listeners.get(id) ?? []
    )
    reporting.owed.clear()
    await Promise.all(owed.map((listener) => listener(reading.value)))
  }

  /** Defers one report's next attempt, while its budget lasts. */
  #defer(reporting: Reporting<T>, chain: number, cause: C, attempt: number) {
    const delay = this.options.retryDelaysMs[attempt]
    if (delay === undefined) {
      reporting.owed.clear()
      return
    }
    reporting.retry = setTimeout(() => {
      reporting.retry = undefined
      void this.#attempt(reporting, chain, cause, attempt + 1)
    }, delay)
  }

  /** Stops whatever report is live, deferred or in flight. */
  #cancel(reporting: Reporting<T>) {
    reporting.chain += 1
    clearTimeout(reporting.retry)
    reporting.retry = undefined
  }
}
