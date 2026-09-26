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
import { READING_BACKOFF, READING_RETRIES } from "./limits"
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
  logger: Logger
  clock: Clock
}

type ReadingSignal<C> =
  | { type: "read"; cause?: C }
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
 * in flight read again once it lands. A report restarts the budget.
 */
function readingMachine<T, C, S extends ReadingScope>(
  cell: CellState<T, C, S>,
  { read, logger, clock }: SessionReporterOptions<T, C, S>
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
              actions: () => defer(cell),
            },
            {
              // An unknown value is not an empty one: the last stays standing.
              target: "idle",
              actions: () => {
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
 * the last value standing: an unknown value is not an empty one.
 */
export class SessionReporter<
  T,
  C = void,
  S extends ReadingScope = SessionScope,
> {
  readonly #cells = new Map<string, Cell<T, C, S>>()

  constructor(private readonly options: SessionReporterOptions<T, C, S>) {}

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
    for (const cell of this.#cells.values()) cell.owner.dispose()
    this.#cells.clear()
  }

  /** Releases one cell by key, disposing its owner. */
  release(key: string) {
    const cell = this.#cells.get(key)
    if (!cell) return
    cell.owner.dispose()
    this.#cells.delete(key)
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
