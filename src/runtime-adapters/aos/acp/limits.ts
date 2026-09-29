/**
 * The browser ACP client's deadlines and backoff. Each request tier outlasts
 * the proxy deadline its work waits on, so a slow but healthy proxy answers
 * before the browser gives the transport up.
 */

/** How long a socket has to open, and then to answer `initialize`. */
export const HANDSHAKE_DEADLINE_MS = 10_000

/**
 * How long a request waits for its reply before it fails and its transport
 * is checked in with a liveness probe: short for reads and the other small requests, medium for a resume,
 * a config write and a steer, long for a prompt and a from-start resume.
 * The `probe` tier is the liveness probe deadline; focus uses it.
 */
export const REQUEST_DEADLINE_MS = {
  short: 45_000,
  medium: 45_000,
  long: 90_000,
  probe: 20_000,
} as const

export type RequestTier = keyof typeof REQUEST_DEADLINE_MS

/** How long an inbound stream may be silent while visible before a liveness probe is sent. */
export const LIVENESS_SILENCE_MS = 20_000

/** Full-jitter backoff before reopening a closed transport. */
export const RECONNECT_BACKOFF = { baseMs: 250, capMs: 5_000 }

/** A transport up this long starts the backoff over, rejoined or not. */
export const STABLE_AFTER_MS = 60_000

/**
 * How long an opened Session outlives its last listener before it parts, so
 * an unsubscribe a resubscribe follows at once, as Strict Mode does, costs
 * neither a close nor a resume.
 */
export const PART_GRACE_MS = 2_000

/** The window a reopen waits in after the proxy closes at capacity. */
export const CAPACITY_BACKOFF = { minMs: 30_000, maxMs: 60_000 }
