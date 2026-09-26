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
 * before it ends with its outcome unknown.
 */
export const UNCERTAINTY_DEADLINE_MS = 5 * 60_000

/** The backoff an uncertain turn asks its provider again on, with full jitter. */
export const RECONCILE_BACKOFF = { baseMs: 1_000, capMs: 30_000 }
