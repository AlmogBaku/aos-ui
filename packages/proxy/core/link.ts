import {
  backoffDelay,
  breaker,
  createOwner,
  fromAbortable,
  ownerSetup,
  type Clock,
  type LogFields,
  type Logger,
  type OwnerContext,
} from "../../lifecycle"
import type { PublicFailure } from "./failures"
import { LINK_BACKOFF, LINK_BREAKER } from "./limits"

export type LinkState = "ready" | "lost"

/** Whether a runtime's native link is up now, and each time that changes. */
export type ServerLink = {
  state(): LinkState
  subscribe(listener: (state: LinkState) => void): () => void
}

/** A link that is always up, for a runtime that owns none of its own. */
export const READY_LINK: ServerLink = {
  state: () => "ready",
  subscribe: () => () => {},
}

/**
 * The retries many owners may take at once, shared by all of them: a token
 * bucket of `burst` tokens that refills `perSecond`. An owner the budget
 * refuses keeps to its jittered backoff, so N owners do not retry in lockstep.
 */
export type RetryBudget = { take(): boolean }

export function retryBudget(
  { burst, perSecond }: { burst: number; perSecond: number },
  clock: Clock
): RetryBudget {
  let tokens = burst
  let since = clock.now()
  return {
    take() {
      const now = clock.now()
      tokens = Math.min(burst, tokens + ((now - since) / 1_000) * perSecond)
      since = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

export type LinkOptions = {
  /**
   * Brings the link up, resolving once it is up with what takes it down
   * again; `lost` hears it drop once it is up. Throws when it cannot come up.
   */
  dial(
    signal: AbortSignal,
    lost: (cause: unknown) => void
  ): Promise<(() => void) | void>
  /** Sorts a failure; one it cannot sort is unavailable. */
  publicError(cause: unknown): PublicFailure | undefined
  /** Hears a failure once per change of its kind, until the link is up. */
  onError?(cause: unknown): void
  /** A link this one rides on: when it turns ready, this one redials at once. */
  upstream?: ServerLink
  /** Bounds the at-once redials; the rest keep to their backoff. */
  budget?: RetryBudget
  logger: Logger
  clock: Clock
  bindings: LogFields
}

export type Link = ServerLink & { dispose(): void }

type LinkSignal =
  | { type: "lost"; cause: unknown }
  /** The upstream link turned ready. */
  | { type: "retry" }

/** Kinds a redial would meet again: the link stays down until its upstream. */
const ENDS: ReadonlySet<PublicFailure["kind"]> = new Set([
  "gone",
  "runtime_authentication_required",
])

/**
 * One native link, dialed until it is up and redialed on backoff with full
 * jitter whenever it fails or drops. A circuit breaker around the dials fails
 * them fast while they keep failing. A link that is gone or refused its
 * credentials stays lost until its upstream turns ready.
 */
export function createLink({
  dial,
  publicError,
  onError,
  upstream,
  budget,
  logger,
  clock,
  bindings,
}: LinkOptions): Link {
  const circuit = breaker(LINK_BREAKER)
  const log = logger.child(bindings)
  /** Failed dials and drops since the link was last up. */
  let failures = 0
  /** The failure kind last reported, until the link is up. */
  let reported: PublicFailure["kind"] | undefined
  let release: (() => void) | undefined
  const down = () => {
    const stop = release
    release = undefined
    stop?.()
  }
  const kindOf = (cause: unknown) => publicError(cause)?.kind ?? "unavailable"
  const ends = (cause: unknown) => ENDS.has(kindOf(cause))
  const failed = (cause: unknown) => {
    failures += 1
    const kind = kindOf(cause)
    if (kind === reported) return
    reported = kind
    log.warn({ kind }, "link.failed")
    onError?.(cause)
  }
  const takes = () => budget?.take() ?? true

  const actors = {
    dial: fromAbortable(async (signal, generation: number) => {
      const stop = await circuit.execute(
        () =>
          dial(signal, (cause) => {
            if (!owner.stale(generation))
              owner.actor.send({ type: "lost", cause })
          }),
        signal
      )
      // A dial that lands after its state exited is taken down at once.
      if (signal.aborted) stop?.()
      return stop
    }),
  }
  const link = ownerSetup<OwnerContext, LinkSignal, typeof actors>(
    "link",
    logger,
    clock,
    actors
  ).extend({
    delays: { redial: () => backoffDelay(failures - 1, LINK_BACKOFF) },
  })
  /** Where a failed dial or a drop leaves the link. */
  const settle = <E>(causeOf: (event: E) => unknown) => [
    {
      guard: ({ event }: { event: E }) => ends(causeOf(event)),
      target: "lost" as const,
      actions: ({ event }: { event: E }) => failed(causeOf(event)),
    },
    {
      target: "backing-off" as const,
      actions: ({ event }: { event: E }) => failed(causeOf(event)),
    },
  ]
  const machine = link.createMachine({
    context: { generation: 0 },
    initial: "connecting",
    states: {
      connecting: {
        entry: "bumpGeneration",
        invoke: {
          src: "dial",
          input: ({ context }) => context.generation,
          onDone: {
            target: "ready",
            actions: ({ event }) => {
              release = event.output ?? undefined
              failures = 0
              reported = undefined
            },
          },
          onError: settle(({ error }: { error: unknown }) => error),
        },
      },
      ready: {
        meta: { log: "info" },
        exit: down,
        on: { lost: settle(({ cause }: { cause: unknown }) => cause) },
      },
      "backing-off": {
        after: { redial: "connecting" },
        on: { retry: { guard: takes, target: "connecting" } },
      },
      lost: {
        meta: { log: "info" },
        on: {
          retry: [{ guard: takes, target: "connecting" }, "backing-off"],
        },
      },
    },
  })
  const owner = createOwner(machine, { logger, clock, bindings })
  owner.stack.defer(down)
  if (upstream)
    owner.stack.defer(
      upstream.subscribe((state) => {
        if (state === "ready") owner.actor.send({ type: "retry" })
      })
    )

  const listeners = new Set<(state: LinkState) => void>()
  let state: LinkState = "lost"
  owner.actor.subscribe((snapshot) => {
    const next = snapshot.value === "ready" ? "ready" : "lost"
    if (next === state) return
    state = next
    for (const listener of [...listeners]) listener(next)
  })
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => owner.dispose(),
  }
}
