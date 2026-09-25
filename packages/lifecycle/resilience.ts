import {
  bulkhead,
  circuitBreaker,
  ConsecutiveBreaker,
  fullJitterGenerator,
  handleAll,
} from "cockatiel"

import { defaultClock, type Clock } from "./clock"
import { Deadline } from "./deadline"

/**
 * A cockatiel bulkhead running `limit` calls with `queue` more waiting. A call
 * past both rejects at once with `BulkheadRejectedError`; a waiting call
 * rejects with a `TimeoutError` after `waitMs` on the injected clock, or when
 * its `signal` aborts. The deadline bounds the wait, not the call. A waiter
 * that times out or aborts keeps its queue slot until a running call
 * finishes, so a new call can be rejected as full in the meantime.
 */
export function boundedQueue({
  limit,
  queue,
  waitMs,
  clock = defaultClock,
}: {
  limit: number
  queue: number
  waitMs: number
  clock?: Clock
}) {
  const policy = bulkhead(limit, queue)
  return {
    execute<T>(fn: () => PromiseLike<T> | T, signal?: AbortSignal) {
      const wait = new Deadline(waitMs, clock, signal)
      return wait.run((waiting) =>
        policy.execute(() => {
          wait.clear()
          return fn()
        }, waiting)
      )
    },
  }
}

/**
 * A cockatiel circuit breaker that opens after `failures` consecutive
 * failures and lets a trial call through `halfOpenAfterMs` later. cockatiel
 * times that wait on `Date.now()`, not the injected clock.
 */
export function breaker({
  failures,
  halfOpenAfterMs,
}: {
  failures: number
  halfOpenAfterMs: number
}) {
  return circuitBreaker(handleAll, {
    halfOpenAfter: halfOpenAfterMs,
    breaker: new ConsecutiveBreaker(failures),
  })
}

/** cockatiel's full-jitter delay for a 0-based retry `attempt`. */
export function backoffDelay(
  attempt: number,
  { baseMs, capMs }: { baseMs: number; capMs: number }
) {
  const [delay] = fullJitterGenerator(attempt, {
    initialDelay: baseMs,
    maxDelay: capMs,
    exponent: 2,
    generator: fullJitterGenerator,
  })
  return delay
}
