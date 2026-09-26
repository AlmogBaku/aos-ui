/**
 * The browser ACP client's deadlines and backoff. Each request tier outlasts
 * the proxy deadline its work waits on, so a slow but healthy proxy answers
 * before the browser gives the transport up.
 */

/** How long a socket has to open, and then to answer `initialize`. */
export const HANDSHAKE_DEADLINE_MS = 10_000

/**
 * How long a request waits for its reply before its transport counts as
 * stalled: short for reads and the other small requests, medium for a resume,
 * a config write and a steer, long for a prompt and a from-start resume.
 */
export const REQUEST_DEADLINE_MS = {
  short: 30_000,
  medium: 45_000,
  long: 90_000,
} as const

export type RequestTier = keyof typeof REQUEST_DEADLINE_MS

/** Doubling backoff before reopening a closed transport. */
export const RECONNECT_BACKOFF = { baseMs: 250, capMs: 5_000 }
