/**
 * Refusals Hermes lifts by itself within moments. Each one is issued before the
 * refused call changes anything, so repeating the same call is safe; AOS
 * retries it on a short bounded schedule and reports nothing unless the refusal
 * outlasts that schedule, when the caller treats it as an outage.
 */
import { HermesRpcRejectedError } from "./gateway"

/** When to try again, and how to wait; injectable so tests need no clock. */
export type HermesRetrySchedule = {
  readonly delaysMs: readonly number[]
  wait(ms: number): Promise<void>
}

/** A few attempts over about four seconds, Hermes' own settle window. */
export const DEFAULT_RETRY_SCHEDULE: HermesRetrySchedule = {
  delaysMs: [250, 500, 1_000, 2_000],
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// `_reattach_refusal` (tui_gateway/session_lifecycle.py) is the only 4009 that
// carries no reason, so its exact text is what tells it from a turn still busy.
const DISCONNECT_SETTLING = "session disconnect interrupt settling"
/** `hermes_cli.active_sessions`: the ownership registry could not be read. */
const COORDINATION_UNAVAILABLE = "SESSION_COORDINATION_UNAVAILABLE"

/** Hermes refused for a moment only: the same call succeeds once it settles. */
export function isTransientRejection(error: unknown) {
  return (
    error instanceof HermesRpcRejectedError &&
    ((error.code === 4009 && error.nativeMessage === DISCONNECT_SETTLING) ||
      (error.code === 4090 && error.reason === COORDINATION_UNAVAILABLE))
  )
}

/**
 * Run `call`, repeating it after each scheduled delay while Hermes answers with
 * a transient refusal. The last refusal is rethrown once the schedule is spent.
 */
export async function retryTransient<T>(
  call: () => Promise<T>,
  schedule: HermesRetrySchedule
): Promise<T> {
  for (const delayMs of schedule.delaysMs) {
    try {
      return await call()
    } catch (error) {
      if (!isTransientRejection(error)) throw error
    }
    await schedule.wait(delayMs)
  }
  return call()
}
