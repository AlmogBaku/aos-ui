import {
  backoffDelay,
  createOwner,
  fromAbortable,
  ownerSetup,
  type Clock,
  type Logger,
  type Owner,
  type OwnerContext,
} from "../../lifecycle"
import type { PublicFailure } from "./failures"
import { READING_BACKOFF, READING_RETRIES } from "./limits"
import type { RetryBudget, ServerLink } from "./link"
import type { SessionScope } from "./runtime"

/** Takes one reading. It never rejects: it reports its own delivery failure. */
export type ReadingListener<T> = (reading: T) => Promise<void>

/** What one cell reads. */
export type ReadingScope = { agentId: string; sessionId?: string }

export type SessionReporterOptions<T, C, S extends ReadingScope> = {
  /** Names the reading in its cells' log lines. */
  name: string
  /**
   * One reading, which throws while it is unreadable. `cause` is what the
   * latest report carried; a read a subscriber owes carries none.
   */
  read(scope: S, cause: C | undefined): Promise<T>
  /** The runtime's native link: a failed read is taken again once it is up. */
  link: ServerLink
  /** Bounds those at-once reads across every reporter that shares it. */
  budget: RetryBudget
  /** Sorts a failed read for its log line. */
  publicError(cause: unknown): PublicFailure | undefined
  logger: Logger
  clock: Clock
}

type ReadingSignal<C> =
  | { type: "read"; cause?: C }
  /** The link is up again: a failed read is taken again, with its cause. */
  | { type: "retry" }
  /** Nobody is owed the reading any more. */
  | { type: "stop" }

type CellState<T, C, S> = {
  scope: S
  listeners: Map<string, ReadingListener<T>>
  last?: { value: T }
  /** A change may have come since the last value, so a subscriber reads. */
  stale: boolean
  /** The subscribers the read in flight, or the deferred one, is owed to. */
  owed: Set<string>
  /** Owed the read after the one in flight, which began before their change. */
  next: Set<string>
  /** What the latest report carried, which every read until the next takes. */
  cause?: C
  /** Consecutive failed reads, which the backoff doubles on. */
  failures: number
  log: Logger
}

type AnyCell<T> = CellState<T, unknown, unknown>

/** Gives one subscriber a value; a delivery failure is logged, never thrown. */
function deliver<T>(cell: AnyCell<T>, id: string, value: T) {
  cell.listeners
    .get(id)?.(value)
    .catch((err: unknown) => cell.log.error({ err }, "reading.delivery.failed"))
}

/**
 * Stores what a read returned and gives it to everyone it was owed to; those
 * owed the next read become owed the one that follows.
 */
function land<T>(cell: AnyCell<T>, value: T) {
  cell.last = { value }
  cell.failures = 0
  const owed = [...cell.owed]
  cell.owed = cell.next
  cell.next = new Set()
  // Nobody reports the changes of a cell nobody subscribes to.
  cell.stale = cell.owed.size > 0 || cell.listeners.size === 0
  for (const id of owed) deliver(cell, id, value)
}

/** A failed read owes its re-read to everyone owed this one or the next. */
function defer<T>(cell: AnyCell<T>) {
  cell.failures += 1
  for (const id of cell.next) cell.owed.add(id)
  cell.next.clear()
}

/**
 * One cell's reads: at most one in flight, a failed one re-read on backoff
 * while someone is owed it and its budget lasts, and a report while one is
 * in flight read again once it lands. A report restarts the budget, and so
 * does a retry, which the shared budget lets through at once or sends to a
 * fresh backoff.
 */
function readingMachine<T, C, S extends ReadingScope>(
  cell: CellState<T, C, S>,
  { read, budget, publicError, logger, clock }: SessionReporterOptions<T, C, S>
) {
  const actors = { read: fromAbortable(() => read(cell.scope, cell.cause)) }
  const reading = ownerSetup<OwnerContext, ReadingSignal<C>, typeof actors>(
    "reading",
    logger,
    clock,
    actors
  ).extend({
    delays: { retry: () => backoffDelay(cell.failures - 1, READING_BACKOFF) },
  })
  const restart = (cause: C | undefined) => {
    cell.failures = 0
    cell.cause = cause
  }
  /** One line per failed read, with its kind and never its message. */
  const failed = (err: unknown) =>
    cell.log.warn(
      { kind: publicError(err)?.kind ?? "unclassified" },
      "reading.failed"
    )
  return reading.createMachine({
    context: { generation: 0 },
    initial: "idle",
    states: {
      idle: {
        on: {
          read: {
            target: "reading",
            actions: ({ event }) => restart(event.cause),
          },
          retry: [
            {
              guard: () => budget.take(),
              target: "reading",
              actions: () => restart(cell.cause),
            },
            {
              target: "backing-off",
              actions: () => {
                restart(cell.cause)
                defer(cell)
              },
            },
          ],
        },
      },
      reading: {
        invoke: {
          src: "read",
          onDone: [
            {
              guard: () => cell.next.size > 0,
              target: "reading",
              reenter: true,
              actions: ({ event }) => land(cell, event.output),
            },
            {
              target: "idle",
              actions: ({ event }) => land(cell, event.output),
            },
          ],
          onError: [
            {
              guard: () =>
                cell.failures < READING_RETRIES &&
                cell.owed.size + cell.next.size > 0,
              target: "backing-off",
              actions: ({ event }) => {
                failed(event.error)
                defer(cell)
              },
            },
            {
              // An unknown value is not an empty one: the last stays standing.
              target: "idle",
              actions: ({ event }) => {
                failed(event.error)
                cell.owed.clear()
                cell.next.clear()
              },
            },
          ],
        },
        on: {
          read: {
            actions: ({ event }) => {
              cell.cause = event.cause
            },
          },
        },
      },
      "backing-off": {
        after: { retry: "reading" },
        on: {
          read: {
            target: "reading",
            actions: ({ event }) => restart(event.cause),
          },
          retry: {
            guard: () => budget.take(),
            target: "reading",
            actions: () => restart(cell.cause),
          },
          stop: "idle",
        },
      },
    },
  })
}

type Cell<T, C, S extends ReadingScope> = CellState<T, C, S> & {
  owner: Owner<ReturnType<typeof readingMachine<T, C, S>>>
}

/**
 * One reading of each Session, kept as a replay-on-subscribe cell: a
 * subscriber gets the last value at once, and a fresh read too when the value
 * is stale or unknown. A report owes a fresh read to the subscribers it names,
 * or to every one. One cell never has two reads in flight: a report while one
 * is in flight reads again once it lands, and nobody is sent the same read
 * twice.
 *
 * An unreadable Session is re-read on backoff and, past its budget, leaves
 * the last value standing: an unknown value is not an empty one. Once the
 * runtime's link is up again, every read that failed is taken again at once.
 */
export class SessionReporter<
  T,
  C = void,
  S extends ReadingScope = SessionScope,
> {
  readonly #cells = new Map<string, Cell<T, C, S>>()
  readonly #unlink: () => void

  constructor(private readonly options: SessionReporterOptions<T, C, S>) {
    this.#unlink = options.link.subscribe((state) => {
      if (state === "ready") this.#retry()
    })
  }

  /**
   * Adds one subscriber, which gets the last value at once and a fresh read
   * when the cell is stale. `key` is the cell's, as its owner keys it.
   */
  subscribe(key: string, scope: S, id: string, listener: ReadingListener<T>) {
    const cell = this.#cell(key, scope)
    cell.listeners.set(id, listener)
    if (cell.last) deliver(cell, id, cell.last.value)
    if (cell.stale) {
      const state = cell.owner.actor.getSnapshot().value
      // A read in flight serves a subscriber, unless a change came since.
      const joins =
        state === "reading" && cell.next.size > 0 ? cell.next : cell.owed
      joins.add(id)
      // A cell backing off keeps its schedule.
      if (state === "idle") cell.owner.actor.send({ type: "read" })
    }
    return () => {
      if (cell.listeners.get(id) !== listener) return
      cell.listeners.delete(id)
      cell.owed.delete(id)
      cell.next.delete(id)
      if (cell.listeners.size === 0) cell.stale = true
      if (cell.owed.size + cell.next.size === 0)
        cell.owner.actor.send({ type: "stop" })
    }
  }

  /**
   * Owes the named subscribers, or every one, a fresh read: the value changed.
   * A deferred read is taken at once instead.
   */
  report(key: string, cause?: C, ids?: Iterable<string>) {
    const cell = this.#cells.get(key)
    if (!cell) return
    cell.stale = true
    const owed =
      cell.owner.actor.getSnapshot().value === "reading" ? cell.next : cell.owed
    let owes = false
    for (const id of ids ?? cell.listeners.keys())
      if (cell.listeners.has(id)) {
        owed.add(id)
        owes = true
      }
    if (owes) cell.owner.actor.send({ type: "read", cause })
  }

  close() {
    this.#unlink()
    for (const cell of this.#cells.values()) cell.owner.dispose()
    this.#cells.clear()
  }

  /** Releases one cell by key, disposing its owner, once no one listens. */
  release(key: string) {
    const cell = this.#cells.get(key)
    if (!cell || cell.listeners.size > 0) return
    cell.owner.dispose()
    this.#cells.delete(key)
  }

  /**
   * Takes every failed read again. One that ran out of re-reads is owed to
   * every subscriber, as it no longer knows whom it was owed to.
   */
  #retry() {
    for (const cell of this.#cells.values()) {
      if (cell.failures === 0 || cell.listeners.size === 0) continue
      if (cell.owner.actor.getSnapshot().value === "idle")
        for (const id of cell.listeners.keys()) cell.owed.add(id)
      cell.owner.actor.send({ type: "retry" })
    }
  }

  #cell(key: string, scope: S) {
    const known = this.#cells.get(key)
    if (known) return known
    const { name, logger, clock } = this.options
    const bindings = {
      reading: name,
      agentId: scope.agentId,
      ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
    }
    const state: CellState<T, C, S> = {
      scope,
      listeners: new Map(),
      stale: true,
      owed: new Set(),
      next: new Set(),
      failures: 0,
      log: logger.child(bindings),
    }
    const cell = Object.assign(state, {
      owner: createOwner(readingMachine(state, this.options), {
        logger,
        clock,
        bindings,
      }),
    })
    this.#cells.set(key, cell)
    return cell
  }
}
