/**
 * Bounded reconnect pacing for the normalized run stream. The browser cannot
 * import proxy code, so the schedule (full jitter over an exponential ceiling)
 * is duplicated here deliberately and kept small.
 */
export const RECONNECT_MAX_ATTEMPTS = 6
export const RECONNECT_BASE_DELAY_MS = 300
export const RECONNECT_MAX_DELAY_MS = 15_000

/**
 * A stream that delivered events redials at once; every consecutive
 * unproductive attempt waits inside a wider jitter window.
 */
export function reconnectDelayMs(
  failures: number,
  random: () => number = Math.random
) {
  if (failures <= 0) return 0
  const ceiling = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** (failures - 1)
  )
  return Math.floor(ceiling * random())
}

/**
 * The journal behind a run stream can no longer serve the cursor that stream
 * holds. Unlike a recoverable interrupt, redialing with the same cursor can
 * never succeed, so this code is deliberately not recoverable: the browser first
 * reloads authoritative history and only then reads the run from its beginning.
 */
export const RESET_REQUIRED_CODE = "AOS_RESET_REQUIRED"

export const RECONNECT_EXHAUSTED_CODE = "AOS_RECONNECT_EXHAUSTED"
export const RECONNECT_EXHAUSTED_MESSAGE =
  "This run stream could not be reconnected."

/**
 * Normalized failures that a reconnect with the same run id can reconcile. The
 * proxy needs that redial to reattach, so they are never a message failure.
 */
const RECOVERABLE_RUN_ERROR_CODES = new Set([
  "AOS_CONNECTION_INTERRUPTED",
  "AOS_SEND_UNCERTAIN",
  "AOS_INTERACTION_UNCERTAIN",
])

export function isRecoverableRunError(code: unknown) {
  return typeof code === "string" && RECOVERABLE_RUN_ERROR_CODES.has(code)
}

/** Resolves localized copy for a normalized run error code. */
export type RunErrorResolver = (
  code: string | undefined,
  fallback: string
) => string

/** Waits out a backoff window, returning early when the caller aborts. */
export function reconnectDelay(ms: number, signal?: AbortSignal | null) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const settle = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", settle)
      resolve()
    }
    const timer = setTimeout(settle, ms)
    signal?.addEventListener("abort", settle, { once: true })
  })
}
