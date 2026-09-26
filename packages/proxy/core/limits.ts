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
