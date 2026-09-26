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
 * How long a join may take to land before its membership detaches; the same
 * as the admission deadline.
 */
export const JOIN_DEADLINE_MS = 30_000

/** How long a member that fell behind keeps its place for its view to rejoin. */
export const PAUSED_DEADLINE_MS = 30_000
