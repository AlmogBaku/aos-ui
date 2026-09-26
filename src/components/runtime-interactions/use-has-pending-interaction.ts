import { useCallback, useSyncExternalStore } from "react"

import type { RuntimeInteractionAdapter } from "@/runtime-adapters/contracts"

const unsubscribed = () => () => {}

/**
 * Whether the selected Session is waiting on the operator, so the Thread can
 * gate the composer and its send affordances without knowing which runtime
 * raised the request.
 */
export function useHasPendingInteraction(
  interactions: RuntimeInteractionAdapter | undefined,
  sessionId: string | undefined
): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      interactions && sessionId
        ? interactions.subscribe(sessionId, listener)
        : unsubscribed(),
    [interactions, sessionId]
  )
  const getSnapshot = useCallback(
    () =>
      interactions !== undefined &&
      sessionId !== undefined &&
      interactions.getPending(sessionId) !== undefined,
    [interactions, sessionId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
