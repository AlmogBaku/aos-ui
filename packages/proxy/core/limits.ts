/**
 * The backoff an unreadable reading re-reads on, with full jitter: a cold
 * Session's provider is usually still building its agent.
 */
export const READING_BACKOFF = { baseMs: 1_000, capMs: 16_000 }

/**
 * Re-reads before a reading leaves its last value standing. The budget is
 * bounded: a provider that has not built its agent within half a minute is
 * not building one, and the next change owes a reading anyway.
 */
export const READING_RETRIES = 5

/**
 * The retries at once that owners sharing one budget may take, a burst and a
 * refill each second; past it they keep to their backoff.
 */
export const RETRY_BUDGET = { burst: 32, perSecond: 16 }

/** The backoff a native link redials on, with full jitter. */
export const LINK_BACKOFF = { baseMs: 250, capMs: 5_000 }

/**
 * The consecutive failed dials that open a native link's circuit, and how
 * long it stays open before one trial dial.
 */
export const LINK_BREAKER = { failures: 5, halfOpenAfterMs: 10_000 }

/**
 * The admissions a client may repeat under its client id, sends and creates
 * each: how many are remembered, and for how long. A repeat after either is
 * admitted afresh.
 */
export const CLIENT_ADMISSIONS = { entries: 1_000, ttlMs: 10 * 60_000 }

/**
 * How long an admission (a start, recover or discover) waits on its runtime
 * call: past it, a start's turn is uncertain and a read is unavailable. It
 * sits above the adapter's own deadline and below the browser's.
 */
export const ADMISSION_DEADLINE_MS = 30_000

/**
 * How long a turn stays uncertain without a recover confirming it running,
 * before it ends with its outcome unknown. A reconcile in flight at the
 * deadline runs out its admission deadline first, so the bound is up to one
 * ADMISSION_DEADLINE_MS longer.
 */
export const UNCERTAINTY_DEADLINE_MS = 5 * 60_000

/** The backoff an uncertain turn asks its provider again on, with full jitter. */
export const RECONCILE_BACKOFF = { baseMs: 1_000, capMs: 30_000 }

/**
 * How long a join may take to land before its membership detaches; the same
 * as the admission deadline.
 */
export const JOIN_DEADLINE_MS = ADMISSION_DEADLINE_MS

/** How long a member that fell behind keeps its place for its view to rejoin. */
export const PAUSED_DEADLINE_MS = 30_000

/**
 * How long a peer may take to send its first `initialize` before the proxy
 * closes the connection; code 4408.
 */
export const HANDSHAKE_DEADLINE_MS = 15_000

/**
 * How long one native call an adapter makes may take, from its credential
 * read on, and one dial: the innermost deadline, well inside the admission
 * deadline.
 */
export const ADAPTER_CALL_MS = 15_000
