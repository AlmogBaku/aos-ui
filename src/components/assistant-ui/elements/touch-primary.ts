import { useSyncExternalStore } from "react"

/**
 * Touch is the only pointer the device offers, so a hover action bar is out of
 * reach and a long press is the way in. CSS cannot read this constant, so the
 * `touch-primary` variant in `src/app/globals.css` and the Session row action
 * slot in `src/components/workspace/agent-session-history.module.css` repeat
 * the same query; change them together.
 */
const TOUCH_PRIMARY_QUERY = "(pointer: coarse) and (not (any-pointer: fine))"

function touchPrimarySnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(TOUCH_PRIMARY_QUERY).matches
  )
}

function subscribeToTouchPrimary(change: () => void): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => undefined
  }
  const query = window.matchMedia(TOUCH_PRIMARY_QUERY)
  query.addEventListener("change", change)
  return () => query.removeEventListener("change", change)
}

export function useTouchPrimaryInput(): boolean {
  return useSyncExternalStore(
    subscribeToTouchPrimary,
    touchPrimarySnapshot,
    () => false
  )
}
